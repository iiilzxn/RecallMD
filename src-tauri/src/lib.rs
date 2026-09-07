// 集成测试直接调用持久化函数验证协议（§18 M1 验收）
pub mod persistence;

use serde::Serialize;

use crate::persistence::document::{
    draft_discard, draft_read, draft_write, read_document, save_document, stat_document,
    DraftInfo, ReadDocumentResult, SaveDocumentParams, SaveDocumentResult, StatDocumentResult,
};
use crate::persistence::error::HostResult;

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

// --- M1 命令（camelCase 参数由 serde 统一转换） ---

#[tauri::command]
fn m1_read_document(root: String, relative_path: String) -> HostResult<ReadDocumentResult> {
    read_document(&root, &relative_path)
}

#[tauri::command]
fn m1_save_document(
    root: String,
    relative_path: String,
    params: SaveDocumentParams,
) -> HostResult<SaveDocumentResult> {
    save_document(&root, &relative_path, params)
}

#[tauri::command]
fn m1_stat_document(root: String, relative_path: String) -> HostResult<StatDocumentResult> {
    stat_document(&root, &relative_path)
}

#[tauri::command]
fn m1_draft_read(root: String, relative_path: String) -> HostResult<DraftInfo> {
    draft_read(&root, &relative_path)
}

#[tauri::command]
fn m1_draft_write(
    root: String,
    relative_path: String,
    text: String,
    eol: String,
    add_bom: bool,
    source_hash: String,
) -> HostResult<i64> {
    draft_write(&root, &relative_path, &text, &eol, add_bom, &source_hash)
}

#[tauri::command]
fn m1_draft_discard(root: String, relative_path: String) -> HostResult<()> {
    draft_discard(&root, &relative_path)
}

// HostError 实现 Serialize，Tauri 命令的 Err 会按 §14.1 类型化协议序列化给前端

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            m0_environment,
            m1_read_document,
            m1_save_document,
            m1_stat_document,
            m1_draft_read,
            m1_draft_write,
            m1_draft_discard
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
