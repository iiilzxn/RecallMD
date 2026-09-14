//! SQLite 元数据存储（设计 §6.2/§12）：rusqlite bundled 引擎，专用数据库工作线程
//! 持唯一连接，读写请求经邮箱排队；SQL 与事务集中在 store 模块。
//!
//! boot 顺序（worker 线程内，§14.3）：开连接 → PRAGMA → 引擎版本 → quick_check →
//! 迁移 → 身份核对（Workspace 行 vs manifest；错配=隔离重建）→ 每日备份 →
//! 操作日志恢复扫描。损坏吸收为隔离+重建；高版本/迁移失败 → Offline。
//!
//! 测试绕开线程直调 `*_on(conn)` 内层函数；Tauri 命令经 `DbHandle::call`。

pub mod backup;
pub mod commit;
pub mod dto;
pub mod fsrs;
pub mod migrate;
pub mod ops;
pub mod query;
pub mod recovery;
pub mod review;
pub mod schema;

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use rusqlite::Connection;

use super::error::{HostError, HostResult, DB_BUSY, DB_CORRUPT, IO_ERROR};
use backup::{DbBackupEntry, FullBackupResult};
use commit::commit_on;
use dto::{CommitIndexBatchRequest, CommitIndexBatchResult, RegistrySnapshot};
use query::{registry_snapshot_on, RegistryQuery};
use recovery::{RecoveryStatus, MODE_QUARANTINED_CORRUPT, MODE_REBUILT_NO_HISTORY};
use review::{
    AppConfigDto, ResetBlockResult, ReviewBeginResult, ReviewQueueResult, ReviewStatsResult,
    ReviewTokens, SubmitReviewRequest, SubmitReviewResult,
};

pub const METADATA_DB: &str = "metadata.sqlite";

/// 可信时钟（§12.1：时间由同次操作的可信时钟值显式写入；TS 不传时间）
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// rusqlite 错误 → §14.1 错误码（损坏/忙/其他）。
/// 调用方上下文需要不同码时（如索引事务内的约束失败）自行包装。
pub fn map_sqlite_error(err: &rusqlite::Error, ctx: &str) -> HostError {
    match err {
        // SQLITE_CORRUPT=11 / SQLITE_NOTADB=26；rusqlite 0.40 的 ErrorCode
        // 无独立 NotADB 变体，按扩展码判定
        rusqlite::Error::SqliteFailure(e, _)
            if e.extended_code == 11 || e.extended_code == 26 =>
        {
            HostError::new(DB_CORRUPT, format!("数据库损坏（{ctx}）"))
        }
        // SQLITE_BUSY=5 / SQLITE_LOCKED=6
        rusqlite::Error::SqliteFailure(e, _) if e.extended_code == 5 || e.extended_code == 6 => {
            HostError::new(DB_BUSY, format!("数据库忙（{ctx}）")).retryable()
        }
        other => HostError::new(IO_ERROR, format!("{ctx}：{other}")),
    }
}

