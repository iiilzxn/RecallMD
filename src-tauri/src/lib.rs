// Tauri 命令层：薄封装 persistence 模块（设计 §6.2 少量粗粒度有类型命令）。
// M2 起：打开 Workspace 后命令只接受相对路径，根由激活态解析（§6.3）。
pub mod persistence;
pub mod jev;
pub mod speech;

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
    use tauri::Emitter as _;
    let info = open_workspace(&root)?;
    // M9 本地图片：asset 协议 scope 运行时放行当前工作区（配置里 scope 为空，
    // 未打开工作区的进程不暴露任何文件）。forbid 优先于 allow，见 scope::fs 语义。
    let _ = app
        .asset_protocol_scope()
        .allow_directory(&info.root, true);
    // M7：文件监听随工作区启动/关闭（§13.3）；事件推给前端编排同步
    let watch_root = std::path::PathBuf::from(&info.root);
    let emit_app = app.clone();
    crate::persistence::watcher::start(watch_root, move |event, payload| {
        let _ = emit_app.emit(event, payload);
    });
    // 最近列表写应用配置目录（§7.1）；失败不阻塞打开
    if let Some(cfg) = app_config_dir(&app) {
        if let Err(e) = record_recent(&cfg, &info.root, &info.workspace_id) {
            eprintln!("[recallmd] 最近列表更新失败：{e}");
        }
    }
    Ok(info)
}

#[tauri::command]
fn workspace_close(app: tauri::AppHandle) -> HostResult<()> {
    app.state::<std::sync::Arc<speech::SpeechService>>().cancel_all();
    // 收回 asset 协议对旧根的访问（切换工作区后旧根不再可读）
    if let Ok(root) = active_root() {
        let _ = app.asset_protocol_scope().forbid_directory(&root, true);
    }
    // 先停监听再关工作区：关闭期间的文件变化由下次打开的启动枚举核对
    crate::persistence::watcher::stop();
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

// --- 索引与注册表（M4 §12.5） ---

#[tauri::command]
fn commit_index_batch(
    request: crate::persistence::store::dto::CommitIndexBatchRequest,
) -> HostResult<crate::persistence::store::dto::CommitIndexBatchResult> {
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::CommitIndex(Box::new(request)))?
    {
        crate::persistence::store::DbReply::CommitIndex(r) => Ok(*r),
        _ => unreachable!("CommitIndex 应答"),
    }
}

#[tauri::command]
fn registry_read() -> HostResult<crate::persistence::store::dto::RegistrySnapshot> {
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::RegistrySnapshot)?
    {
        crate::persistence::store::DbReply::RegistrySnapshot(s) => Ok(*s),
        _ => unreachable!("RegistrySnapshot 应答"),
    }
}

#[tauri::command]
fn index_complete(operation_id: String) -> HostResult<()> {
    crate::persistence::document::index_complete(&root_str()?, &operation_id)
}

#[tauri::command]
fn recovery_status() -> HostResult<crate::persistence::store::recovery::RecoveryStatus> {
    crate::persistence::workspace::active_recovery().ok_or_else(|| {
        crate::persistence::error::HostError::new(
            crate::persistence::error::WORKSPACE_NOT_OPEN,
            "尚未打开知识库",
        )
    })
}

#[tauri::command]
fn enumerate_md() -> HostResult<Vec<String>> {
    crate::persistence::workspace::enumerate_md(&crate::persistence::workspace::active_root()?)
}

/// "从现在重新开始"：启用历史丢失重建后暂停的块（§12.6 L798）
#[tauri::command]
fn enable_recovered_blocks() -> HostResult<u64> {
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::BulkEnablePaused)?
    {
        crate::persistence::store::DbReply::DocsChanged(n) => Ok(n),
        _ => unreachable!("BulkEnablePaused 应答"),
    }
}

// --- 锚点修复（M4 §9.4 显式用户操作） ---

#[tauri::command]
fn anchor_repair_preview(
    op: crate::persistence::repair::AnchorRepairOp,
) -> HostResult<crate::persistence::repair::AnchorRepairPreview> {
    crate::persistence::repair::anchor_repair_preview(&root_str()?, &op)
}

