//! 文档读写与安全保存协议（设计 §13.1/§13.2 的 M1 实现）。
//!
//! 保存协议七步：恢复副本 → 操作日志 → 同目录临时文件(create-new + flush)
//! → 替换前二次核验 → `ReplaceFileW` 带备份（新文件用不覆盖的 `MoveFileExW`）
//! → 回读校验 → 清理。任一步失败都保证：原文不被半成品覆盖、
//! 候选与旧版至少一份留存在 `.recallmd/recovery`。

use std::collections::HashMap;
use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use uuid::Uuid;
use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::{MoveFileExW, ReplaceFileW, MOVE_FILE_FLAGS, REPLACE_FILE_FLAGS};

use super::error::*;
use super::paths::*;
use super::util::*;

/// §15.2：50 MiB 以上本版只读
pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// 新文件/目标缺失场景的 expected_hash 哨兵
pub const HASH_ABSENT: &str = "ABSENT";

/// M4：按路径的保存串行队列（M1 全局队列升级）。同一文件保存串行（expectedHash
/// CAS 顺序不被并发写打乱），不同文件互不阻塞（§15.2 交互预算）。
/// 队列条目常驻（每个路径一把 0 字节锁，库规模下可忽略）。
fn save_queue_for(key: &str) -> HostResult<Arc<Mutex<()>>> {
    static QUEUES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let map = QUEUES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map
        .lock()
        .map_err(|_| HostError::new(IO_ERROR, "保存队列锁中毒"))?;
    Ok(guard
        .entry(key.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDocumentResult {
    /// LF 规范化、去 BOM 的正文
    pub text: String,
    /// 磁盘原始字节（含 BOM/原始换行）的 SHA-256，保存时作为 expectedHash
    pub raw_byte_hash: String,
    pub byte_size: u64,
    pub has_bom: bool,
    /// "LF" | "CRLF" | "MIXED"
    pub line_ending: String,
    pub mtime_ms: i64,
    /// M7：卷序列号+文件索引（外部移动识别，§13.5；可空）
    pub file_identity: Option<String>,
}

fn detect_line_ending(b: &[u8]) -> &'static str {
    let mut lf = 0usize;
    let mut crlf = 0usize;
    for (i, byte) in b.iter().enumerate() {
        if *byte == b'\n' {
            lf += 1;
            if i > 0 && b[i - 1] == b'\r' {
                crlf += 1;
            }
        }
    }
    if lf == 0 || crlf == 0 {
        "LF"
    } else if crlf == lf {
        "CRLF"
    } else {
        "MIXED"
    }
}

pub fn read_document(root: &str, relative: &str) -> HostResult<ReadDocumentResult> {
    let root_canon = resolve_root(root)?;
    let parts = validate_relative_path(relative)?;
    let (abs, exists) = join_and_check(&root_canon, &parts)?;
    if !exists {
        return Err(HostError::new(FILE_NOT_FOUND, "文件不存在").with_path(relative));
    }
    let meta = fs::symlink_metadata(&abs)
        .map_err(|e| map_io_error(&e, Some(relative.to_string())))?;
    if !meta.is_file() {
        return Err(HostError::new(PATH_REJECTED, "目标不是普通文件").with_path(relative));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(HostError::new(
            FILE_TOO_LARGE,
            format!("文件超过 {} MiB，本版只读上限", MAX_FILE_BYTES / 1024 / 1024),
        )
        .with_path(relative));
    }
    let bytes = fs::read(&abs).map_err(|e| map_io_error(&e, Some(relative.to_string())))?;
    let (has_bom, payload) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (true, &bytes[3..])
    } else {
        (false, &bytes[..])
    };
    let raw = String::from_utf8(payload.to_vec()).map_err(|_| {
        HostError::new(
            UNSUPPORTED_ENCODING,
            "文件不是有效的 UTF-8，已按只读打开；请另存转换，本版不会猜测编码覆写",
        )
        .with_path(relative)
    })?;
    let line_ending = detect_line_ending(payload);
    let text = if line_ending == "LF" {
        raw
    } else {
        raw.replace("\r\n", "\n")
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(ReadDocumentResult {
        text,
        raw_byte_hash: sha256_hex(&bytes),
        byte_size: bytes.len() as u64,
        has_bom,
        line_ending: line_ending.to_string(),
        mtime_ms,
        file_identity: super::audit::file_identity_of(&abs),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatDocumentResult {
    pub exists: bool,
    pub raw_byte_hash: Option<String>,
    pub byte_size: Option<u64>,
    pub mtime_ms: Option<i64>,
}

/// 轻量探测：窗口聚焦等场景的外部变更检测（§13.3 的 M1 简化，无 Watcher）
pub fn stat_document(root: &str, relative: &str) -> HostResult<StatDocumentResult> {
    let root_canon = resolve_root(root)?;
    let parts = validate_relative_path(relative)?;
    let (abs, exists) = join_and_check(&root_canon, &parts)?;
    if !exists {
        return Ok(StatDocumentResult {
            exists: false,
            raw_byte_hash: None,
            byte_size: None,
            mtime_ms: None,
        });
    }
    let meta = fs::symlink_metadata(&abs)
        .map_err(|e| map_io_error(&e, Some(relative.to_string())))?;
    if !meta.is_file() {
        return Err(HostError::new(PATH_REJECTED, "目标不是普通文件").with_path(relative));
    }
    let bytes = fs::read(&abs).map_err(|e| map_io_error(&e, Some(relative.to_string())))?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(StatDocumentResult {
        exists: true,
        raw_byte_hash: Some(sha256_hex(&bytes)),
        byte_size: Some(bytes.len() as u64),
        mtime_ms: Some(mtime_ms),
    })
}

// ---------------------------------------------------------------------------
// 保存协议
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDocumentParams {
    /// LF 内部表示的正文
    pub text: String,
    /// "LF" | "CRLF"；MIXED 必须先由 UI 提示规范化（§7.2）
    pub eol: String,
    pub add_bom: bool,
    /// 最后接受的磁盘字节哈希；新目标传 "ABSENT"
    pub expected_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDocumentResult {
    pub committed_hash: String,
    pub byte_size: u64,
    pub operation_id: String,
}

/// 正文 → 目标原始字节：统一内部 LF → 目标换行风格 + 按需 BOM。
/// 防御性清除孤立的 \r（CM 侧理论上已规范化）。
fn build_target_bytes(text: &str, eol: &str, add_bom: bool) -> HostResult<Vec<u8>> {
    if eol != "LF" && eol != "CRLF" {
        return Err(HostError::new(
            PATH_REJECTED,
            "换行风格必须是 LF 或 CRLF；混合换行需先明确规范化",
        ));
    }
    let unified = text.replace("\r\n", "\n").replace('\r', "\n");
    let body: String = if eol == "CRLF" {
        unified.replace('\n', "\r\n")
    } else {
        unified
    };
    let mut bytes = Vec::with_capacity(body.len() + 3);
    if add_bom {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(body.as_bytes());
    Ok(bytes)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationLog {
    pub operation_id: String,
    pub path: String,
    /// STARTED → FILE_COMMITTED → INDEX_COMMITTED（M4：日志保留到索引事务确认后才删除）
    pub phase: String,
    pub expected_hash: String,
    pub new_hash: String,
    pub timestamp_ms: i64,
}

fn write_oplog(dir: &Path, log: &OperationLog) -> HostResult<()> {
    let path = dir.join(format!("{}.json", log.operation_id));
    let json = serde_json::to_vec_pretty(log)
        .map_err(|e| HostError::new(IO_ERROR, format!("日志序列化失败：{e}")))?;
    write_file_atomic(&path, &json)
}

/// 索引事务确认（§13.2 L847：INDEX_COMMITTED 后清理日志）。
/// 幂等：日志已删除 = 索引已确认过，直接 Ok；停在 STARTED = 保存从未提交。
pub fn index_complete(root: &str, operation_id: &str) -> HostResult<()> {
    let root_canon = resolve_root(root)?;
    let ops_dir = recallmd_sub(&root_canon, "operations")?;
    let log_path = ops_dir.join(format!("{operation_id}.json"));
    let raw = match fs::read(&log_path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(map_io_error(&e, Some(log_path.to_string_lossy().into_owned()))),
    };
    let mut log: OperationLog = serde_json::from_slice(&raw)
        .map_err(|e| HostError::new(VERIFY_FAILED, format!("操作日志损坏：{e}")).with_op(operation_id))?;
    match log.phase.as_str() {
        "FILE_COMMITTED" => {
            log.phase = "INDEX_COMMITTED".into();
            log.timestamp_ms = now_ms();
            write_oplog(&ops_dir, &log)?;
            let _ = fs::remove_file(&log_path);
            Ok(())
        }
        "INDEX_COMMITTED" => {
            let _ = fs::remove_file(&log_path);
            Ok(())
        }
        other => Err(HostError::new(
            VERIFY_FAILED,
            format!("操作日志处于 {other} 阶段，索引确认不适用（保存未提交？）"),
        )
        .with_op(operation_id)),
    }
}

pub fn save_document(
    root: &str,
    relative: &str,
    params: SaveDocumentParams,
) -> HostResult<SaveDocumentResult> {
    let op_id = Uuid::new_v4().to_string();
    let op_short = &op_id[..8];
    let root_canon = resolve_root(root)?;
    let parts = validate_relative_path(relative)?;
    let (abs, exists) = join_and_check(&root_canon, &parts)?;

    // 目标字节与哈希
    let new_bytes = build_target_bytes(&params.text, &params.eol, params.add_bom)?;
    if new_bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(HostError::new(FILE_TOO_LARGE, "保存后超过 50 MiB 上限").with_path(relative));
    }
    let new_hash = sha256_hex(&new_bytes);

    let recovery_dir = recallmd_sub(&root_canon, "recovery")?;
    let ops_dir = recallmd_sub(&root_canon, "operations")?;
    let key = recovery_key(relative);
    // 同路径串行：队列锁须在触碰任何恢复材料/临时文件之前取得
    let queue = save_queue_for(&key)?;
    let _guard = queue
        .lock()
        .map_err(|_| HostError::new(IO_ERROR, "保存队列锁中毒"))?;
    let base_path = recovery_dir.join(format!("{key}.base.md"));
    let candidate_path = recovery_dir.join(format!("{key}.candidate.md"));
    let backup_path = recovery_dir.join(format!("{key}.backup.md"));
    let draft_path = recovery_dir.join(format!("{key}.draft.md"));
    let draft_meta_path = recovery_dir.join(format!("{key}.draft.meta.json"));

    let conflict = |msg: &str| {
        HostError::new(FILE_CONFLICT, msg)
            .with_path(relative)
            .with_op(&op_id)
    };

    // 步骤 1：本次候选先落盘——即使随后任何核验失败/进程崩溃，
    // 本地文本都有恢复副本（§14.4：两版保留）
    write_file_synced(&candidate_path, &new_bytes)?;

    // 步骤 2：核验当前磁盘版本 == expectedHash
    let disk_hash = read_hash(&abs)?;
    match (exists, disk_hash, params.expected_hash.as_str()) {
        (true, Some(h), exp) if exp == h => Ok(()),
        (false, None, HASH_ABSENT) => Ok(()),
        (true, Some(_), HASH_ABSENT) => Err(conflict("目标文件已存在，拒绝覆盖（新文件协议）")),
        (true, Some(_), _) => Err(conflict("磁盘文件有新变化，请先处理差异")),
        (false, None, _) => Err(conflict("文件已被外部删除或移动")),
        _ => Err(conflict("目标状态无法核验")),
    }?;

    // 步骤 3：恢复材料——旧版（base）副本
    if let Some(old) = fs::read(&abs).ok() {
        write_file_synced(&base_path, &old)?;
    }

    // 步骤 4：操作日志
    write_oplog(
        &ops_dir,
        &OperationLog {
            operation_id: op_id.clone(),
            path: relative.to_string(),
            phase: "STARTED".into(),
            expected_hash: params.expected_hash.clone(),
            new_hash: new_hash.clone(),
            timestamp_ms: now_ms(),
        },
    )?;

    // 步骤 5：同目录临时文件（create-new + flush）
    let file_name = abs
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file.md".into());
    let temp_path = abs
        .parent()
        .unwrap_or(&root_canon)
        .join(format!(".{file_name}.recallmd-tmp-{op_short}"));
    if temp_path.exists() {
        // 上一次中断的临时文件：唯一名含操作 ID，正常不撞；撞则清理后重建
        let _ = fs::remove_file(&temp_path);
    }
    {
        let mut f = File::options()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|e| map_io_error(&e, Some(temp_path.to_string_lossy().into_owned())))?;
        f.write_all(&new_bytes)
            .map_err(|e| map_io_error(&e, Some(temp_path.to_string_lossy().into_owned())))?;
        f.sync_all()
            .map_err(|e| map_io_error(&e, Some(temp_path.to_string_lossy().into_owned())))?;
    }

    // 步骤 6：替换前二次核验（窗口期内被外部改写则中止）
    let recheck = read_hash(&abs)?;
    let ok = match (exists, recheck.as_deref(), params.expected_hash.as_str()) {
        (true, Some(h), exp) => h == exp,
        (false, None, HASH_ABSENT) => true,
        _ => false,
    };
    if !ok {
        let _ = fs::remove_file(&temp_path);
        return Err(conflict("替换前核验失败：磁盘文件在保存过程中被外部修改"));
    }

    // 步骤 7：原子替换（带备份）/ 不覆盖的新建
    unsafe {
        let t = to_wide(&temp_path);
        let a = to_wide(&abs);
        if exists {
            let b = to_wide(&backup_path);
            // ReplaceFileW 要求备份名可用；先移除旧备份（属于上一轮已完成提交的副本）
            let _ = fs::remove_file(&backup_path);
            ReplaceFileW(
                PCWSTR::from_raw(a.as_ptr()),
                PCWSTR::from_raw(t.as_ptr()),
                PCWSTR::from_raw(b.as_ptr()),
                REPLACE_FILE_FLAGS(0),
                None,
                None,
            )
            .map_err(|e| {
                // 部分失败状态：不得假设原路径原样不动（§13.2）
                map_windows_error(&e, &abs).with_op(&op_id)
            })?;
        } else {
            MoveFileExW(
                PCWSTR::from_raw(t.as_ptr()),
                PCWSTR::from_raw(a.as_ptr()),
                MOVE_FILE_FLAGS(0), // 不带 REPLACE_EXISTING：目标出现即失败
            )
            .map_err(|e| map_windows_error(&e, &abs).with_op(&op_id))?;
        }
    }

    // 步骤 8：回读校验，只有与本次字节一致才算保存成功
    let committed = read_hash(&abs)?;
    if committed.as_deref() != Some(new_hash.as_str()) {
        return Err(HostError::new(
            VERIFY_FAILED,
            "替换后回读哈希不一致，保存未确认；候选与备份已保留",
        )
        .with_path(relative)
        .with_op(&op_id));
    }

    let _ = write_oplog(
        &ops_dir,
        &OperationLog {
            operation_id: op_id.clone(),
            path: relative.to_string(),
            phase: "FILE_COMMITTED".into(),
            expected_hash: params.expected_hash.clone(),
            new_hash: new_hash.clone(),
            timestamp_ms: now_ms(),
        },
    );

    // 清理：候选完成使命；保留 base/backup 供回退；草稿已过时。
    // M4：操作日志保留在 FILE_COMMITTED——索引事务确认（index_complete）后才删除，
    // 重启时据此发现"正文已存、索引落后"的文档（§13.2 L861）
    let _ = fs::remove_file(&candidate_path);
    let _ = fs::remove_file(&draft_path);
    let _ = fs::remove_file(&draft_meta_path);

    // M7：登记自写（§13.3 L883——watcher 以 hash 相等识别内部写入，非时间窗）
    super::watcher::record_internal_write(relative, &new_hash);

    Ok(SaveDocumentResult {
        committed_hash: new_hash,
        byte_size: new_bytes.len() as u64,
        operation_id: op_id,
    })
}

// ---------------------------------------------------------------------------
// 恢复草稿（§13.1 / §14.2：空闲 1s 落盘、每 10s 至少一次、崩溃可恢复）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftInfo {
    pub exists: bool,
    pub saved_at_ms: Option<i64>,
    pub source_hash: Option<String>,
    pub text: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftMeta {
    relative_path: String,
    source_hash: String,
    saved_at_ms: i64,
}

pub fn draft_write(
    root: &str,
    relative: &str,
    text: &str,
    eol: &str,
    add_bom: bool,
    source_hash: &str,
) -> HostResult<i64> {
    let root_canon = resolve_root(root)?;
    let parts = validate_relative_path(relative)?;
    let _ = join_and_check(&root_canon, &parts)?;
    let bytes = build_target_bytes(text, eol, add_bom)?;
    let recovery_dir = recallmd_sub(&root_canon, "recovery")?;
    let key = recovery_key(relative);
    let meta = DraftMeta {
        relative_path: relative.to_string(),
        source_hash: source_hash.to_string(),
        saved_at_ms: now_ms(),
    };
    write_file_atomic(
        &recovery_dir.join(format!("{key}.draft.meta.json")),
        &serde_json::to_vec_pretty(&meta)
            .map_err(|e| HostError::new(IO_ERROR, format!("草稿元数据序列化失败：{e}")))?,
    )?;
    write_file_synced(&recovery_dir.join(format!("{key}.draft.md")), &bytes)?;
    Ok(meta.saved_at_ms)
}

pub fn draft_read(root: &str, relative: &str) -> HostResult<DraftInfo> {
    let root_canon = resolve_root(root)?;
    let parts = validate_relative_path(relative)?;
    let _ = join_and_check(&root_canon, &parts)?;
    let recovery_dir = root_canon.join(RECALLMD_DIR).join("recovery");
    let key = recovery_key(relative);
    let meta_path = recovery_dir.join(format!("{key}.draft.meta.json"));
    let draft_path = recovery_dir.join(format!("{key}.draft.md"));
    if !meta_path.exists() || !draft_path.exists() {
        return Ok(DraftInfo {
            exists: false,
            saved_at_ms: None,
            source_hash: None,
            text: None,
        });
    }
    let meta: DraftMeta = serde_json::from_str(
        &fs::read_to_string(&meta_path)
            .map_err(|e| map_io_error(&e, Some(meta_path.to_string_lossy().into_owned())))?,
    )
    .map_err(|e| HostError::new(IO_ERROR, format!("草稿元数据损坏：{e}")))?;
    let bytes = fs::read(&draft_path)
        .map_err(|e| map_io_error(&e, Some(draft_path.to_string_lossy().into_owned())))?;
    let payload = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    let text = String::from_utf8(payload.to_vec())
        .map_err(|e| HostError::new(IO_ERROR, format!("草稿非 UTF-8：{e}")))?
        .replace("\r\n", "\n");
    Ok(DraftInfo {
        exists: true,
        saved_at_ms: Some(meta.saved_at_ms),
        source_hash: Some(meta.source_hash),
        text: Some(text),
    })
}

pub fn draft_discard(root: &str, relative: &str) -> HostResult<()> {
    let root_canon = resolve_root(root)?;
    let parts = validate_relative_path(relative)?;
    let _ = join_and_check(&root_canon, &parts)?;
    let recovery_dir = root_canon.join(RECALLMD_DIR).join("recovery");
    let key = recovery_key(relative);
    let _ = fs::remove_file(recovery_dir.join(format!("{key}.draft.md")));
    let _ = fs::remove_file(recovery_dir.join(format!("{key}.draft.meta.json")));
    Ok(())
}
