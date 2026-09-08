//! Workspace 注册、OS 独占锁与文件管理（设计 §4/§5.1/§6.3/§7.1/§13.6/§14.3）。
//!
//! 激活模型：一个进程内最多激活一个 Workspace（§2）。全部文档/文件命令只接受
//! 相对路径，由激活态解析根（§6.3 路径边界）。锁通过 `LockFileEx` 独占取得，
//! 进程终止自动释放；`workspace.lock` 文件存在本身不代表被占用（§7.1）。
//!
//! 文件操作边界（§13.6）：新建 create-new 拒绝覆盖；移动/重命名是同卷原子
//! rename 不覆盖目标（大小写重命名同一次原子调用完成，见 M2_NOTES 偏差记录）；
//! 删除移入 `.recallmd/trash/<operation_id>/` 并保留原路径清单；恢复绝不覆盖
//! 现存文件。移动/删除都会先写操作日志（STARTED），成功后提交（COMMITTED）。

use std::fs::{self, File};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use uuid::Uuid;
use windows::core::PCWSTR;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{
    GetDriveTypeW, GetVolumeInformationW, LockFileEx, MoveFileExW, UnlockFileEx, FILE_SHARE_READ,
    FILE_SHARE_WRITE, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, MOVE_FILE_FLAGS,
};
use windows::Win32::System::IO::OVERLAPPED;
use windows::Win32::System::WindowsProgramming::DRIVE_FIXED;

use super::error::*;
use super::paths::*;
use super::util::*;

/// 当前 manifest 格式版本；更高版本拒读（§7.1）
pub const FORMAT_VERSION: u32 = 1;
/// 文件名过滤默认/最大返回条数（§15.2 性能预算内）
pub const FILTER_LIMIT: usize = 200;
/// 目录树/枚举的深度上限，防御病态深嵌套
const MAX_WALK_DEPTH: usize = 64;
/// 删除确认界面展示的受影响条目上限
const DELETE_PREVIEW_ENTRIES: usize = 50;

// ---------------------------------------------------------------------------
// 激活态与生命周期
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub workspace_id: String,
    pub format_version: u32,
    /// 规范化根绝对路径（去掉 `\\?\` 前缀，用于展示与回传）
    pub root: String,
}

struct ActiveWorkspace {
    root_canon: PathBuf,
    info: WorkspaceInfo,
    /// 持有句柄即持有 LockFileEx 独占锁；drop/进程退出自动释放
    lock_file: File,
}

fn active_slot() -> &'static Mutex<Option<ActiveWorkspace>> {
    static S: OnceLock<Mutex<Option<ActiveWorkspace>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// 命令层入口：当前激活 workspace 的根；未激活报 WORKSPACE_NOT_OPEN
pub fn active_root() -> HostResult<PathBuf> {
    let guard = active_slot()
        .lock()
        .map_err(|_| HostError::new(IO_ERROR, "workspace 状态锁中毒"))?;
    match guard.as_ref() {
        Some(w) => Ok(w.root_canon.clone()),
        None => Err(HostError::new(WORKSPACE_NOT_OPEN, "尚未打开知识库")),
    }
}

pub fn active_info() -> Option<WorkspaceInfo> {
    active_slot()
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|w| w.info.clone()))
}