#[tauri::command]
fn anchor_repair_apply(
    op: crate::persistence::repair::AnchorRepairOp,
    confirmed_new_id: Option<String>,
) -> HostResult<SaveDocumentResult> {
    crate::persistence::repair::anchor_repair_apply(
        &root_str()?,
        &op,
        confirmed_new_id.as_deref(),
    )
}

// --- 备份与恢复（M4 §14.2；UI 入口属 M6，命令先行） ---

#[tauri::command]
fn backup_db_now() -> HostResult<crate::persistence::store::backup::DbBackupEntry> {
    let recallmd =
        crate::persistence::workspace::active_root()?.join(crate::persistence::paths::RECALLMD_DIR);
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::BackupDbNow {
            recallmd_dir: recallmd,
        })?
    {
        crate::persistence::store::DbReply::DbBackup(e) => Ok(*e),
        _ => unreachable!("BackupDbNow 应答"),
    }
}

#[tauri::command]
fn backup_db_list() -> HostResult<Vec<crate::persistence::store::backup::DbBackupEntry>> {
    let recallmd =
        crate::persistence::workspace::active_root()?.join(crate::persistence::paths::RECALLMD_DIR);
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::BackupDbList {
            recallmd_dir: recallmd,
        })?
    {
        crate::persistence::store::DbReply::DbBackupList(l) => Ok(l),
        _ => unreachable!("BackupDbList 应答"),
    }
}

#[tauri::command]
fn backup_db_restore(file_name: String) -> HostResult<crate::persistence::store::DbRestoreResult> {
    let recallmd =
        crate::persistence::workspace::active_root()?.join(crate::persistence::paths::RECALLMD_DIR);
    let store = crate::persistence::workspace::active_store()?;
    match &store {
        // Offline（迁移失败/高版本）：无 worker，走纯文件恢复路径，用户随后重开工作区
        crate::persistence::store::DbHandle::Offline { .. } => {
            crate::persistence::store::restore_db_offline(&recallmd, &file_name)
        }
        online => match online.call(crate::persistence::store::DbAction::RestoreDb {
            recallmd_dir: recallmd,
            file_name,
        })? {
            crate::persistence::store::DbReply::DbRestore(r) => Ok(*r),
            _ => unreachable!("RestoreDb 应答"),
        },
    }
}

#[tauri::command]
fn backup_full(target_dir: String) -> HostResult<crate::persistence::store::backup::FullBackupResult> {
    let root = crate::persistence::workspace::active_root()?;
    let ws_id = crate::persistence::workspace::active_info()
        .map(|i| i.workspace_id)
        .unwrap_or_default();
    let target = std::path::PathBuf::from(&target_dir);
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::BackupFull {
            root_canon: root,
            workspace_id: ws_id,
            target_dir: target,
        })?
    {
        crate::persistence::store::DbReply::FullBackup(r) => Ok(*r),
        _ => unreachable!("BackupFull 应答"),
    }
}

#[tauri::command]
fn backup_full_restore(
    backup_dir: String,
    target_root: String,
) -> HostResult<crate::persistence::store::backup::FullRestoreResult> {
    crate::persistence::store::backup::backup_full_restore(
        &std::path::PathBuf::from(backup_dir),
        &std::path::PathBuf::from(target_root),
    )
}

// --- 复习引擎（M5 §10/§11；算法推进在 TS scheduler，事务在此） ---

#[tauri::command]
fn review_begin(
    block_id: String,
) -> HostResult<crate::persistence::store::review::ReviewBeginResult> {
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::ReviewBegin { block_id })?
    {
        crate::persistence::store::DbReply::ReviewBegin(r) => Ok(*r),
        _ => unreachable!("ReviewBegin 应答"),
    }
}

#[tauri::command]
fn learning_begin(
    block_id: String,
) -> HostResult<crate::persistence::store::review::ReviewBeginResult> {
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::LearningBegin { block_id })?
    {
        crate::persistence::store::DbReply::ReviewBegin(r) => Ok(*r),
        _ => unreachable!("LearningBegin 应答"),
    }
}

