//! SQLite 元数据存储（设计 §6.2/§12）：rusqlite bundled 引擎，专用数据库工作线程
//! 持唯一连接，读写请求经邮箱排队；SQL 与事务集中在 store 模块。
//!
//! 测试绕开线程直调 `*_on(conn)` 内层函数；Tauri 命令经 `DbHandle::call`。

pub mod commit;
pub mod dto;
pub mod fsrs;
pub mod migrate;
pub mod query;
pub mod schema;

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use rusqlite::Connection;

use super::error::{HostError, HostResult, DB_BUSY, DB_CORRUPT, IO_ERROR};
use commit::commit_on;
use dto::{CommitIndexBatchRequest, CommitIndexBatchResult, RegistrySnapshot};
use query::{registry_snapshot_on, RegistryQuery};

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

/// DB 动作请求（Stage 2 追加备份/恢复/移动随批等）
pub enum DbAction {
    /// 索引批量提交（§12.5 单事务 + CAS）
    CommitIndex(Box<CommitIndexBatchRequest>),
    /// 注册表快照（reconcile 输入）
    RegistrySnapshot,
    /// 关闭工作线程（close_workspace 调用）
    Shutdown,
}

impl DbAction {
    fn timeout(&self) -> Duration {
        match self {
            DbAction::CommitIndex(_) => Duration::from_secs(30),
            DbAction::RegistrySnapshot => Duration::from_secs(15),
            DbAction::Shutdown => Duration::from_secs(10),
        }
    }
}

pub enum DbReply {
    CommitIndex(Box<CommitIndexBatchResult>),
    RegistrySnapshot(Box<RegistrySnapshot>),
    Ack,
}

pub struct DbJob {
    pub action: DbAction,
    pub reply: mpsc::Sender<HostResult<DbReply>>,
}

/// 库句柄：Online = 工作线程活着；Offline = 元数据只读（高版本 schema/迁移失败，
/// §14.3 L965），正文读写不受影响。
#[derive(Clone)]
pub enum DbHandle {
    Online { tx: mpsc::Sender<DbJob> },
    Offline { reason: HostError },
}

impl DbHandle {
    pub fn call(&self, action: DbAction) -> HostResult<DbReply> {
        match self {
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

/// 打开结果汇报（§14.3 启动顺序的 DB 检查阶段产出；Stage 2 扩展备份/重建字段）
#[derive(Debug, Clone)]
pub struct OpenReport {
    /// Workspace 行确定的库身份（manifest 丢失时可与之对齐，§7.1 L186）
    pub effective_workspace_id: String,
    pub migrated: bool,
    pub sqlite_version: String,
    /// Offline 原因（None = Online）
    pub offline_reason: Option<HostError>,
}

pub struct StoreOpenOutcome {
    pub handle: DbHandle,
    pub report: OpenReport,
}

/// 打开（或创建）`.recallmd/metadata.sqlite` 并启动工作线程。
/// DB 内容问题不使打开失败：高版本/迁移失败 → Offline 句柄；
/// 损坏 → Stage 2 起走隔离+重建，本阶段先以 Offline 暴露。
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
    let spawn = std::thread::Builder::new()
        .name("recallmd-db".into())
        .spawn(move || {
            // boot：开连接 → PRAGMA → 引擎版本 → quick_check → 迁移 → Workspace 行
            let booted: HostResult<(Connection, OpenReport)> = (|| {                let mut conn = Connection::open(&db_path)
                    .map_err(|e| map_sqlite_error(&e, "打开元数据库"))?;
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
                // v1 是首个 schema：全新库无迁移前备份（§14.2.3）
                let migrated = migrate::run(&mut conn, &|_| Ok(()))?;
                let effective_id =
                    schema::ensure_workspace_row(&conn, ws_id.as_deref(), &ws_name, now_ms())?;
                Ok((
                    conn,
                    OpenReport {
                        effective_workspace_id: effective_id,
                        migrated: !migrated.applied.is_empty(),
                        sqlite_version: version,
                        offline_reason: None,
                    },
                ))
            })();
            match booted {
                Ok((conn, report)) => {
                    // 先回执再进循环：open_store 拿到报告，连接留在本线程
                    let _ = boot_tx.send(Ok(report));
                    worker_loop(job_rx, conn);
                }
                Err(e) => {
                    let _ = boot_tx.send(Err(e));
                }
            }
        });

    let fallback = |reason: HostError| StoreOpenOutcome {
        handle: DbHandle::Offline {
            reason: reason.clone(),
        },
        report: OpenReport {
            effective_workspace_id: workspace_id.unwrap_or("").to_string(),
            migrated: false,
            sqlite_version: String::new(),
            offline_reason: Some(reason),
        },
    };

    if spawn.is_err() {
        return fallback(HostError::new(IO_ERROR, "无法启动数据库线程"));
    }
    match boot_rx.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(report)) => StoreOpenOutcome {
            handle: DbHandle::Online { tx: job_tx },
            report,
        },
        Ok(Err(reason)) => fallback(reason),
        Err(_) => fallback(HostError::new(IO_ERROR, "数据库线程启动超时")),
    }
}

fn worker_loop(job_rx: mpsc::Receiver<DbJob>, conn: Connection) {
    let mut conn = conn;
    while let Ok(job) = job_rx.recv() {
        let DbJob { action, reply } = job;
        if matches!(action, DbAction::Shutdown) {
            let _ = reply.send(Ok(DbReply::Ack));
            break;
        }
        // 单线程持有连接；panic 捕获避免调用方悬挂（§14.1 有界重试）
        let result = {
            let c = &mut conn;
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || dispatch(c, action))) {
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
fn dispatch(conn: &mut Connection, action: DbAction) -> HostResult<DbReply> {
    match action {
        DbAction::CommitIndex(req) => {
            let result = commit_on(conn, &req)?;
            Ok(DbReply::CommitIndex(Box::new(result)))
        }
        DbAction::RegistrySnapshot => {
            let snap = registry_snapshot_on(conn, &RegistryQuery::default())?;
            Ok(DbReply::RegistrySnapshot(Box::new(snap)))
        }
        DbAction::Shutdown => Ok(DbReply::Ack),
    }
}

/// 直连打开（绕开线程）：全套 PRAGMA + 迁移 + Workspace 行。
/// 集成测试与 Stage 2 恢复流程复用。
pub fn open_test_db(db_path: &Path) -> HostResult<Connection> {
    let mut conn = Connection::open(db_path).map_err(|e| map_sqlite_error(&e, "open"))?;
    apply_pragmas(&conn)?;
    migrate::run(&mut conn, &|_| Ok(()))?;
    schema::ensure_workspace_row(&conn, None, "test", now_ms())?;
    Ok(conn)
}