/// 校验根所在卷：仅本机固定磁盘 NTFS（§3 支持环境）
fn validate_root_volume(root_canon: &Path) -> HostResult<()> {
    let plain = display_path(root_canon);
    if plain.starts_with(r"\\") {
        return Err(HostError::new(
            PATH_REJECTED,
            "仅支持本机固定磁盘上的文件夹，不支持网络路径",
        )
        .with_path(&plain));
    }
    let drive_root = match plain.get(0..3) {
        Some(s) if s.as_bytes()[1] == b':' && (s.as_bytes()[2] == b'\\') => s.to_string(),
        _ => {
            return Err(HostError::new(PATH_REJECTED, "无法识别的根路径类型").with_path(&plain));
        }
    };
    let wide: Vec<u16> = drive_root.encode_utf16().chain(std::iter::once(0)).collect();
    let drive_type = unsafe { GetDriveTypeW(PCWSTR::from_raw(wide.as_ptr())) };
    if drive_type != DRIVE_FIXED {
        return Err(HostError::new(
            PATH_REJECTED,
            "知识库必须位于本机固定磁盘；网络盘与可移动介质不在第一版支持范围",
        )
        .with_path(&plain));
    }
    let mut fs_name_buf = [0u16; 32];
    unsafe {
        GetVolumeInformationW(
            PCWSTR::from_raw(wide.as_ptr()),
            None,
            None,
            None,
            None,
            Some(&mut fs_name_buf),
        )
    }
    .map_err(|e| map_windows_error(&e, root_canon))?;
    let len = fs_name_buf.iter().position(|&c| c == 0).unwrap_or(0);
    let fs_name = String::from_utf16_lossy(&fs_name_buf[..len]);
    if !fs_name.eq_ignore_ascii_case("NTFS") {
        return Err(HostError::new(
            PATH_REJECTED,
            format!("文件系统 {fs_name} 不在支持范围，仅支持 NTFS"),
        )
        .with_path(&plain));
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceManifest {
    workspace_id: String,
    format_version: u32,
}

/// manifest 只含 workspace_id 与 format_version，不存绝对路径（§7.1）
fn load_or_create_manifest(root_canon: &Path, recallmd: &Path) -> HostResult<WorkspaceInfo> {
    let path = recallmd.join("workspace.json");
    let make_info =
        |m: WorkspaceManifest| WorkspaceInfo {
            workspace_id: m.workspace_id,
            format_version: m.format_version,
            root: display_path(root_canon),
        };
    match fs::read(&path) {
        Ok(bytes) => {
            let m: WorkspaceManifest = serde_json::from_slice(&bytes)
                .map_err(|e| HostError::new(IO_ERROR, format!("workspace.json 损坏：{e}")))?;
            if m.format_version > FORMAT_VERSION {
                return Err(HostError::new(
                    IO_ERROR,
                    format!(
                        "manifest 格式版本 {} 高于本版支持的 {}，请升级 RecallMD",
                        m.format_version, FORMAT_VERSION
                    ),
                )
                .with_path(display_path(&path)));
            }
            if m.workspace_id.trim().is_empty() {
                return Err(HostError::new(IO_ERROR, "workspace.json 缺少 workspace_id")
                    .with_path(display_path(&path)));
            }
            Ok(make_info(m))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // 首次启用：生成新身份（manifest 与 SQLite 双丢时创建新 ID，§7.1）
            let m = WorkspaceManifest {
                workspace_id: Uuid::new_v4().to_string(),
                format_version: FORMAT_VERSION,
            };
            let json = serde_json::to_vec_pretty(&m)
                .map_err(|e| HostError::new(IO_ERROR, format!("manifest 序列化失败：{e}")))?;
            write_file_atomic(&path, &json)?;
            Ok(make_info(m))
        }
        Err(e) => Err(map_io_error(&e, Some(display_path(&path)))),
    }
}

fn open_lock_file(path: &Path) -> HostResult<File> {
    File::options()
        .read(true)
        .write(true)
        // 允许其他进程打开文件本身，独占性完全由 LockFileEx 表达（§7.1）
        .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE).0)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| map_io_error(&e, Some(display_path(path))))
}

fn lock_exclusive(f: &File) -> HostResult<()> {
    // LockFileEx 要求有效的 OVERLAPPED（读取 Offset）；锁整个文件区域
    let mut overlapped = OVERLAPPED::default();
    unsafe {
        LockFileEx(
            HANDLE(f.as_raw_handle()),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            None,
            u32::MAX,
            0,
            &mut overlapped,
        )
    }
    .map_err(|_| {
        HostError::new(
            WORKSPACE_LOCKED,
            "知识库已在其他 RecallMD 窗口打开；本版不支持多实例同时写入",
        )
    })
}

/// 打开（并激活）Workspace。顺序：取锁 → 读/建 manifest（§14.3）。
/// 同根重复打开幂等返回；换根时旧锁在替换后自动释放。
pub fn open_workspace(root: &str) -> HostResult<WorkspaceInfo> {
    let root_canon = resolve_root(root)?;
    validate_root_volume(&root_canon)?;
    let mut guard = active_slot()
        .lock()
        .map_err(|_| HostError::new(IO_ERROR, "workspace 状态锁中毒"))?;
    if let Some(w) = guard.as_ref() {
        if w.root_canon == root_canon {
            return Ok(w.info.clone());
        }
    }
    let recallmd = root_canon.join(RECALLMD_DIR);
    match fs::create_dir(&recallmd) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // 上次打开的遗留：必须是普通目录
            if !recallmd.is_dir() {
                return Err(HostError::new(PATH_REJECTED, ".recallmd 不是目录")
                    .with_path(display_path(&recallmd)));
            }
        }
        Err(e) => {
            return Err(map_io_error(&e, Some(display_path(&recallmd))));
        }
    }
    let lock_file = open_lock_file(&recallmd.join("workspace.lock"))?;
    lock_exclusive(&lock_file)?;
    let info = load_or_create_manifest(&root_canon, &recallmd)?;
    *guard = Some(ActiveWorkspace {
        root_canon,
        info: info.clone(),
        lock_file,
    });
    Ok(info)
}

