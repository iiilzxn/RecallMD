//! 文件操作的 DB 随批事务（§12.5 L761 / §13.5–13.6）：应用内移动/删除/恢复后，
//! Document 与 KnowledgeBlock 在单事务内随迁；历史经 FK RESTRICT 永不删除。
//! 前缀匹配在 Rust 侧完成（避免 SQL LIKE 的 `_`/`%` 文件名陷阱）。

use rusqlite::{Connection, Transaction};

use super::super::error::{HostError, HostResult};
use super::dto::path_key_of;

fn sqlx(e: rusqlite::Error, ctx: &str) -> HostError {
    super::map_sqlite_error(&e, ctx)
}

struct LiveDoc {
    document_id: String,
    relative_path: String,
    path_key: String,
}

fn load_live_docs(tx: &Transaction, workspace_id: &str) -> HostResult<Vec<LiveDoc>> {
    let mut stmt = tx
        .prepare(
            "SELECT document_id, relative_path, path_key FROM Document \
             WHERE workspace_id = ?1 AND status <> 'DELETED'",
        )
        .map_err(|e| sqlx(e, "装载 live 文档"))?;
    let rows = stmt
        .query_map(rusqlite::params![workspace_id], |r| {
            Ok(LiveDoc {
                document_id: r.get(0)?,
                relative_path: r.get(1)?,
                path_key: r.get(2)?,
            })
        })
        .map_err(|e| sqlx(e, "装载 live 文档"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| sqlx(e, "装载 live 文档"))?);
    }
    Ok(out)
}

fn workspace_id_of(tx: &Transaction) -> HostResult<String> {
    tx.query_row(
        "SELECT workspace_id FROM Workspace WHERE singleton = 1",
        [],
        |r| r.get(0),
    )
    .map_err(|e| sqlx(e, "读取 Workspace"))
}

/// 移动目标前缀是否与任何 live 文档路径冲突（rename 前预检；
/// 冲突则拒绝且未动文件，§13.6 "先验证全部受影响路径"）
pub fn move_collision(
    conn: &mut Connection,
    src_relative: &str,
    dst_relative: &str,
) -> HostResult<Option<String>> {
    let tx = conn.transaction().map_err(|e| sqlx(e, "move_collision"))?;
    let ws = workspace_id_of(&tx)?;
    let src_key = path_key_of(src_relative);
    let dst_key = path_key_of(dst_relative);
    let docs = load_live_docs(&tx, &ws)?;
    tx.commit().map_err(|e| sqlx(e, "move_collision"))?;

    let src_is_dir_like = !src_relative.ends_with(".md");
    let affected = |key: &str| -> bool {
        if src_is_dir_like {
            key == src_key || key.starts_with(&format!("{src_key}/"))
        } else {
            key == src_key
        }
    };
    for d in &docs {
        if affected(&d.path_key) {
            continue; // 自己（将随迁）
        }
        // 目标按源同构判断：文件对文件，目录（或目录内成员）对前缀
        let collides = if src_is_dir_like {
            d.path_key == dst_key || d.path_key.starts_with(&format!("{dst_key}/"))
        } else {
            d.path_key == dst_key
        };
        if collides {
            return Ok(Some(d.relative_path.clone()));
        }
    }
    Ok(None)
}

/// 同 document_id 改路径（blocks 经 FK 自动跟随；不加 index_revision——移动不是重索引）
pub fn documents_moved(
    conn: &mut Connection,
    entries: &[(String, String)], // (old_relative, new_relative)
    now_ms: i64,
) -> HostResult<u64> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| sqlx(e, "开启移动事务"))?;
    let ws = workspace_id_of(&tx)?;
    let mut moved = 0u64;
    for (old_rel, new_rel) in entries {
        let old_key = path_key_of(old_rel);
        let new_key = path_key_of(new_rel);
        moved += tx
            .execute(
                "UPDATE Document SET relative_path = ?1, path_key = ?2, updated_at = ?3 \
                 WHERE workspace_id = ?4 AND path_key = ?5 AND status <> 'DELETED'",
                rusqlite::params![new_rel, new_key, now_ms, ws, old_key],
            )
            .map_err(|e| sqlx(e, "更新文档路径"))? as u64;
    }
    tx.commit().map_err(|e| sqlx(e, "提交移动事务"))?;
    Ok(moved)
}

/// 应用内删除（→ trash）：Document + 全部块软删除；参与状态不动（恢复时原样回来）
pub fn documents_deleted(conn: &mut Connection, src_relative: &str, now_ms: i64) -> HostResult<u64> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| sqlx(e, "开启删除事务"))?;
    let ws = workspace_id_of(&tx)?;
    let src_key = path_key_of(src_relative);
    let is_dir_like = !src_relative.ends_with(".md");

    let docs: Vec<String> = {
        let live = load_live_docs(&tx, &ws)?;
        live.into_iter()
            .filter(|d| {
                d.path_key == src_key
                    || (is_dir_like && d.path_key.starts_with(&format!("{src_key}/")))
            })
            .map(|d| d.document_id)
            .collect()
    };
    if docs.is_empty() {
        tx.commit().map_err(|e| sqlx(e, "提交删除事务"))?;
        return Ok(0);
    }
    let mut total = 0u64;
    for doc_id in &docs {
        total += tx
            .execute(
                "UPDATE Document SET status = 'DELETED', deleted_at = ?1, updated_at = ?1 \
                 WHERE document_id = ?2",
                rusqlite::params![now_ms, doc_id],
            )
            .map_err(|e| sqlx(e, "标记文档删除"))? as u64;
        tx.execute(
            "UPDATE KnowledgeBlock SET status = 'DELETED', deleted_at = ?1, updated_at = ?1, \
             status_reason = 'user delete' WHERE document_id = ?2 AND status <> 'DELETED'",
            rusqlite::params![now_ms, doc_id],
        )
        .map_err(|e| sqlx(e, "标记块删除"))?;
    }
    tx.commit().map_err(|e| sqlx(e, "提交删除事务"))?;
    Ok(total)
}