#[tauri::command]
fn learning_queue(
    page_size: Option<i64>,
) -> HostResult<crate::persistence::store::review::ReviewQueueResult> {
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::LearningQueue { page_size })?
    {
        crate::persistence::store::DbReply::ReviewQueue(r) => Ok(*r),
        _ => unreachable!("LearningQueue 应答"),
    }
}

#[tauri::command]
fn review_submit(
    request: crate::persistence::store::review::SubmitReviewRequest,
) -> HostResult<crate::persistence::store::review::SubmitReviewResult> {
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::ReviewSubmit(Box::new(request)))?
    {
        crate::persistence::store::DbReply::ReviewSubmit(r) => Ok(*r),
        _ => unreachable!("ReviewSubmit 应答"),
    }
}

#[tauri::command]
fn review_queue(
    page_size: Option<i64>,
) -> HostResult<crate::persistence::store::review::ReviewQueueResult> {
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::ReviewQueue { page_size })?
    {
        crate::persistence::store::DbReply::ReviewQueue(r) => Ok(*r),
        _ => unreachable!("ReviewQueue 应答"),
    }
}

#[tauri::command]
fn review_set_participation(block_ids: Vec<String>, action: String) -> HostResult<u64> {
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::ReviewSetParticipation {
            block_ids,
            action,
        })?
    {
        crate::persistence::store::DbReply::ReviewCount(n) => Ok(n),
        _ => unreachable!("ReviewSetParticipation 应答"),
    }
}

#[tauri::command]
fn review_reset_block(
    block_id: String,
) -> HostResult<crate::persistence::store::review::ResetBlockResult> {
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::ReviewResetBlock { block_id })?
    {
        crate::persistence::store::DbReply::ReviewReset(r) => Ok(*r),
        _ => unreachable!("ReviewResetBlock 应答"),
    }
}

// --- 复习 UI 支撑（M6 §16） ---

#[tauri::command]
fn review_stats() -> HostResult<crate::persistence::store::review::ReviewStatsResult> {
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::ReviewStats)?
    {
        crate::persistence::store::DbReply::ReviewStats(r) => Ok(*r),
        _ => unreachable!("ReviewStats 应答"),
    }
}

#[tauri::command]
fn app_config_read() -> HostResult<crate::persistence::store::review::AppConfigDto> {
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::AppConfigRead)?
    {
        crate::persistence::store::DbReply::AppConfig(c) => Ok(*c),
        _ => unreachable!("AppConfigRead 应答"),
    }
}

#[tauri::command]
fn app_config_set(key: String, value: String) -> HostResult<()> {
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::AppConfigSet { key, value })?
    {
        crate::persistence::store::DbReply::Ack => Ok(()),
        _ => unreachable!("AppConfigSet 应答"),
    }
}

#[tauri::command]
fn review_set_prompt(block_id: String, prompt: Option<String>) -> HostResult<()> {
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::ReviewSetPrompt { block_id, prompt })?
    {
        crate::persistence::store::DbReply::Ack => Ok(()),
        _ => unreachable!("ReviewSetPrompt 应答"),
    }
}

/// M7：编辑器冲突进入/解除时标记文档索引状态（CONFLICT 挡评，§13.4 L901）
#[tauri::command]
fn mark_doc_status(relative: String, status: String) -> HostResult<u64> {
    match crate::persistence::workspace::active_store()?
        .call(crate::persistence::store::DbAction::MarkDocStatus { relative, status })?
    {
        crate::persistence::store::DbReply::DocsChanged(n) => Ok(n),
        _ => unreachable!("MarkDocStatus 应答"),
    }
}

// --- M7：定期核对（§13.3 L885；纯文件系统，不经 DB 线程） ---

#[tauri::command]
fn audit_quick() -> HostResult<Vec<crate::persistence::audit::AuditStatDto>> {
    crate::persistence::audit::audit_quick(&crate::persistence::workspace::active_root()?)
}