/// 关闭当前 Workspace 并释放锁（进程退出时由 OS 兜底释放）
pub fn close_workspace() -> HostResult<()> {
    let mut guard = active_slot()
        .lock()
        .map_err(|_| HostError::new(IO_ERROR, "workspace 状态锁中毒"))?;
    if let Some(w) = guard.take() {
        let mut overlapped = OVERLAPPED::default();
        let _ = unsafe {
            UnlockFileEx(HANDLE(w.lock_file.as_raw_handle()), None, u32::MAX, 0, &mut overlapped)
        };
        drop(w.lock_file);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 目录树与文件名过滤（§15.2 展开加载；排除 .recallmd/.git/node_modules）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    pub relative_path: String,
    pub is_dir: bool,
}

const HIDDEN_DIRS: [&str; 3] = [".recallmd", ".git", "node_modules"];

fn is_hidden_dir_name(name: &str) -> bool {
    HIDDEN_DIRS.iter().any(|h| name.eq_ignore_ascii_case(h))
}

fn join_rel(parts: &[String], name: &str) -> String {
    if parts.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", parts.join("/"), name)
    }
}

/// 列出某目录的直接子项（目录优先、名称大小写不敏感排序）。
/// `dir` 为空串表示根。跳过 reparse point 与隐藏目录，仅显示 `.md` 文件。
pub fn list_dir(root_canon: &Path, dir: &str) -> HostResult<Vec<TreeEntry>> {
    let parts = if dir.is_empty() {
        Vec::new()
    } else {
        validate_dir_relative(dir)?
    };
    let (abs, exists) = join_and_check(root_canon, &parts)?;
    if !exists {
        return Err(HostError::new(FILE_NOT_FOUND, "目录不存在").with_path(dir));
    }
    if !fs::symlink_metadata(&abs)
        .map_err(|e| map_io_error(&e, Some(dir.to_string())))?
        .is_dir()
    {
        return Err(HostError::new(PATH_REJECTED, "目标不是目录").with_path(dir));
    }
    let mut dirs: Vec<TreeEntry> = Vec::new();
    let mut files: Vec<TreeEntry> = Vec::new();
    for entry in fs::read_dir(&abs).map_err(|e| map_io_error(&e, Some(dir.to_string())))? {
        let entry = entry.map_err(|e| map_io_error(&e, Some(dir.to_string())))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = entry.file_type().map_err(|e| map_io_error(&e, Some(dir.to_string())))?;
        if ft.is_symlink() {
            continue; // §6.3 不遍历 reparse point
        }
        if ft.is_dir() {
            if name.starts_with('.') || is_hidden_dir_name(&name) {
                continue;
            }
            dirs.push(TreeEntry {
                relative_path: join_rel(&parts, &name),
                is_dir: true,
                name,
            });
        } else if ft.is_file()
            && name.to_ascii_lowercase().ends_with(".md")
            && !name.starts_with('.')
        {
            files.push(TreeEntry {
                relative_path: join_rel(&parts, &name),
                is_dir: false,
                name,
            });
        }
    }
    let by_name = |a: &TreeEntry, b: &TreeEntry| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    };
    dirs.sort_by(by_name);
    files.sort_by(by_name);
    dirs.extend(files);
    Ok(dirs)
}

/// 递归访问可见 `.md` 文件；回调返回 false 提前终止。跳过 reparse point
/// 与隐藏目录。枚举失败的子目录跳过（过滤场景可容忍，§13.5 精神）。
fn visit_visible_md(
    dir_abs: &Path,
    rel_prefix: &str,
    depth: usize,
    f: &mut dyn FnMut(&str, &str) -> bool,
) -> bool {
    if depth > MAX_WALK_DEPTH {
        return true;
    }
    let rd = match fs::read_dir(dir_abs) {
        Ok(r) => r,
        Err(_) => return true,
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        if ft.is_dir() {
            if name.starts_with('.') || is_hidden_dir_name(&name) {
                continue;
            }
            if !visit_visible_md(&entry.path(), &rel, depth + 1, f) {
                return false;
            }
        } else if ft.is_file()
            && name.to_ascii_lowercase().ends_with(".md")
            && !name.starts_with('.')
        {
            if !f(&name, &rel) {
                return false;
            }
        }
    }
    true
}

