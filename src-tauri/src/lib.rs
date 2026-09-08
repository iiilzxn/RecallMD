// Tauri 命令层：薄封装 persistence 模块（设计 §6.2 少量粗粒度有类型命令）。
// M2 起：打开 Workspace 后命令只接受相对路径，根由激活态解析（§6.3）。
pub mod persistence;

use serde::Serialize;
use tauri::Manager;

use crate::persistence::document::{
    draft_discard as draft_discard_impl, draft_read as draft_read_impl,
    draft_write as draft_write_impl, read_document as read_document_impl,
    save_document as save_document_impl, stat_document as stat_document_impl, DraftInfo,
    ReadDocumentResult, SaveDocumentParams, SaveDocumentResult, StatDocumentResult,
};
use crate::persistence::error::HostResult;
use crate::persistence::recent::{
    forget_recent, load_recents, record_recent, RecentEntry,
};
use crate::persistence::workspace::{
    active_info, active_root, close_workspace, create_dir as create_dir_impl,
    create_file as create_file_impl, delete_path as delete_path_impl,
    delete_preview as delete_preview_impl, filter_files as filter_files_impl,
    list_dir as list_dir_impl, move_path as move_path_impl, move_preview as move_preview_impl,
    open_workspace, trash_list as trash_list_impl, trash_restore as trash_restore_impl,
    DeletePreview, DeleteResult, MovePreview, MoveResult, RestoreResult, TrashEntry, TreeEntry,
    WorkspaceInfo, FILTER_LIMIT,
};

#[derive(Serialize)]
pub struct M0Environment {
    rust: String,
    tauri: String,
}

#[tauri::command]
fn m0_environment() -> M0Environment {
    M0Environment {
        rust: format!("rustc {}", env!("CARGO_PKG_RUST_VERSION")),
        tauri: format!("tauri {}", tauri::VERSION),
    }
}

// --- Workspace（M2） ---

fn app_config_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok()
}

#[tauri::command]
fn workspace_open(root: String, app: tauri::AppHandle) -> HostResult<WorkspaceInfo> {
    let info = open_workspace(&root)?;
    // 最近列表写应用配置目录（§7.1）；失败不阻塞打开
    if let Some(cfg) = app_config_dir(&app) {
        if let Err(e) = record_recent(&cfg, &info.root, &info.workspace_id) {
            eprintln!("[recallmd] 最近列表更新失败：{e}");
        }
    }
    Ok(info)
}

#[tauri::command]
fn workspace_close() -> HostResult<()> {
    close_workspace()
}

#[tauri::command]
fn workspace_info() -> Option<WorkspaceInfo> {
    active_info()
}

#[tauri::command]
fn workspace_recent_list(app: tauri::AppHandle) -> Vec<RecentEntry> {
    app_config_dir(&app)
        .map(|cfg| load_recents(&cfg))
        .unwrap_or_default()
}

#[tauri::command]
fn workspace_recent_forget(root: String, app: tauri::AppHandle) -> Vec<RecentEntry> {
    match app_config_dir(&app) {
        Some(cfg) => forget_recent(&cfg, &root).unwrap_or_else(|e| {
            eprintln!("[recallmd] 最近列表更新失败：{e}");
            load_recents(&cfg)
        }),
        None => Vec::new(),
    }
}

// --- 目录树与文件管理（M2） ---

#[tauri::command]
fn tree_list(dir: String) -> HostResult<Vec<TreeEntry>> {
    list_dir_impl(&active_root()?, &dir)
}

#[tauri::command]
fn tree_filter(query: String, limit: Option<usize>) -> HostResult<Vec<String>> {
    filter_files_impl(&active_root()?, &query, limit.unwrap_or(FILTER_LIMIT))
}

#[tauri::command]
fn file_create(path: String) -> HostResult<()> {
    create_file_impl(&active_root()?, &path)
}

#[tauri::command]
fn dir_create(path: String) -> HostResult<()> {
    create_dir_impl(&active_root()?, &path)
}

#[tauri::command]
fn fs_move_preview(src: String, dst: String) -> HostResult<MovePreview> {
    move_preview_impl(&active_root()?, &src, &dst)
}

#[tauri::command]
fn fs_move(src: String, dst: String) -> HostResult<MoveResult> {
    move_path_impl(&active_root()?, &src, &dst)
}

#[tauri::command]
fn fs_delete_preview(path: String) -> HostResult<DeletePreview> {
    delete_preview_impl(&active_root()?, &path)
}

#[tauri::command]
fn fs_delete(path: String) -> HostResult<DeleteResult> {
    delete_path_impl(&active_root()?, &path)
}

#[tauri::command]
fn trash_list() -> HostResult<Vec<TrashEntry>> {
    trash_list_impl(&active_root()?)
}

#[tauri::command]
fn trash_restore(trash_id: String, target_path: Option<String>) -> HostResult<RestoreResult> {
    trash_restore_impl(&active_root()?, &trash_id, target_path.as_deref())
}

// --- 文档读写（M1 协议，M2 起改为激活态根） ---

fn root_str() -> HostResult<String> {
    Ok(active_root()?.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_document(relative_path: String) -> HostResult<ReadDocumentResult> {
    read_document_impl(&root_str()?, &relative_path)
}

#[tauri::command]
fn save_document(
    relative_path: String,
    params: SaveDocumentParams,
) -> HostResult<SaveDocumentResult> {
    save_document_impl(&root_str()?, &relative_path, params)
}

#[tauri::command]
fn stat_document(relative_path: String) -> HostResult<StatDocumentResult> {
    stat_document_impl(&root_str()?, &relative_path)
}

#[tauri::command]
fn draft_read(relative_path: String) -> HostResult<DraftInfo> {
    draft_read_impl(&root_str()?, &relative_path)
}

#[tauri::command]
fn draft_write(
    relative_path: String,
    text: String,
    eol: String,
    add_bom: bool,
    source_hash: String,
) -> HostResult<i64> {
    draft_write_impl(
        &root_str()?,
        &relative_path,
        &text,
        &eol,
        add_bom,
        &source_hash,
    )
}

#[tauri::command]
fn draft_discard(relative_path: String) -> HostResult<()> {
    draft_discard_impl(&root_str()?, &relative_path)
}

// HostError 实现 Serialize，Tauri 命令的 Err 会按 §14.1 类型化协议序列化给前端

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            m0_environment,
            workspace_open,
            workspace_close,
            workspace_info,
            workspace_recent_list,
            workspace_recent_forget,
            tree_list,
            tree_filter,
            file_create,
            dir_create,
            fs_move_preview,
            fs_move,
            fs_delete_preview,
            fs_delete,
            trash_list,
            trash_restore,
            read_document,
            save_document,
            stat_document,
            draft_read,
            draft_write,
            draft_discard
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
