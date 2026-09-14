//! M7 文件监听（设计 §13.3）：`notify` 递归监听根目录；事件 300ms 合并去重；
//! 稳定窗 200ms×2（最多 3s，未稳→暂存稍后重试，**不判删除**）；
//! 自身写入经 `(path, committedHash)` 注册表识别（非时间窗），命中仍发给前端
//! 复核索引是否已提交；overflow → 独立事件触发全量核对。
//!
//! Watcher 只是线索（§13.3 L885）：真正的核对由启动枚举、前台节流、60s 目录
//! 检查与 10 分钟滚动 hash 校验（audit 命令 + TS 编排）共同完成。
//!
//! 事件经 Tauri emit 推给前端：`fs-changed` {paths:[{rel,hash,dir,own}]}、
//! `fs-overflow`。本模块不做任何数据库/索引动作。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::event::{EventKind, ModifyKind};
use notify::{Config as NotifyConfig, Event, RecommendedWatcher, RecursiveMode, Watcher as _};
use sha2::{Digest, Sha256};

use crate::persistence::paths::RECALLMD_DIR;

const MERGE_WINDOW_MS: u64 = 300;
const STABLE_INTERVAL_MS: u64 = 200;
const STABLE_MAX_MS: u64 = 3_000;
/// 未达稳定的路径暂存后再次尝试的间隔
const RETRY_PARK_MS: u64 = 2_000;
/// 暂存队列上限（风暴保护；超限丢弃最旧——随后有 10 分钟滚动校验兜底）
const PARK_CAP: usize = 512;
const INTERNAL_REGISTRY_CAP: usize = 256;
const INTERNAL_REGISTRY_TTL_MS: u64 = 10 * 60_000;

// ---------------------------------------------------------------------------
// 自写注册表（§13.3 L883：(path, committedHash)，匹配条件必须是 hash 相等）
// ---------------------------------------------------------------------------

struct InternalWrite {
    committed_hash: String,
    at_ms: i64,
}

static INTERNAL_WRITES: Mutex<Option<HashMap<String, InternalWrite>>> = Mutex::new(None);

/// 保存成功后登记（document.rs / repair.rs 调用）
pub fn record_internal_write(relative_path: &str, committed_hash: &str) {
    let mut guard = INTERNAL_WRITES.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    let now = crate::persistence::store::now_ms();
    // 顺带清理过期
    map.retain(|_, v| ((now - v.at_ms) as u64) < INTERNAL_REGISTRY_TTL_MS);
    if map.len() >= INTERNAL_REGISTRY_CAP && !map.contains_key(relative_path) {
        if let Some(oldest) = map
            .iter()
            .min_by_key(|(_, v)| v.at_ms)
            .map(|(k, _)| k.clone())
        {
            map.remove(&oldest);
        }
    }
    map.insert(
        relative_path.to_string(),
        InternalWrite {
            committed_hash: committed_hash.to_string(),
            at_ms: now,
        },
    );
}