/// 每连接 PRAGMA（§12.1：foreign_keys/journal_mode/synchronous/busy_timeout）
pub fn apply_pragmas(conn: &Connection) -> HostResult<()> {
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| map_sqlite_error(&e, "foreign_keys"))?;
    // journal_mode 返回行，须 query_row（M0 已验证）
    let _mode: String = conn
        .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
        .map_err(|e| map_sqlite_error(&e, "journal_mode"))?;
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(|e| map_sqlite_error(&e, "synchronous"))?;
    conn.pragma_update(None, "busy_timeout", 5000)
        .map_err(|e| map_sqlite_error(&e, "busy_timeout"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 工作线程与邮箱
// ---------------------------------------------------------------------------

/// DB 动作请求
pub enum DbAction {
    /// 索引批量提交（§12.5 单事务 + CAS）
    CommitIndex(Box<CommitIndexBatchRequest>),
    /// 注册表快照（reconcile 输入）
    RegistrySnapshot,
    /// 应用内移动后的 DB 随批（M2 fs_move 调用）
    DocumentsMoved { entries: Vec<(String, String)> },
    /// 应用内删除（→ trash）后的 DB 随批
    DocumentsDeleted { src_relative: String },
    /// trash 恢复后的 DB 随批
    DocumentsRestored { relative: String },
    /// "从现在重新开始"：启用全部 PAUSED 块并清除恢复模式（§12.6 L798 用户明确选择）
    BulkEnablePaused,
    /// 立即做一份验证过的日备（测试/设置页）
    BackupDbNow { recallmd_dir: PathBuf },
    /// 列出日备
    BackupDbList { recallmd_dir: PathBuf },
    /// 从日备恢复（换连接：唯一能替换 worker 持有连接的动作）
    RestoreDb {
        recallmd_dir: PathBuf,
        file_name: String,
    },
    /// 完整 Workspace 备份（运行在 worker 上自然暂停其他 DB 写，§14.2.5）
    BackupFull {
        root_canon: PathBuf,
        workspace_id: String,
        target_dir: PathBuf,
    },
    /// M5：题面揭示——核验可评分并签发复习令牌（§10.4）
    ReviewBegin { block_id: String },
    /// M5：评分提交（单事务：幂等/令牌 CAS/时钟/配额/双事件）
    ReviewSubmit(Box<SubmitReviewRequest>),
    /// M5：到期队列（分组 + 配额）
    ReviewQueue { page_size: Option<i64> },
    /// M5：参与策略（PAUSE/RESUME/EXCLUDE/INCLUDE）
    ReviewSetParticipation {
        block_ids: Vec<String>,
        action: String,
    },
    /// M5：单独重置（§10.3）
    ReviewResetBlock { block_id: String },
    /// M6：简版统计（仅 RATE 计数）
    ReviewStats,
    /// M6：应用配置读（白名单键）
    AppConfigRead,
    /// M6：应用配置写（白名单键：review.daily_new_limit / editor.autosave）
    AppConfigSet { key: String, value: String },
    /// M6：块回忆提示（§5.2）
    ReviewSetPrompt {
        block_id: String,
        prompt: Option<String>,
    },
    /// 关闭工作线程（close_workspace 调用）
    Shutdown,
}

impl DbAction {
    fn timeout(&self) -> Duration {
        match self {
            DbAction::CommitIndex(_) => Duration::from_secs(30),
            DbAction::RegistrySnapshot => Duration::from_secs(15),
            DbAction::DocumentsMoved { .. }
            | DbAction::DocumentsDeleted { .. }
            | DbAction::DocumentsRestored { .. }
            | DbAction::BulkEnablePaused => Duration::from_secs(30),
            DbAction::BackupDbNow { .. } | DbAction::BackupDbList { .. } => {
                Duration::from_secs(60)
            }
            DbAction::RestoreDb { .. } => Duration::from_secs(300),
            DbAction::BackupFull { .. } => Duration::from_secs(15 * 60),
            DbAction::ReviewBegin { .. }
            | DbAction::ReviewQueue { .. }
            | DbAction::ReviewSetParticipation { .. }
            | DbAction::ReviewResetBlock { .. }
            | DbAction::ReviewStats
            | DbAction::AppConfigRead
            | DbAction::AppConfigSet { .. }
            | DbAction::ReviewSetPrompt { .. } => Duration::from_secs(15),
            DbAction::ReviewSubmit(_) => Duration::from_secs(30),
            DbAction::Shutdown => Duration::from_secs(10),
        }
    }
}

#[derive(Debug)]
pub enum DbReply {
    CommitIndex(Box<CommitIndexBatchResult>),
    RegistrySnapshot(Box<RegistrySnapshot>),
    DocsChanged(u64),
    DbBackup(Box<DbBackupEntry>),
    DbBackupList(Vec<DbBackupEntry>),
    DbRestore(Box<DbRestoreResult>),
    FullBackup(Box<FullBackupResult>),
    ReviewBegin(Box<ReviewBeginResult>),
    ReviewSubmit(Box<SubmitReviewResult>),
    ReviewQueue(Box<ReviewQueueResult>),
    ReviewCount(u64),
    ReviewReset(Box<ResetBlockResult>),
    ReviewStats(Box<ReviewStatsResult>),
    AppConfig(Box<AppConfigDto>),
    Ack,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbRestoreResult {
    pub restored_from: String,
    pub quarantined_to: Option<String>,
    pub documents_pending: u64,
}

pub struct DbJob {
    pub action: DbAction,
    pub reply: mpsc::Sender<HostResult<DbReply>>,
}

/// 库句柄：Online = 工作线程活着；Offline = 元数据只读（高版本 schema/迁移失败，
/// §14.3 L965），正文读写不受影响。backup_db_restore 在 Offline 下仍可用（恢复路径）。
#[derive(Clone)]
pub enum DbHandle {
    Online { tx: mpsc::Sender<DbJob> },
    Offline { reason: HostError },
}

impl DbHandle {
    pub fn call(&self, action: DbAction) -> HostResult<DbReply> {
        match self {
            // Offline = 工作线程未运行：一律以原因拒绝；备份恢复由
            // restore_db_offline（纯文件操作）承接，随后用户重开工作区
            DbHandle::Offline { reason } => Err(reason.clone()),
            DbHandle::Online { tx } => {
                let timeout = action.timeout();
                let (reply_tx, reply_rx) = mpsc::channel();
                tx.send(DbJob {
                    action,
                    reply: reply_tx,
                })
                .map_err(|_| HostError::new(IO_ERROR, "数据库线程已退出"))?;
                match reply_rx.recv_timeout(timeout) {
                    Ok(result) => result,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        Err(HostError::new(
                            DB_BUSY,
                            "数据库操作超时（长任务进行中，请稍后重试）",
                        )
                        .retryable())
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        Err(HostError::new(IO_ERROR, "数据库线程已退出"))
                    }
                }
            }
        }
    }
}

/// 打开结果汇报（§14.3 启动顺序的 DB 检查阶段产出）
#[derive(Debug, Clone)]
pub struct OpenReport {
    /// Workspace 行确定的库身份（manifest 丢失时可与之对齐，§7.1 L186）
    pub effective_workspace_id: String,
    pub sqlite_version: String,
    /// Offline 原因（None = Online）
    pub offline_reason: Option<HostError>,
    pub recovery: RecoveryStatus,
}

pub struct StoreOpenOutcome {
    pub handle: DbHandle,
    pub report: OpenReport,
    /// 工作线程句柄（close 时 join，保证文件句柄确定释放；Offline 为 None）
    pub join: Option<std::thread::JoinHandle<()>>,
}

/// 打开（或创建）`.recallmd/metadata.sqlite` 并启动工作线程。
/// DB 内容问题不使打开失败：损坏/身份错配 → 隔离+重建（原样保留原件）；
/// 高版本 schema/迁移失败 → Offline。
pub fn open_store(
    recallmd_dir: &Path,
    workspace_id: Option<&str>,
    workspace_name: &str,
) -> StoreOpenOutcome {
    let db_path = recallmd_dir.join(METADATA_DB);
    let (boot_tx, boot_rx) = mpsc::channel::<HostResult<OpenReport>>();
    let (job_tx, job_rx) = mpsc::channel::<DbJob>();

    let ws_id = workspace_id.map(str::to_string);
    let ws_name = workspace_name.to_string();
    let recallmd = recallmd_dir.to_path_buf();
    let spawn = std::thread::Builder::new()
        .name("recallmd-db".into())
        .spawn(move || {
            let booted = boot(&recallmd, &db_path, ws_id.as_deref(), &ws_name);
            match booted {
                Ok((conn, report)) => {
                    // 先回执再进循环：open_store 拿到报告，连接留在本线程
                    let _ = boot_tx.send(Ok(report));
                    worker_loop(job_rx, conn);
                }
                Err(reason) => {
                    let _ = boot_tx.send(Err(reason));
                }
            }
        });

    let fallback = |reason: HostError| StoreOpenOutcome {
        handle: DbHandle::Offline {
            reason: reason.clone(),
        },
        report: OpenReport {
            effective_workspace_id: workspace_id.unwrap_or("").to_string(),
            sqlite_version: String::new(),
            offline_reason: Some(reason),
            recovery: RecoveryStatus::default(),
        },
        join: None,
    };

    let spawn = match spawn {
        Ok(j) => j,
        Err(_) => return fallback(HostError::new(IO_ERROR, "无法启动数据库线程")),
    };
    match boot_rx.recv_timeout(Duration::from_secs(60)) {
        Ok(Ok(report)) => StoreOpenOutcome {
            handle: DbHandle::Online { tx: job_tx },
            report,
            join: Some(spawn),
        },
        Ok(Err(reason)) => {
            let _ = spawn.join();
            fallback(reason)
        }
        Err(_) => {
            let _ = spawn.join();
            fallback(HostError::new(IO_ERROR, "数据库线程启动超时"))
        }
    }
}

// ---------------------------------------------------------------------------
// boot（worker 线程内）
// ---------------------------------------------------------------------------

fn open_checked(db_path: &Path) -> HostResult<(Connection, String)> {
    let conn = Connection::open(db_path).map_err(|e| map_sqlite_error(&e, "打开元数据库"))?;
    // 早期损坏探测：NOTADB/CORRUPT 在首个 schema 读入即暴露（0xFF 头、截断文件）；
    // 全新 0 字节文件读 sqlite_master 返回 0 行 = 合法空库
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
        r.get::<_, i64>(0)
    })
    .map_err(|e| map_sqlite_error(&e, "元数据库 schema 探测"))?;
    apply_pragmas(&conn)?;
    let (ok, version) = schema::sqlite_version_ok(&conn)?;
    if !ok {
        return Err(HostError::new(
            DB_CORRUPT,
            format!("bundled SQLite {version} 低于要求的最低版本"),
        ));
    }
    if !schema::quick_check_ok(&conn)? {
        return Err(schema::corrupt_error("启动 quick_check"));
    }
    Ok((conn, version))
}