/// 文件名过滤（§3：仅文件名，不做全文搜索）。大小写不敏感子串匹配。
pub fn filter_files(root_canon: &Path, query: &str, limit: usize) -> HostResult<Vec<String>> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, FILTER_LIMIT);
    let mut hits: Vec<(String, String)> = Vec::new(); // (小写名, rel)
    visit_visible_md(root_canon, "", 0, &mut |name, rel| {
        if name.to_lowercase().contains(&q) {
            hits.push((name.to_lowercase(), rel.to_string()));
        }
        hits.len() < limit
    });
    hits.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    Ok(hits.into_iter().map(|(_, rel)| rel).collect())
}

// ---------------------------------------------------------------------------
// 新建（§13.6：create-new，拒绝覆盖）
// ---------------------------------------------------------------------------

pub fn create_file(root_canon: &Path, relative: &str) -> HostResult<()> {
    let parts = validate_relative_path(relative)?;
    let (abs, exists) = join_and_check(root_canon, &parts)?;
    if exists {
        return Err(HostError::new(FILE_CONFLICT, "已存在同名文件或目录，拒绝覆盖")
            .with_path(relative));
    }
    File::options()
        .write(true)
        .create_new(true)
        .open(&abs)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                HostError::new(FILE_CONFLICT, "已存在同名文件或目录，拒绝覆盖")
                    .with_path(relative)
            } else {
                map_io_error(&e, Some(relative.to_string()))
            }
        })?;
    Ok(())
}

pub fn create_dir(root_canon: &Path, relative: &str) -> HostResult<()> {
    let parts = validate_dir_relative(relative)?;
    let (abs, exists) = join_and_check(root_canon, &parts)?;
    if exists {
        return Err(HostError::new(FILE_CONFLICT, "同名目录已存在").with_path(relative));
    }
    match fs::create_dir(&abs) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(HostError::new(
            FILE_CONFLICT,
            "同名文件或目录已存在，不会删除重建",
        )
        .with_path(relative)),
        Err(e) => Err(map_io_error(&e, Some(relative.to_string()))),
    }
}

// ---------------------------------------------------------------------------
// 移动 / 重命名（§13.6：同卷原子 rename，拒绝覆盖；大小写重命名同样原子完成）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovePreview {
    /// "FILE" | "DIR"
    pub kind: String,
    pub file_count: usize,
    pub dir_count: usize,
    pub case_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveResult {
    pub operation_id: String,
    pub kind: String,
    pub file_count: usize,
    pub dir_count: usize,
}

struct MovePlan {
    src_abs: PathBuf,
    dst_abs: PathBuf,
    kind: String,
    case_only: bool,
}

/// 分段大小写不敏感前缀判断（dst 是否位于 src 内部）
fn is_within(dst_parts: &[String], src_parts: &[String]) -> bool {
    dst_parts.len() > src_parts.len()
        && dst_parts[..src_parts.len()]
            .iter()
            .zip(src_parts)
            .all(|(d, s)| d.eq_ignore_ascii_case(s))
}