fn is_own_write(relative: &str, hash: Option<&str>) -> bool {
    let guard = INTERNAL_WRITES.lock().unwrap();
    match (guard.as_ref().and_then(|m| m.get(relative)), hash) {
        (Some(rec), Some(h)) => rec.committed_hash == h,
        // 删除类事件（无 hash）：仅路径匹配不够，不算自写
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// 路径过滤（§13.3 L867：排除 .recallmd/.git/node_modules 与应用临时文件）
// ---------------------------------------------------------------------------

fn is_excluded(abs: &Path, root: &Path) -> bool {
    let rel = match abs.strip_prefix(root) {
        Ok(r) => r,
        Err(_) => return true,
    };
    for comp in rel.components() {
        match comp.as_os_str().to_str().unwrap_or("") {
            ".recallmd" | ".git" | "node_modules" => return true,
            _ => {}
        }
    }
    // 自身保存临时文件 `.<name>.recallmd-tmp-<op>`（document.rs L357）
    if let Some(name) = rel.file_name().and_then(|n| n.to_str()) {
        if name.starts_with('.') && name.contains(".recallmd-tmp-") {
            return true;
        }
    }
    false
}

fn is_supported_md(abs: &Path) -> bool {
    abs.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("md")).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Watcher 主体
// ---------------------------------------------------------------------------

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangedPath {
    /// `/` 相对路径（与 registry 一致）
    pub rel: String,
    /// 当前内容 SHA-256（文件消失时为 null）
    pub hash: Option<String>,
    pub size: Option<u64>,
    pub mtime_ms: Option<i64>,
    /// 命中自写注册表（hash 相等；前端仍须复核索引已提交）
    pub own: bool,
    /// 目录事件（触发目录级核对而非单文件重扫）
    pub dir: bool,
}

struct WatcherHandle {
    /// 关停信号（true = 停止）
    stop: Arc<AtomicU64>,
    thread: Option<std::thread::JoinHandle<()>>,
    _watcher: Option<RecommendedWatcher>,
}

/// 全局唯一实例（工作区打开时启动、关闭时停止）
static WATCHER: Mutex<Option<WatcherHandle>> = Mutex::new(None);

/// 启动监听（重复调用先停旧）。`emit` 由调用方注入（Tauri AppHandle 或测试收集器）。
pub fn start<E>(root: PathBuf, emit: E)
where
    E: Fn(&str, &FsChangedPath) + Send + Sync + 'static,
{
    stop();
    let stop = Arc::new(AtomicU64::new(0));
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();
    #[allow(clippy::let_unit_value)]
    let _ = NotifyConfig::default();
    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(_) => return,
    };
    // 先建线程再 watch：事件在 watch 生效前不会来，线程等在 recv 上
    let stop_for_thread = Arc::clone(&stop);
    let root_for_thread = root.clone();
    let emit = Arc::new(emit);
    let thread = std::thread::Builder::new()
        .name("recallmd-watcher".into())
        .spawn(move || {
            event_loop(&root_for_thread, &rx, &stop_for_thread, &*emit);
        });
    if watcher
        .watch(&root, RecursiveMode::Recursive)
        .is_err()
    {
        stop.store(1, Ordering::SeqCst);
        return;
    }
    *WATCHER.lock().unwrap() = Some(WatcherHandle {
        stop,
        thread: thread.ok(),
        _watcher: Some(watcher),
    });
}

pub fn stop() {
    if let Some(mut handle) = WATCHER.lock().unwrap().take() {
        handle.stop.store(1, Ordering::SeqCst);
        // watcher drop 停止事件；线程在 ≤ 合并窗+稳定窗内自然退出
        handle._watcher.take();
        if let Some(t) = handle.thread {
            let _ = t.join();
        }
    }
}

pub fn is_running() -> bool {
    WATCHER.lock().unwrap().is_some()
}

fn event_loop<E>(
    root: &Path,
    rx: &Receiver<notify::Result<Event>>,
    stop: &AtomicU64,
    emit: &E,
) where
    E: Fn(&str, &FsChangedPath),
{
    let mut parked: Vec<PathBuf> = Vec::new();
    let mut parked_at = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) != 0 {
            return;
        }
        // 等第一个事件（或暂存重试时刻）
        let next_retry = if parked.is_empty() {
            Duration::from_secs(1)
        } else {
            let due = parked_at + Duration::from_millis(RETRY_PARK_MS);
            if due > Instant::now() {
                due - Instant::now()
            } else {
                Duration::from_millis(1)
            }
        };
        match rx.recv_timeout(next_retry.min(Duration::from_secs(1))) {
            Ok(Ok(event)) => {
                let mut overflow = event.need_rescan();
                let mut batch: Vec<PathBuf> = Vec::new();
                collect_paths(&event, root, &mut batch);
                // 合并窗：300ms 内的后续事件并入本批
                let deadline = Instant::now() + Duration::from_millis(MERGE_WINDOW_MS);
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    let next = match rx.recv_timeout(remaining.max(Duration::from_millis(1))) {
                        Ok(Ok(e)) => e,
                        Ok(Err(_)) => continue,
                        Err(_) => break,
                    };
                    if next.need_rescan() {
                        overflow = true;
                    }
                    collect_paths(&next, root, &mut batch);
                }
                if overflow {
                    // overflow：无法保证事件完整 → 请求全量核对（§13.3 L885）
                    emit("fs-overflow", &FsChangedPath {
                        rel: String::new(),
                        hash: None,
                        size: None,
                        mtime_ms: None,
                        own: false,
                        dir: false,
                    });
                }
                if !batch.is_empty() {
                    process_batch(root, batch, &mut parked, emit);
                }
            }
            Ok(Err(_)) => {
                // watcher 层错误（如自身停止）：静默，停止信号兜底
            }
            Err(RecvTimeoutError::Timeout) => {
                if !parked.is_empty() && parked_at.elapsed() >= Duration::from_millis(RETRY_PARK_MS) {
                    let retry = std::mem::take(&mut parked);
                    parked_at = Instant::now();
                    process_batch(root, retry, &mut parked, emit);
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if !parked.is_empty() {
            parked_at = Instant::now();
        }
    }
}

fn collect_paths(event: &Event, root: &Path, out: &mut Vec<PathBuf>) {
    let interested = match event.kind {
        EventKind::Create(_) | EventKind::Modify(ModifyKind::Any | ModifyKind::Data(_) | ModifyKind::Name(_)) | EventKind::Remove(_) => true,
        _ => false,
    };
    if !interested {
        return;
    }
    for p in &event.paths {
        if is_excluded(p, root) {
            continue;
        }
        if !out.contains(p) {
            out.push(p.clone());
        }
    }
}

fn process_batch<E>(root: &Path, batch: Vec<PathBuf>, parked: &mut Vec<PathBuf>, emit: &E)
where
    E: Fn(&str, &FsChangedPath),
{
    for abs in batch {
        if parked.len() >= PARK_CAP {
            parked.remove(0);
        }
        let meta = std::fs::metadata(&abs);
        let rel = abs
            .strip_prefix(root)
            .unwrap_or(abs.as_path())
            .to_string_lossy()
            .replace('\\', "/");
        match meta {
            Ok(m) if m.is_dir() => {
                // 目录事件：交给前端做目录级核对（枚举比较）
                emit("fs-changed", &FsChangedPath {
                    rel,
                    hash: None,
                    size: None,
                    mtime_ms: None,
                    own: false,
                    dir: true,
                });
            }
            Ok(_m) if is_supported_md(&abs) => {
                match stable_read(&abs) {
                    Some((stat, hash)) => {
                        let own = is_own_write(&rel, hash.as_deref());
                        emit("fs-changed", &FsChangedPath {
                            rel,
                            hash,
                            size: Some(stat.len),
                            mtime_ms: Some(stat.modified),
                            own,
                            dir: false,
                        });
                    }
                    // 未稳定（3s 内仍在写）→ 暂存稍后重试，不下结论（§13.3 L867）
                    None => parked.push(abs),
                }
            }
            // 非 .md 资源：MVP 无资源缓存，忽略（§13.3 L867 图片资源只更新缓存）
            Ok(_) => {}
            Err(_) => {
                // 消失或不可读：只作线索发路径（无 hash）；由前端安静窗核对后定论
                emit("fs-changed", &FsChangedPath {
                    rel,
                    hash: None,
                    size: None,
                    mtime_ms: None,
                    own: false,
                    dir: false,
                });
            }
        }
    }
}

/// 稳定读取：两个间隔 200ms 的样本 size+mtime 一致才读 hash；
/// 3s 未稳 → 返回 None 由调用方暂存重试（§13.3 L867 不把超时当删除）。
fn stable_read(abs: &Path) -> Option<(FileStat, Option<String>)> {
    #[derive(Clone, Copy, PartialEq)]
    struct Sample {
        len: u64,
        mtime_ms: i64,
    }
    let sample = |m: &std::fs::Metadata| -> Sample {
        Sample {
            len: m.len(),
            mtime_ms: m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        }
    };
    let started = Instant::now();
    let mut last: Option<Sample> = None;
    loop {
        let m = std::fs::metadata(abs).ok()?;
        let cur = sample(&m);
        if last == Some(cur) {
            let stat = FileStat {
                len: cur.len,
                modified: cur.mtime_ms,
            };
            let hash = hash_file(abs);
            return Some((stat, hash));
        }
        last = Some(cur);
        if started.elapsed() >= Duration::from_millis(STABLE_MAX_MS) {
            return None;
        }
        std::thread::sleep(Duration::from_millis(STABLE_INTERVAL_MS));
    }
}

struct FileStat {
    len: u64,
    modified: i64,
}

fn hash_file(abs: &Path) -> Option<String> {
    let bytes = std::fs::read(abs).ok()?;
    let mut h = Sha256::new();
    h.update(&bytes);
    let out = h.finalize();
    let mut s = String::with_capacity(64);
    for b in out {
        use std::fmt::Write as _;
        let _ = write!(s, "{b:02x}");
    }
    Some(s)
}

/// 静默期核对辅助：路径连续 3 秒无新事件后才由前端定论删除（§13.5 L909）。
pub const DELETE_QUIET_MS: u64 = 3_000;

/// 排除目录名（audit/枚举复用）
pub const EXCLUDED_DIRS: [&str; 3] = [RECALLMD_DIR, ".git", "node_modules"];