/// 隔离后全新重建（原件保留；§12.6）
fn rebuild_db(
    recallmd: &Path,
    db_path: &Path,
    manifest_id: Option<&str>,
    name: &str,
    mode: &str,
    recovery: &mut RecoveryStatus,
) -> HostResult<Connection> {
    let quarantined = recovery::quarantine_db(recallmd, mode)?;
    recovery.quarantined_to = Some(quarantined.to_string_lossy().into_owned());
    recovery.rebuilt = true;
    recovery.recovery_mode = Some(mode.to_string());

    let mut conn = Connection::open(db_path).map_err(|e| map_sqlite_error(&e, "重建元数据库"))?;
    apply_pragmas(&conn)?;
    migrate::run(&mut conn, &|_| Ok(()))?;
    schema::ensure_workspace_row(&conn, manifest_id, name, now_ms())?;
    query::settings_set_string(&conn, "recovery.mode", mode, now_ms())?;
    query::settings_set_string(
        &conn,
        "recovery.quarantined_at",
        &now_ms().to_string(),
        now_ms(),
    )?;
    Ok(conn)
}

fn boot(
    recallmd: &Path,
    db_path: &Path,
    manifest_id: Option<&str>,
    name: &str,
) -> HostResult<(Connection, OpenReport)> {
    let mut recovery = RecoveryStatus::default();
    let backups_root = recallmd.join("backups");

    let (conn, version) = match open_checked(db_path) {
        Ok(pair) => pair,
        Err(e) if e.code == DB_CORRUPT => {
            // 损坏：吸收为隔离+重建（§12.6；open_store 不因此失败）
            let rebuilt = rebuild_db(
                recallmd,
                db_path,
                manifest_id,
                name,
                MODE_QUARANTINED_CORRUPT,
                &mut recovery,
            )?;
            let version = version_of(&rebuilt);
            return Ok((
                rebuilt,
                OpenReport {
                    effective_workspace_id: manifest_id.unwrap_or("").to_string(),
                    sqlite_version: version,
                    offline_reason: None,
                    recovery,
                },
            ));
        }
        Err(e) => return Err(e), // Offline：迁移高版本/失败、磁盘
    };
    let mut conn = conn;

    // 迁移（迁移前备份钩子 → backups/premigration）
    let migrated = migrate::run(&mut conn, &|c| backup::premigration_backup(c, &backups_root))?;
    recovery.migrated = !migrated.applied.is_empty();

    // 身份核对：Workspace 行 vs manifest（§7.1 L186：manifest 丢失可从行恢复；
    // 错配 = 库拷贝混用 → 隔离重建，不静默收养外来历史）
    let existing_row: Option<String> = conn
        .query_row(
            "SELECT workspace_id FROM Workspace WHERE singleton = 1",
            [],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
        .map_err(|e| map_sqlite_error(&e, "读取 Workspace 行"))?;

    let effective_id = match (&existing_row, manifest_id) {
        (None, mid) => {
            // 全新库：manifest 在 = 库曾存在、DB 已丢 → 历史丢失模式（§12.6）
            let id = schema::ensure_workspace_row(&conn, mid, name, now_ms())?;
            if mid.is_some() {
                recovery.rebuilt = true;
                recovery.recovery_mode = Some(MODE_REBUILT_NO_HISTORY.to_string());
                query::settings_set_string(
                    &conn,
                    "recovery.mode",
                    MODE_REBUILT_NO_HISTORY,
                    now_ms(),
                )?;
            }
            id
        }
        (Some(row_id), Some(mid)) if row_id == mid => {
            schema::ensure_workspace_row(&conn, Some(mid), name, now_ms())?
        }
        (Some(row_id), None) => {
            // manifest 丢失：Workspace 行恢复身份
            schema::ensure_workspace_row(&conn, Some(row_id), name, now_ms())?
        }
        (Some(_), Some(_)) => {
            // 错配：隔离重建，身份取 manifest（不静默收养外来历史）
            conn.close().map_err(|(_, e)| map_sqlite_error(&e, "关闭连接"))?;
            let conn = rebuild_db(
                recallmd,
                db_path,
                manifest_id,
                name,
                MODE_REBUILT_NO_HISTORY,
                &mut recovery,
            )?;
            return Ok((
                conn,
                OpenReport {
                    effective_workspace_id: manifest_id.unwrap_or("").to_string(),
                    sqlite_version: version,
                    offline_reason: None,
                    recovery,
                },
            ));
        }
    };

    // 每日备份（重建路径不备份空库）
    match backup::daily_backup_if_due(&conn, &backups_root) {
        Ok(took) => recovery.backup_taken = took,
        Err(e) => recovery.warnings.push(format!("每日备份未完成：{e}")),
    }

    // 操作日志恢复扫描（§13.2 启动表）
    let root_canon = recallmd.parent().unwrap_or(Path::new(".")).to_path_buf();
    match recovery::scan_operations(&mut conn, recallmd, &root_canon) {
        Ok(scan) => {
            recovery.stale_documents = scan.stale_documents;
            recovery.warnings.extend(scan.warnings);
        }
        Err(e) => recovery.warnings.push(format!("操作日志扫描失败：{e}")),
    }

    Ok((
        conn,
        OpenReport {
            effective_workspace_id: effective_id,
            sqlite_version: version,
            offline_reason: None,
            recovery,
        },
    ))
}

fn version_of(conn: &Connection) -> String {
    schema::sqlite_version_ok(conn)
        .map(|(_, v)| v)
        .unwrap_or_default()
}

/// Offline 兜底恢复（boot 失败、无 worker）：验证候选 → 隔离 → 复制。
/// 不碰任何打开的连接（boot 失败时线程已退出）；完成后用户重开工作区走正常迁移。
pub fn restore_db_offline(recallmd: &Path, file_name: &str) -> HostResult<DbRestoreResult> {
    let candidate = recallmd
        .join("backups")
        .join(backup::BACKUP_DB_DIR)
        .join(file_name);
    if !candidate.exists() {
        return Err(HostError::new(
            super::error::FILE_NOT_FOUND,
            "备份文件不存在",
        )
        .with_path(file_name));
    }
    backup::verify_backup_file(&candidate)?;
    let quarantined = recovery::quarantine_db(recallmd, "restore-offline")?;
    std::fs::copy(&candidate, recallmd.join(METADATA_DB))
        .map_err(|e| HostError::new(IO_ERROR, format!("复制备份失败：{e}")))?;
    Ok(DbRestoreResult {
        restored_from: file_name.to_string(),
        quarantined_to: Some(quarantined.to_string_lossy().into_owned()),
        // 重开工作区时 boot 会全量核对；此处 0 仅表示本轮未统计
        documents_pending: 0,
    })
}

// ---------------------------------------------------------------------------
// 工作循环
// ---------------------------------------------------------------------------

fn worker_loop(job_rx: mpsc::Receiver<DbJob>, conn: Connection) {
    let mut conn = conn;
    // M5 复习令牌表：worker 线程独占（§10.4 进程内令牌；worker 生命周期=工作区会话）
    let mut tokens = ReviewTokens::default();
    while let Ok(job) = job_rx.recv() {
        let DbJob { action, reply } = job;
        if matches!(action, DbAction::Shutdown) {
            let _ = reply.send(Ok(DbReply::Ack));
            break;
        }
        // RestoreDb 换库：按值持连接，在 dispatch 之外处理
        if let DbAction::RestoreDb {
            ref recallmd_dir,
            ref file_name,
        } = action
        {
            let taken = std::mem::replace(
                &mut conn,
                Connection::open_in_memory().expect("恢复占位连接"),
            );
            let outcome: (HostResult<DbReply>, Connection) =
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                    restore_db(taken, recallmd_dir, file_name)
                })) {
                    Ok(r) => r,
                    // panic 时原连接不可回收：占位库顶替，用户重开工作区即恢复正确状态
                    Err(_) => (
                        Err(HostError::new(
                            IO_ERROR,
                            "数据库恢复内部错误（panic 已捕获，请重开知识库）",
                        )),
                        Connection::open_in_memory().expect("恢复占位连接"),
                    ),
                };
            conn = outcome.1;
            let _ = reply.send(outcome.0);
            continue;
        }
        // 单线程持有连接；panic 捕获避免调用方悬挂（§14.1 有界重试）
        let result = {
            let c = &mut conn;
            let t = &mut tokens;
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                dispatch(c, t, action)
            })) {
                Ok(r) => r,
                Err(_) => Err(HostError::new(
                    IO_ERROR,
                    "数据库线程内部错误（panic 已捕获，请重试）",
                )),
            }
        };
        if reply.send(result).is_err() {
            break; // 调用方已放弃
        }
    }
}

