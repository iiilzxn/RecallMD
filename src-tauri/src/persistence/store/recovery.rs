//! 启动恢复（§13.2 启动表 / §14.3 顺序 / §12.6 恢复矩阵）：
//! - 扫描 `.recallmd/operations`：save 日志停在 FILE_COMMITTED → 文档标 PENDING
//!   （正文已存、索引落后 → 基于磁盘重建，不回退正文）；move/delete 残留 → 幂等重放
//! - DB 损坏/身份错配 → 三件套隔离（原件保留）→ 新库重建 + recovery.mode 记录
//! - RecoveryStatus：打开汇报（恢复模式必须 UI 明示，§12.6 L798）

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::super::error::{HostResult, IO_ERROR};
use super::super::util::display_path;

/// 恢复模式（Settings "recovery.mode"）
pub const MODE_REBUILT_NO_HISTORY: &str = "REBUILT_NO_HISTORY";
pub const MODE_QUARANTINED_CORRUPT: &str = "QUARANTINED_CORRUPT";
pub const MODE_RESTORED_FROM_BACKUP: &str = "RESTORED_FROM_BACKUP";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    /// Some = 库经历过恢复事件（UI 横幅依据）
    pub recovery_mode: Option<String>,
    /// 隔离目录（原件保留，未隔离为 None）
    pub quarantined_to: Option<String>,
    pub rebuilt: bool,
    pub migrated: bool,
    pub backup_taken: bool,
    /// 启动时发现"正文已存、索引落后"的文档（TS 优先重索引）
    pub stale_documents: Vec<String>,
    pub warnings: Vec<String>,
}