#[tauri::command]
fn audit_hash_batch(
    offset: usize,
    limit: usize,
) -> HostResult<crate::persistence::audit::AuditHashWindowDto> {
    crate::persistence::audit::audit_hash_batch(&crate::persistence::workspace::active_root()?, offset, limit)
}

// HostError 实现 Serialize，Tauri 命令的 Err 会按 §14.1 类型化协议序列化给前端

fn jev_config_dir(app: &tauri::AppHandle) -> HostResult<std::path::PathBuf> {
    app.path().app_config_dir().map_err(|_| crate::persistence::error::HostError::new("JEV_CONFIG_ERROR", "无法访问应用配置目录"))
}

#[tauri::command]
fn jev_config_read(app: tauri::AppHandle) -> HostResult<jev::ConfigStatus> {
    jev::config_status(&jev_config_dir(&app)?)
}

#[tauri::command]
fn jev_config_save(app: tauri::AppHandle, enabled: bool, api_key: Option<String>) -> HostResult<jev::ConfigStatus> {
    jev::save_config(&jev_config_dir(&app)?, enabled, api_key)
}

#[tauri::command]
fn jev_key_clear(app: tauri::AppHandle) -> HostResult<jev::ConfigStatus> {
    jev::clear_key(&jev_config_dir(&app)?)
}

#[tauri::command]
fn review_rubric_read(block_id: String) -> HostResult<crate::persistence::store::rubric::Rubric> {
    use crate::persistence::store::{DbAction, DbReply};
    match crate::persistence::workspace::active_store()?.call(DbAction::RubricRead { block_id })? {
        DbReply::Rubric(r) => Ok(r), _ => unreachable!("RubricRead 应答"),
    }
}

#[tauri::command]
fn review_rubric_save(token: String, points: Vec<String>) -> HostResult<crate::persistence::store::review::ReviewBeginResult> {
    use crate::persistence::store::{DbAction, DbReply};
    match crate::persistence::workspace::active_store()?.call(DbAction::RubricSave { token, points })? {
        DbReply::ReviewBegin(begin) => Ok(*begin), _ => unreachable!("RubricSave 应答"),
    }
}

#[tauri::command]
async fn jev_grade(app: tauri::AppHandle, token: String, answer: String) -> HostResult<jev::GradeResult> {
    use crate::persistence::store::{DbAction, DbReply};
    let store = crate::persistence::workspace::active_store()?;
    let context = match store.call(DbAction::JevGradeContext { token: token.clone() })? {
        DbReply::JevGradeContext(c) => c, _ => unreachable!("JevGradeContext 应答"),
    };
    let result = jev::grade(&jev_config_dir(&app)?, &context, &answer).await?;
    // 请求期间标准/题面/参与状态改变，旧结果不可用于当前题。
    store.call(DbAction::JevGradeContext { token })?;
    Ok(result)
}

#[tauri::command]
fn note_rubrics_read(relative_path: String, expected_hash: String) -> HostResult<Vec<crate::persistence::store::rubric::NoteRubric>> {
    use crate::persistence::store::{DbAction, DbReply};
    match crate::persistence::workspace::active_store()?.call(DbAction::NoteRubricsRead { relative_path, expected_hash })? {
        DbReply::NoteRubrics(entries) => Ok(entries), _ => unreachable!("NoteRubricsRead 应答"),
    }
}

#[tauri::command]
fn note_rubric_save(request: crate::persistence::store::rubric::SaveNoteRubric) -> HostResult<crate::persistence::store::rubric::NoteRubric> {
    use crate::persistence::store::{DbAction, DbReply};
    // 外部编辑可能尚未被 watcher 同步，保存元数据前也要核对磁盘版本。
    let stat = stat_document_impl(&root_str()?, &request.relative_path)?;
    if stat.raw_byte_hash.as_deref() != Some(request.expected_hash.as_str()) {
        return Err(crate::persistence::error::HostError::new("JEV_NOTE_STALE", "笔记原文已变化，请重新打开笔记后编辑得分点"));
    }
    match crate::persistence::workspace::active_store()?.call(DbAction::NoteRubricSave(request))? {
        DbReply::NoteRubric(entry) => Ok(entry), _ => unreachable!("NoteRubricSave 应答"),
    }
}