/// trash 恢复：文档回 PRESENT/PENDING；块 → MISSING（诚实：Rust 不验证锚点，
/// 下一轮 reconcile 走 RESTORE 复现，§12.6 L800）
pub fn documents_restored(conn: &mut Connection, relative: &str, now_ms: i64) -> HostResult<u64> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| sqlx(e, "开启恢复事务"))?;
    let ws = workspace_id_of(&tx)?;
    let key = path_key_of(relative);
    let n = tx
        .execute(
            "UPDATE Document SET status = 'PRESENT', deleted_at = NULL, missing_since = NULL, \
             index_status = 'PENDING', updated_at = ?1 \
             WHERE workspace_id = ?2 AND path_key = ?3 AND status = 'DELETED'",
            rusqlite::params![now_ms, ws, key],
        )
        .map_err(|e| sqlx(e, "恢复文档"))? as u64;
    if n > 0 {
        tx.execute(
            "UPDATE KnowledgeBlock SET status = 'MISSING', deleted_at = NULL, \
             missing_since = COALESCE(missing_since, ?1), updated_at = ?1 \
             WHERE document_id IN (SELECT document_id FROM Document WHERE path_key = ?2) \
             AND status = 'DELETED'",
            rusqlite::params![now_ms, key],
        )
        .map_err(|e| sqlx(e, "恢复块"))?;
    }
    tx.commit().map_err(|e| sqlx(e, "提交恢复事务"))?;
    Ok(n)
}

/// 启动时重放移动操作的 DB 随批（幂等：按旧路径匹配，已迁移则 0 行）。
/// 目录移动：所有 live 文档按前缀换根。尾部拼接假定 src 与登记路径大小写一致
/// （应用内移动产物满足；残余偏差由 TS 重索引收敛）。
pub fn documents_moved_prefix(
    conn: &mut Connection,
    src_relative: &str,
    dst_relative: &str,
    now_ms: i64,
) -> HostResult<u64> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| sqlx(e, "开启移动重放"))?;
    let ws = workspace_id_of(&tx)?;
    let src_key = path_key_of(src_relative);
    let live = load_live_docs(&tx, &ws)?;
    let mut total = 0u64;
    for d in live {
        let new_rel = if d.path_key == src_key {
            dst_relative.to_string()
        } else if d.path_key.starts_with(&format!("{src_key}/")) {
            let tail = d.relative_path[src_relative.len()..].trim_start_matches('/');
            format!("{}/{}", dst_relative.trim_end_matches('/'), tail)
        } else {
            continue;
        };
        total += tx
            .execute(
                "UPDATE Document SET relative_path = ?1, path_key = ?2, updated_at = ?3 \
                 WHERE workspace_id = ?4 AND path_key = ?5 AND status <> 'DELETED'",
                rusqlite::params![new_rel, path_key_of(&new_rel), now_ms, ws, d.path_key],
            )
            .map_err(|e| sqlx(e, "重放移动"))? as u64;
    }
    tx.commit().map_err(|e| sqlx(e, "提交移动重放"))?;
    Ok(total)
}

// ---------------------------------------------------------------------------
// M7：编辑器冲突 ↔ 索引状态（§13.4 L901：unresolved conflict 的文档不允许评分；
// 队列/评分查询只认 index_status='READY'，CONFLICT 挡评，解决后经重扫回 READY）
// ---------------------------------------------------------------------------

pub fn mark_doc_status_on(
    conn: &mut Connection,
    relative: &str,
    status: &str,
) -> HostResult<u64> {
    if status != "CONFLICT" && status != "PENDING" {
        return Err(HostError::new(
            super::super::error::REVIEW_REJECTED,
            format!("文档索引状态只允许 CONFLICT/PENDING（得到 {status:?}）"),
        ));
    }
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| sqlx(e, "开启状态事务"))?;
    let ws = workspace_id_of(&tx)?;
    let key = path_key_of(relative);
    let n = tx
        .execute(
            "UPDATE Document SET index_status = ?1, updated_at = ?2 \
             WHERE workspace_id = ?3 AND path_key = ?4 AND status <> 'DELETED'",
            rusqlite::params![status, now_ms_value(), ws, key],
        )
        .map_err(|e| sqlx(e, "更新文档索引状态"))? as u64;
    tx.commit().map_err(|e| sqlx(e, "提交状态事务"))?;
    Ok(n)
}

fn now_ms_value() -> i64 {
    crate::persistence::store::now_ms()
}