fn plan_move(root_canon: &Path, src: &str, dst: &str) -> HostResult<MovePlan> {
    let src_parts = validate_entry_relative(src)?;
    let dst_parts = validate_entry_relative(dst)?;
    let (src_abs, src_exists) = join_and_check(root_canon, &src_parts)?;
    if !src_exists {
        return Err(HostError::new(FILE_NOT_FOUND, "源路径不存在").with_path(src));
    }
    let meta = fs::symlink_metadata(&src_abs)
        .map_err(|e| map_io_error(&e, Some(src.to_string())))?;
    let kind = if meta.is_dir() {
        "DIR".to_string()
    } else if meta.is_file() {
        "FILE".to_string()
    } else {
        return Err(HostError::new(PATH_REJECTED, "源不是普通文件或目录").with_path(src));
    };
    if kind == "FILE" && !dst_parts.last().unwrap().to_ascii_lowercase().ends_with(".md") {
        return Err(HostError::new(PATH_REJECTED, "文件目标必须以 .md 结尾").with_path(dst));
    }
    // 目标与源逐段大小写不敏感比较：全等且字面不同 → 大小写重命名；
    // 全等且字面相同 → 无操作，拒绝
    let same_ci = src_parts.len() == dst_parts.len()
        && src_parts
            .iter()
            .zip(&dst_parts)
            .all(|(s, d)| s.eq_ignore_ascii_case(d));
    if same_ci && src_parts == dst_parts {
        return Err(HostError::new(PATH_REJECTED, "目标与源相同").with_path(dst));
    }
    let case_only = same_ci && src_parts != dst_parts;
    if kind == "DIR" && is_within(&dst_parts, &src_parts) {
        return Err(HostError::new(PATH_REJECTED, "不能把目录移动到它自己的内部").with_path(dst));
    }
    let (dst_abs, dst_exists) = join_and_check(root_canon, &dst_parts)?;
    // 大小写重命名时"目标已存在"命中的就是源文件本身（大小写不敏感 FS），
    // 不算冲突；其余场景存在即拒绝覆盖
    if dst_exists && !case_only {
        return Err(HostError::new(FILE_CONFLICT, "目标已存在，拒绝覆盖").with_path(dst));
    }
    let parent = dst_abs.parent().unwrap_or(root_canon);
    match fs::symlink_metadata(parent) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => {
            return Err(HostError::new(PATH_REJECTED, "目标父级不是目录").with_path(dst));
        }
        Err(_) => {
            return Err(HostError::new(FILE_NOT_FOUND, "目标文件夹不存在").with_path(dst));
        }
    }
    Ok(MovePlan {
        src_abs,
        dst_abs,
        kind,
        case_only,
    })
}

/// 物理 walk（不跳过隐藏目录——目录整体移动/删除是物理动作）。
/// 返回全部受影响文件的相对路径清单与计数（§13.6 先验证全部受影响路径）。
fn walk_physical(dir_abs: &Path, rel_prefix: &str, depth: usize, out: &mut WalkSummary) {
    if depth > MAX_WALK_DEPTH {
        return;
    }
    let rd = match fs::read_dir(dir_abs) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue; // reparse point 不遍历，但会随父目录整体移动
        }
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        if ft.is_dir() {
            out.dir_count += 1;
            walk_physical(&entry.path(), &rel, depth + 1, out);
        } else if ft.is_file() {
            out.file_count += 1;
            if name.to_ascii_lowercase().ends_with(".md") {
                out.md_files.push(rel);
            }
        }
    }
}

struct WalkSummary {
    md_files: Vec<String>,
    file_count: usize,
    dir_count: usize,
}