/// 分发到各内层同步函数（所有 SQL 只经此处进入连接）
fn dispatch(conn: &mut Connection, tokens: &mut ReviewTokens, action: DbAction) -> HostResult<DbReply> {
    match action {
        DbAction::CommitIndex(req) => {
            let result = commit_on(conn, &req)?;
            Ok(DbReply::CommitIndex(Box::new(result)))
        }
        DbAction::RegistrySnapshot => {
            let snap = registry_snapshot_on(conn, &RegistryQuery::default())?;
            Ok(DbReply::RegistrySnapshot(Box::new(snap)))
        }
        DbAction::DocumentsMoved { entries } => {
            let n = ops::documents_moved(conn, &entries, now_ms())?;
            Ok(DbReply::DocsChanged(n))
        }
        DbAction::DocumentsDeleted { src_relative } => {
            let n = ops::documents_deleted(conn, &src_relative, now_ms())?;
            Ok(DbReply::DocsChanged(n))
        }
        DbAction::DocumentsRestored { relative } => {
            let n = ops::documents_restored(conn, &relative, now_ms())?;
            Ok(DbReply::DocsChanged(n))
        }
        DbAction::BulkEnablePaused => {
            let n = conn
                .execute(
                    "UPDATE ReviewState SET participation = 'ENABLED', updated_at = ?1 \
                     WHERE participation = 'PAUSED'",
                    rusqlite::params![now_ms()],
                )
                .map_err(|e| map_sqlite_error(&e, "批量启用"))? as u64;
            query::settings_set_string(conn, "recovery.mode", "CLEARED", now_ms())?;
            Ok(DbReply::DocsChanged(n))
        }
        DbAction::BackupDbNow { recallmd_dir } => {
            let dir = recallmd_dir
                .join("backups")
                .join(backup::BACKUP_DB_DIR);
            let path = backup::create_verified_backup(conn, &dir)?;
            backup::rotate_backups(&dir, backup::KEEP_DAILY)?;
            let meta = std::fs::metadata(&path)
                .map_err(|e| HostError::new(IO_ERROR, format!("备份元信息失败：{e}")))?;
            Ok(DbReply::DbBackup(Box::new(DbBackupEntry {
                file_name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                byte_size: meta.len(),
                created_at_ms: now_ms(),
            })))
        }
        DbAction::BackupDbList { recallmd_dir } => {
            let list = backup::list_daily_backups(&recallmd_dir.join("backups"))?;
            Ok(DbReply::DbBackupList(list))
        }
        DbAction::RestoreDb { .. } => {
            unreachable!("RestoreDb 在 worker_loop 内单独处理")
        }
        DbAction::BackupFull {
            root_canon,
            workspace_id,
            target_dir,
        } => {
            let result = backup::backup_full(conn, &root_canon, &workspace_id, &target_dir)?;
            Ok(DbReply::FullBackup(Box::new(result)))
        }
        DbAction::ReviewBegin { block_id } => {
            let result = review::review_begin_on(conn, tokens, &block_id)?;
            Ok(DbReply::ReviewBegin(Box::new(result)))
        }
        DbAction::ReviewSubmit(req) => {
            let result = review::submit_review_on(conn, tokens, &req)?;
            Ok(DbReply::ReviewSubmit(Box::new(result)))
        }
        DbAction::ReviewQueue { page_size } => {
            let result = review::review_queue_on(conn, page_size)?;
            Ok(DbReply::ReviewQueue(Box::new(result)))
        }
        DbAction::ReviewSetParticipation { block_ids, action } => {
            let n = review::set_participation_on(conn, &block_ids, &action)?;
            Ok(DbReply::ReviewCount(n))
        }
        DbAction::ReviewResetBlock { block_id } => {
            let result = review::reset_block_on(conn, &block_id)?;
            Ok(DbReply::ReviewReset(Box::new(result)))
        }
        DbAction::ReviewStats => {
            let result = review::review_stats_on(conn)?;
            Ok(DbReply::ReviewStats(Box::new(result)))
        }
        DbAction::AppConfigRead => {
            let result = review::app_config_on(conn)?;
            Ok(DbReply::AppConfig(Box::new(result)))
        }
        DbAction::AppConfigSet { key, value } => {
            review::app_config_set_on(conn, &key, &value)?;
            Ok(DbReply::Ack)
        }
        DbAction::ReviewSetPrompt { block_id, prompt } => {
            review::set_prompt_on(conn, &block_id, prompt.as_deref())?;
            Ok(DbReply::Ack)
        }
        DbAction::Shutdown => Ok(DbReply::Ack),
    }
}