impl Default for RecoveryStatus {
    fn default() -> Self {
        Self {
            recovery_mode: None,
            quarantined_to: None,
            rebuilt: false,
            migrated: false,
            backup_taken: false,
            stale_documents: Vec::new(),
            warnings: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// 隔离（原件保留；失败 = 磁盘问题，停止元数据写）
// ---------------------------------------------------------------------------

/// 把 metadata.sqlite{,-wal,-shm} 成组移入 `.recallmd/quarantine/<utc_ms>-<reason>/`。
/// 调用前必须已关闭持有连接（Windows 共享违例）。
pub fn quarantine_db(recallmd: &Path, reason: &str) -> HostResult<PathBuf> {
    let dir = recallmd.join("quarantine").join(format!("{}-{reason}", super::now_ms()));
    std::fs::create_dir_all(&dir)
        .map_err(|e| super::super::error::HostError::new(IO_ERROR, format!("创建隔离目录失败：{e}")))?;
    for suffix in ["", "-wal", "-shm"] {
        let src = recallmd.join(format!("{}{suffix}", super::METADATA_DB));
        if src.exists() {
            let dst = dir.join(format!("{}{suffix}", super::METADATA_DB));
            std::fs::rename(&src, &dst).map_err(|e| {
                super::super::error::HostError::new(
                    IO_ERROR,
                    format!("隔离数据库失败（磁盘满或被占用？）：{e}"),
                )
                .with_path(display_path(&src))
            })?;
        }
    }
    Ok(dir)
}

// ---------------------------------------------------------------------------
// 启动操作日志扫描
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
struct SaveOpLog {
    #[serde(rename = "operationId")]
    _operation_id: String,
    path: String,
    phase: String,
    #[serde(rename = "expectedHash")]
    _expected_hash: String,
    #[serde(rename = "newHash")]
    _new_hash: String,
}

#[derive(Debug, serde::Deserialize)]
struct FsOpLog {
    #[serde(rename = "operationId")]
    _operation_id: String,
    action: String, // MOVE | DELETE
    #[allow(dead_code)] // 日志证据的一部分；重放按磁盘实际状态裁决（§13.2）
    phase: String, // STARTED | COMMITTED
    src: String,
    dst: Option<String>,
}

#[derive(Debug, Default)]
pub struct StartupScan {
    pub stale_documents: Vec<String>,
    pub warnings: Vec<String>,
}

/// 扫描操作日志（§13.2 启动表）：
/// - save@FILE_COMMITTED：文档标 PENDING（幂等）→ 删日志（TS 启动收敛后 index_complete
///   幂等返回 Ok）
/// - save@STARTED：保存未确认，正文未动；草稿机制另行提示 → 删日志
/// - MOVE/DELETE@STARTED/COMMITTED：fs 侧按实际文件证据裁决后重放 DB 随批 → 删日志
pub fn scan_operations(
    conn: &mut Connection,
    recallmd: &Path,
    root_canon: &Path,
) -> HostResult<StartupScan> {
    let ops_dir = recallmd.join("operations");
    let mut out = StartupScan::default();
    let entries: Vec<PathBuf> = match std::fs::read_dir(&ops_dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
        Err(_) => return Ok(out),
    };

    let ws: String = conn
        .query_row(
            "SELECT workspace_id FROM Workspace WHERE singleton = 1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| super::map_sqlite_error(&e, "读取 Workspace"))?;

    for path in entries {
        let raw = match std::fs::read(&path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let json: serde_json::Value = match serde_json::from_slice(&raw) {
            Ok(v) => v,
            Err(_) => {
                out.warnings.push(format!(
                    "操作日志损坏已跳过：{}",
                    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
                ));
                continue;
            }
        };
        // save 日志带 expectedHash/newHash；fs 日志带 action
        let is_save = json.get("expectedHash").is_some();
        if is_save {
            let Ok(log) = serde_json::from_slice::<SaveOpLog>(&raw) else {
                continue;
            };
            match log.phase.as_str() {
                "FILE_COMMITTED" => {
                    mark_pending(conn, &ws, &log.path)?;
                    out.stale_documents.push(log.path.clone());
                }
                _ => {} // STARTED：正文未动，草稿流程负责
            }
            let _ = std::fs::remove_file(&path);
        } else {
            let Ok(log) = serde_json::from_slice::<FsOpLog>(&raw) else {
                continue;
            };
            replay_fs_log(conn, root_canon, &log)?;
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(out)
}

fn mark_pending(conn: &Connection, ws: &str, relative: &str) -> HostResult<()> {
    conn.execute(
        "UPDATE Document SET index_status = 'PENDING', updated_at = ?1 \
         WHERE workspace_id = ?2 AND path_key = ?3 AND status <> 'DELETED'",
        rusqlite::params![super::now_ms(), ws, super::dto::path_key_of(relative)],
    )
    .map_err(|e| super::map_sqlite_error(&e, "标记 PENDING"))?;
    Ok(())
}

/// fs 操作残留重放：按磁盘实际证据裁决（§13.2："恢复以实际文件证据为准"）
fn replay_fs_log(conn: &mut Connection, root_canon: &Path, log: &FsOpLog) -> HostResult<()> {
    let now = super::now_ms();
    let src_abs = join_relative(root_canon, &log.src);
    match log.action.as_str() {
        "MOVE" => {
            let Some(dst) = &log.dst else { return Ok(()) };
            let dst_abs = join_relative(root_canon, dst);
            let src_gone = !src_abs.exists();
            let dst_there = dst_abs.exists();
            if src_gone && dst_there {
                // 替换已发生、DB 未随迁（幂等：已迁移则 0 行）
                super::ops::documents_moved_prefix(conn, &log.src, dst, now)?;
            } else if !dst_there {
                // rename 未发生：日志作废
            } else {
                // 两者都在（case-only 重命名核验语义，M2 偏差 1）：按已发生处理
                super::ops::documents_moved_prefix(conn, &log.src, dst, now)?;
            }
            Ok(())
        }
        "DELETE" => {
            if !src_abs.exists() {
                // trash 移动已发生
                super::ops::documents_deleted(conn, &log.src, now)?;
            }
            Ok(())
        }
        "RESTORE" => {
            // trash 恢复残留：目标路径已有文件 = 恢复已发生，DB 补登记（幂等）
            if src_abs.exists() {
                super::ops::documents_restored(conn, &log.src, now)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn join_relative(root: &Path, relative: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for seg in relative.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            continue;
        }
        p.push(seg);
    }
    p
}