pub fn move_preview(root_canon: &Path, src: &str, dst: &str) -> HostResult<MovePreview> {
    let plan = plan_move(root_canon, src, dst)?;
    let mut walk = WalkSummary {
        md_files: Vec::new(),
        file_count: 0,
        dir_count: 0,
    };
    if plan.kind == "DIR" {
        walk_physical(&plan.src_abs, &src.to_string(), 0, &mut walk);
    } else {
        walk.file_count = 1;
    }
    Ok(MovePreview {
        kind: plan.kind,
        file_count: walk.file_count,
        dir_count: walk.dir_count,
        case_only: plan.case_only,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FsOperationLog {
    operation_id: String,
    /// "MOVE" | "DELETE"
    action: String,
    /// "STARTED" | "COMMITTED"
    phase: String,
    src: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    dst: Option<String>,
    file_count: usize,
    timestamp_ms: i64,
}

fn write_fs_oplog(
    ops_dir: &Path,
    operation_id: &str,
    action: &str,
    phase: &str,
    src: &str,
    dst: Option<&str>,
    file_count: usize,
) -> HostResult<()> {
    let log = FsOperationLog {
        operation_id: operation_id.to_string(),
        action: action.to_string(),
        phase: phase.to_string(),
        src: src.to_string(),
        dst: dst.map(|s| s.to_string()),
        file_count,
        timestamp_ms: now_ms(),
    };
    let path = ops_dir.join(format!("{operation_id}.json"));
    let json = serde_json::to_vec_pretty(&log)
        .map_err(|e| HostError::new(IO_ERROR, format!("日志序列化失败：{e}")))?;
    write_file_atomic(&path, &json)
}

/// 把崩溃遗留的草稿迁移到新路径键（尽力而为；活动 dirty 缓冲由前端先处理）
fn migrate_draft(root_canon: &Path, old_relative: &str, new_relative: &str) {
    let recovery = root_canon.join(RECALLMD_DIR).join("recovery");
    let old_key = recovery_key(old_relative);
    let new_key = recovery_key(new_relative);
    let old_draft = recovery.join(format!("{old_key}.draft.md"));
    let old_meta = recovery.join(format!("{old_key}.draft.meta.json"));
    if !old_draft.exists() {
        return;
    }
    let _ = fs::rename(&old_draft, recovery.join(format!("{new_key}.draft.md")));
    if old_meta.exists() {
        // 更新 meta 中的 relativePath 后落到新键
        if let Ok(text) = fs::read_to_string(&old_meta) {
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert(
                        "relativePath".into(),
                        serde_json::Value::String(new_relative.to_string()),
                    );
                }
                if let Ok(bytes) = serde_json::to_vec_pretty(&v) {
                    let _ = write_file_atomic(&recovery.join(format!("{new_key}.draft.meta.json")), &bytes);
                }
            }
        }
        let _ = fs::remove_file(&old_meta);
    }
}

pub fn move_path(root_canon: &Path, src: &str, dst: &str) -> HostResult<MoveResult> {
    let plan = plan_move(root_canon, src, dst)?;
    let mut walk = WalkSummary {
        md_files: Vec::new(),
        file_count: 0,
        dir_count: 0,
    };
    if plan.kind == "DIR" {
        walk_physical(&plan.src_abs, src, 0, &mut walk);
    } else {
        walk.file_count = 1;
        walk.md_files.push(src.to_string());
    }

    let op_id = Uuid::new_v4().to_string();
    let ops_dir = recallmd_sub(root_canon, "operations")?;
    write_fs_oplog(&ops_dir, &op_id, "MOVE", "STARTED", src, Some(dst), walk.file_count)
        .map_err(|e| e.with_op(&op_id))?;

    unsafe {
        MoveFileExW(
            PCWSTR::from_raw(to_wide(&plan.src_abs).as_ptr()),
            PCWSTR::from_raw(to_wide(&plan.dst_abs).as_ptr()),
            MOVE_FILE_FLAGS(0), // 同卷原子 rename；目标存在即失败，绝不覆盖
        )
    }
    .map_err(|e| map_windows_error(&e, &plan.dst_abs).with_op(&op_id))?;

    // 核验：目标出现；源消失（大小写重命名时源路径仍解析到同一文件，跳过）
    let dst_ok = fs::symlink_metadata(&plan.dst_abs).is_ok();
    let src_gone = plan.case_only || fs::symlink_metadata(&plan.src_abs).is_err();
    if !dst_ok || !src_gone {
        return Err(HostError::new(
            VERIFY_FAILED,
            "移动后核验失败：目标未出现或源未消失；请刷新目录树",
        )
        .with_path(dst)
        .with_op(&op_id));
    }

    // 草稿随路径迁移（尽力而为）
    for old_rel in &walk.md_files {
        let new_rel = old_rel.replacen(src, dst, 1);
        migrate_draft(root_canon, old_rel, &new_rel);
    }

    write_fs_oplog(&ops_dir, &op_id, "MOVE", "COMMITTED", src, Some(dst), walk.file_count)?;
    let _ = fs::remove_file(ops_dir.join(format!("{op_id}.json")));

    Ok(MoveResult {
        operation_id: op_id,
        kind: plan.kind,
        file_count: walk.file_count,
        dir_count: walk.dir_count,
    })
}

// ---------------------------------------------------------------------------
// 删除 → trash 与恢复（§13.6 / §14.2：保留原路径清单，绝不覆盖恢复）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePreview {
    /// "FILE" | "DIR"
    pub kind: String,
    pub file_count: usize,
    pub dir_count: usize,
    /// 受影响条目样例（上限 DELETE_PREVIEW_ENTRIES，供确认界面展示）
    pub entries: Vec<String>,
    pub total_entries: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub operation_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashManifest {
    operation_id: String,
    /// "FILE" | "DIR"
    kind: String,
    original_relative_path: String,
    deleted_at_ms: i64,
    file_count: usize,
    dir_count: usize,
    md_files: Vec<String>,
    /// "PLANNED" | "COMMITTED"；只有 COMMITTED 出现在回收站列表
    phase: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub operation_id: String,
    pub kind: String,
    pub original_relative_path: String,
    pub deleted_at_ms: i64,
    pub file_count: usize,
    pub dir_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub restored_path: String,
}

fn resolve_existing_entry(root_canon: &Path, relative: &str) -> HostResult<(PathBuf, String)> {
    let parts = validate_entry_relative(relative)?;
    let (abs, exists) = join_and_check(root_canon, &parts)?;
    if !exists {
        return Err(HostError::new(FILE_NOT_FOUND, "路径不存在").with_path(relative));
    }
    let meta = fs::symlink_metadata(&abs)
        .map_err(|e| map_io_error(&e, Some(relative.to_string())))?;
    let kind = if meta.is_dir() {
        "DIR"
    } else if meta.is_file() {
        "FILE"
    } else {
        return Err(HostError::new(PATH_REJECTED, "目标不是普通文件或目录").with_path(relative));
    };
    Ok((abs, kind.to_string()))
}

pub fn delete_preview(root_canon: &Path, relative: &str) -> HostResult<DeletePreview> {
    let (abs, kind) = resolve_existing_entry(root_canon, relative)?;
    let mut walk = WalkSummary {
        md_files: Vec::new(),
        file_count: 0,
        dir_count: 0,
    };
    if kind == "DIR" {
        walk_physical(&abs, relative, 0, &mut walk);
    } else {
        walk.file_count = 1;
        walk.md_files.push(relative.to_string());
    }
    let mut entries: Vec<String> = walk.md_files.clone();
    if kind == "DIR" {
        entries.push(format!("{relative}/ …")); // 提示目录整体受影响
    }
    let total = entries.len();
    entries.truncate(DELETE_PREVIEW_ENTRIES);
    Ok(DeletePreview {
        kind,
        file_count: walk.file_count,
        dir_count: walk.dir_count,
        entries,
        total_entries: total,
    })
}

pub fn delete_path(root_canon: &Path, relative: &str) -> HostResult<DeleteResult> {
    let (abs, kind) = resolve_existing_entry(root_canon, relative)?;
    let mut walk = WalkSummary {
        md_files: Vec::new(),
        file_count: 0,
        dir_count: 0,
    };
    if kind == "DIR" {
        walk_physical(&abs, relative, 0, &mut walk);
    } else {
        walk.file_count = 1;
        walk.md_files.push(relative.to_string());
    }

    let op_id = Uuid::new_v4().to_string();
    let trash_dir = recallmd_sub(root_canon, "trash")?.join(&op_id);
    fs::create_dir(&trash_dir)
        .map_err(|e| map_io_error(&e, Some(display_path(&trash_dir))))?;

    // manifest 先落（PLANNED），移动完成后再标记 COMMITTED
    let mut manifest = TrashManifest {
        operation_id: op_id.clone(),
        kind: kind.clone(),
        original_relative_path: relative.to_string(),
        deleted_at_ms: now_ms(),
        file_count: walk.file_count,
        dir_count: walk.dir_count,
        md_files: walk.md_files.clone(),
        phase: "PLANNED".into(),
    };
    let manifest_path = trash_dir.join("manifest.json");
    let json = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| HostError::new(IO_ERROR, format!("trash 清单序列化失败：{e}")))?;
    write_file_atomic(&manifest_path, &json)?;

    let ops_dir = recallmd_sub(root_canon, "operations")?;
    write_fs_oplog(&ops_dir, &op_id, "DELETE", "STARTED", relative, None, walk.file_count)
        .map_err(|e| e.with_op(&op_id))?;

    // 移入 trash：payload 镜像原相对路径结构，避免条目名冲突
    let payload_target = trash_dir.join("payload").join(relative);
    if let Some(parent) = payload_target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| map_io_error(&e, Some(display_path(parent))))?;
    }
    unsafe {
        MoveFileExW(
            PCWSTR::from_raw(to_wide(&abs).as_ptr()),
            PCWSTR::from_raw(to_wide(&payload_target).as_ptr()),
            MOVE_FILE_FLAGS(0),
        )
    }
    .map_err(|e| map_windows_error(&e, &payload_target).with_op(&op_id))?;

    let moved_ok = fs::symlink_metadata(&payload_target).is_ok()
        && fs::symlink_metadata(&abs).is_err();
    if !moved_ok {
        return Err(HostError::new(
            VERIFY_FAILED,
            "删除后核验失败：原路径未消失或回收站内容未就位",
        )
        .with_path(relative)
        .with_op(&op_id));
    }

    // 草稿一并移入回收站（恢复时跟着回去）
    let drafts_dir = trash_dir.join("drafts");
    let recovery_dir = root_canon.join(RECALLMD_DIR).join("recovery");
    for rel in &walk.md_files {
        let key = recovery_key(rel);
        for suffix in [".draft.md", ".draft.meta.json"] {
            let from = recovery_dir.join(format!("{key}{suffix}"));
            if from.exists() {
                let _ = fs::create_dir(&drafts_dir);
                let _ = fs::rename(&from, drafts_dir.join(format!("{key}{suffix}")));
            }
        }
    }

    manifest.phase = "COMMITTED".into();
    let json = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| HostError::new(IO_ERROR, format!("trash 清单序列化失败：{e}")))?;
    write_file_atomic(&manifest_path, &json)?;

    write_fs_oplog(&ops_dir, &op_id, "DELETE", "COMMITTED", relative, None, walk.file_count)?;
    let _ = fs::remove_file(ops_dir.join(format!("{op_id}.json")));

    Ok(DeleteResult { operation_id: op_id })
}