/// 尽力重开 db_path（恢复失败路径兜底；原库被隔离时打开的是空库，原件仍在隔离目录）
fn reopen_best_effort(db_path: &Path) -> Connection {
    Connection::open(db_path).unwrap_or_else(|_| Connection::open_in_memory().expect("兜底连接"))
}

/// 日备恢复（worker 上运行；换连接）：
/// 验证候选 → 隔离当前 → 复制 → 重开+迁移 → 全文档 PENDING → 恢复模式登记。
/// 返回的连接恒为可用（原库 / 恢复库 / 兜底重开），失败不悬挂 worker；
/// 不可逆点（关连接）之后任何失败，原件都经隔离目录保全。
fn restore_db(
    conn: Connection,
    recallmd: &Path,
    file_name: &str,
) -> (HostResult<DbReply>, Connection) {
    let db_path = recallmd.join(METADATA_DB);
    let candidate = recallmd
        .join("backups")
        .join(backup::BACKUP_DB_DIR)
        .join(file_name);

    // Phase A：验证（不动连接，失败原样返回）
    if !candidate.exists() {
        return (
            Err(HostError::new(
                super::error::FILE_NOT_FOUND,
                "备份文件不存在",
            )
            .with_path(file_name)),
            conn,
        );
    }
    if let Err(e) = backup::verify_backup_file(&candidate) {
        return (Err(e), conn);
    }

    // Phase B：不可逆点——关连接 + 隔离 + 复制
    match conn.close() {
        Ok(()) => {}
        Err((returned, e)) => {
            return (Err(map_sqlite_error(&e, "关闭当前库")), returned)
        }
    }    let quarantined = match recovery::quarantine_db(recallmd, "restore") {
        Ok(q) => q,
        Err(e) => return (Err(e), reopen_best_effort(&db_path)),
    };
    if let Err(e) = std::fs::copy(&candidate, &db_path) {
        let _ = restore_from_quarantine(&quarantined, &db_path);
        return (
            Err(HostError::new(
                IO_ERROR,
                format!("复制备份失败（原库已从隔离目录保全）：{e}"),
            )),
            reopen_best_effort(&db_path),
        );
    }

    // Phase C：打开恢复库 + 迁移 + 全文档 PENDING（§12.6 L800：以当前 .md 重新核对）
    let mut new_conn = match open_checked(&db_path) {
        Ok((c, _)) => c,
        Err(e) => return (Err(e), reopen_best_effort(&db_path)),
    };
    if let Err(e) = migrate::run(&mut new_conn, &|c| {
        backup::premigration_backup(c, &recallmd.join("backups"))
    }) {
        return (Err(e), new_conn);
    }
    let pending = match new_conn.execute("UPDATE Document SET index_status = 'PENDING'", []) {
        Ok(n) => n as u64,
        Err(e) => return (Err(map_sqlite_error(&e, "恢复后标记 PENDING")), new_conn),
    };
    if let Err(e) = query::settings_set_string(
        &new_conn,
        "recovery.mode",
        recovery::MODE_RESTORED_FROM_BACKUP,
        now_ms(),
    ) {
        return (Err(e), new_conn);
    }
    (
        Ok(DbReply::DbRestore(Box::new(DbRestoreResult {
            restored_from: file_name.to_string(),
            quarantined_to: Some(quarantined.to_string_lossy().into_owned()),
            documents_pending: pending,
        }))),
        new_conn,
    )
}

/// 从隔离目录把原件搬回原位（复制失败时的补偿）
fn restore_from_quarantine(quarantined: &Path, db_path: &Path) -> std::io::Result<()> {
    for suffix in ["", "-wal", "-shm"] {
        let src = quarantined.join(format!("{}{suffix}", METADATA_DB));
        if src.exists() {
            std::fs::rename(&src, db_path.with_file_name(format!(
                "{}{suffix}",
                METADATA_DB
            )))?;
        }
    }
    Ok(())
}


// ---------------------------------------------------------------------------
// 直连（测试与恢复流程复用）
// ---------------------------------------------------------------------------

/// 直连打开（绕开线程）：全套 PRAGMA + 迁移 + Workspace 行。
pub fn open_test_db(db_path: &Path) -> HostResult<Connection> {
    let mut conn = Connection::open(db_path).map_err(|e| map_sqlite_error(&e, "open"))?;
    apply_pragmas(&conn)?;
    migrate::run(&mut conn, &|_| Ok(()))?;
    schema::ensure_workspace_row(&conn, None, "test", now_ms())?;
    Ok(conn)
}