fn speech_paths(app: &tauri::AppHandle) -> HostResult<(std::path::PathBuf, std::path::PathBuf)> {
    let config = app.path().app_config_dir().map_err(|_| crate::persistence::error::HostError::new("SPEECH_CONFIG", "无法获取语音设置目录"))?;
    let mut models = app.path().app_local_data_dir().map_err(|_| crate::persistence::error::HostError::new("SPEECH_CONFIG", "无法获取本地模型目录"))?.join("speech-models");
    if cfg!(debug_assertions) {
        let prepared = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../speech-lab.local/models");
        if prepared.is_dir() { models = prepared.canonicalize().unwrap_or(prepared); }
    }
    Ok((config, models))
}
#[tauri::command]
fn speech_config_read(app: tauri::AppHandle) -> HostResult<speech::ConfigStatus> { let (dir, root) = speech_paths(&app)?; speech::config_status(&dir, &root) }
#[tauri::command]
fn speech_config_save(config: speech::SavedConfig, app: tauri::AppHandle) -> HostResult<speech::ConfigStatus> { let (dir, root) = speech_paths(&app)?; speech::save_config(&dir, &root, config) }
#[tauri::command]
fn speech_devices() -> HostResult<Vec<String>> { speech::devices() }
#[tauri::command]
async fn speech_start(session_id: String, app: tauri::AppHandle) -> HostResult<speech::CaptureStatus> {
    let (dir, root) = speech_paths(&app)?;
    let config = speech::read_config(&dir, &root)?;
    let service = app.state::<std::sync::Arc<speech::SpeechService>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.start(session_id, config)).await
        .map_err(|_| crate::persistence::error::HostError::new("SPEECH_START", "录音启动失败，请重试"))?
}
#[tauri::command]
fn speech_status(session_id: String, app: tauri::AppHandle) -> HostResult<speech::CaptureStatus> { app.state::<std::sync::Arc<speech::SpeechService>>().status(&session_id) }
#[tauri::command]
async fn speech_stop(session_id: String, app: tauri::AppHandle) -> HostResult<speech::Transcript> {
    let service = app.state::<std::sync::Arc<speech::SpeechService>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.stop(&session_id)).await
        .map_err(|_| crate::persistence::error::HostError::new("SPEECH_DECODE", "本地转写失败，请重试或切换模型"))?
}
#[tauri::command]
fn speech_cancel(session_id: String, app: tauri::AppHandle) { app.state::<std::sync::Arc<speech::SpeechService>>().cancel(&session_id); }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(std::sync::Arc::new(speech::SpeechService::default()))
        .on_window_event(|window, event| { if matches!(event, tauri::WindowEvent::Destroyed) { window.state::<std::sync::Arc<speech::SpeechService>>().cancel_all(); } })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            m0_environment,
            speech_config_read,
            speech_config_save,
            speech_devices,
            speech_start,
            speech_status,
            speech_stop,
            speech_cancel,
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
            draft_discard,
            commit_index_batch,
            registry_read,
            index_complete,
            recovery_status,
            enumerate_md,
            enable_recovered_blocks,
            anchor_repair_preview,
            anchor_repair_apply,
            backup_db_now,
            backup_db_list,
            backup_db_restore,
            backup_full,
            backup_full_restore,
            review_begin,
            learning_begin,
            learning_queue,
            review_submit,
            review_queue,
            review_set_participation,
            review_reset_block,
            review_stats,
            app_config_read,
            app_config_set,
            jev_config_read,
            jev_config_save,
            jev_key_clear,
            review_rubric_read,
            review_rubric_save,
            note_rubrics_read,
            note_rubric_save,
            jev_grade,
            review_set_prompt,
            mark_doc_status,
            audit_quick,
            audit_hash_batch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