pub fn trash_list(root_canon: &Path) -> HostResult<Vec<TrashEntry>> {
    let trash_root = root_canon.join(RECALLMD_DIR).join("trash");
    let mut out = Vec::new();
    let rd = match fs::read_dir(&trash_root) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(map_io_error(&e, Some(display_path(&trash_root)))),
    };
    for entry in rd.flatten() {
        let manifest_path = entry.path().join("manifest.json");
        let Ok(text) = fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(m) = serde_json::from_str::<TrashManifest>(&text) else {
            continue;
        };
        if m.phase != "COMMITTED" || m.operation_id != entry.file_name().to_string_lossy() {
            continue;
        }
        out.push(TrashEntry {
            operation_id: m.operation_id,
            kind: m.kind,
            original_relative_path: m.original_relative_path,
            deleted_at_ms: m.deleted_at_ms,
            file_count: m.file_count,
            dir_count: m.dir_count,
        });
    }
    out.sort_by(|a, b| b.deleted_at_ms.cmp(&a.deleted_at_ms));
    Ok(out)
}

pub fn trash_restore(
    root_canon: &Path,
    trash_id: &str,
    new_relative: Option<&str>,
) -> HostResult<RestoreResult> {
    // trash_id 必须是 UUID：杜绝路径注入
    let parsed = Uuid::parse_str(trash_id)
        .map_err(|_| HostError::new(PATH_REJECTED, "无效的回收站条目 ID"))?;
    let trash_dir = root_canon.join(RECALLMD_DIR).join("trash").join(trash_id);
    let manifest: TrashManifest = serde_json::from_str(
        &fs::read_to_string(trash_dir.join("manifest.json")).map_err(|e| {
            map_io_error(&e, Some(display_path(&trash_dir)))
        })?,
    )
    .map_err(|e| HostError::new(IO_ERROR, format!("trash 清单损坏：{e}")))?;
    if manifest.operation_id != parsed.to_string() {
        return Err(HostError::new(PATH_REJECTED, "回收站清单与目录不匹配"));
    }
    let target = new_relative.unwrap_or(&manifest.original_relative_path);
    if manifest.kind == "FILE" {
        validate_relative_path(target)?;
    } else {
        validate_dir_relative(target)?;
    }
    let target_parts = validate_entry_relative(target)?;
    let (target_abs, exists) = join_and_check(root_canon, &target_parts)?;
    if exists {
        return Err(HostError::new(
            FILE_CONFLICT,
            "原位置已被占用，请换一个路径恢复（不会覆盖现存文件）",
        )
        .with_path(target));
    }
    let payload = trash_dir.join("payload").join(&manifest.original_relative_path);
    if !payload.exists() {
        return Err(HostError::new(FILE_NOT_FOUND, "回收站内容缺失，无法恢复").with_op(&manifest.operation_id));
    }
    if let Some(parent) = target_abs.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| map_io_error(&e, Some(display_path(parent))))?;
    }
    unsafe {
        MoveFileExW(
            PCWSTR::from_raw(to_wide(&payload).as_ptr()),
            PCWSTR::from_raw(to_wide(&target_abs).as_ptr()),
            MOVE_FILE_FLAGS(0),
        )
    }
    .map_err(|e| map_windows_error(&e, &target_abs).with_op(&manifest.operation_id))?;

    // 草稿跟着回到 recovery
    let drafts_dir = trash_dir.join("drafts");
    if let Ok(rd) = fs::read_dir(&drafts_dir) {
        let recovery_dir = root_canon.join(RECALLMD_DIR).join("recovery");
        let _ = fs::create_dir_all(&recovery_dir);
        for f in rd.flatten() {
            let _ = fs::rename(f.path(), recovery_dir.join(f.file_name()));
        }
    }
    let _ = fs::remove_dir_all(&trash_dir);
    Ok(RestoreResult {
        restored_path: target.to_string(),
    })
}
