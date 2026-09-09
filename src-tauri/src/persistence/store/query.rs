//! 读路径：注册表快照（reconcile 输入）、到期候选（M5 备用）、Settings。

use rusqlite::Connection;

use super::super::error::{HostError, HostResult, IO_ERROR};
use super::dto::{DocumentRegistryDto, RegisteredBlockDto, RegistrySnapshot};
use super::map_sqlite_error;

/// 注册表查询范围（默认全量；后续可按路径过滤）
#[derive(Debug, Default, Clone)]
pub struct RegistryQuery {
    /// 仅返回这些 path_key 的文档；块始终全量（tombstone 检测需要全库视野）
    pub path_keys: Option<Vec<String>>,
}

fn db_err(e: rusqlite::Error, ctx: &str) -> HostError {
    map_sqlite_error(&e, ctx)
}

/// 注册表快照：非 DELETED 文档 + 全部块（含 DELETED/ID_CONFLICT）+ 恢复模式
pub fn registry_snapshot_on(
    conn: &Connection,
    query: &RegistryQuery,
) -> HostResult<RegistrySnapshot> {
    let mut documents = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT document_id, relative_path, status, index_status, index_revision, \
                 observed_hash, content_hash, parser_version, byte_size, disk_mtime_at, \
                 line_ending, has_bom, last_seen_at \
                 FROM Document WHERE status <> 'DELETED' ORDER BY path_key",
            )
            .map_err(|e| db_err(e, "registry documents"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(DocumentRegistryDto {
                    document_id: r.get(0)?,
                    relative_path: r.get(1)?,
                    status: r.get(2)?,
                    index_status: r.get(3)?,
                    index_revision: r.get(4)?,
                    observed_hash: r.get(5)?,
                    content_hash: r.get(6)?,
                    parser_version: r.get(7)?,
                    byte_size: r.get(8)?,
                    disk_mtime_at: r.get(9)?,
                    line_ending: r.get(10)?,
                    has_bom: r.get::<_, i64>(11)? == 1,
                    last_seen_at: r.get(12)?,
                })
            })
            .map_err(|e| db_err(e, "registry documents"))?;
        for row in rows {
            let dto = row.map_err(|e| db_err(e, "registry documents"))?;
            if let Some(keys) = &query.path_keys {
                let key = super::dto::path_key_of(&dto.relative_path);
                if !keys.contains(&key) {
                    continue;
                }
            }
            documents.push(dto);
        }
    }

    let mut blocks = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT b.block_id, b.document_id, d.relative_path, b.kind, b.heading_level, \
                 b.title, b.heading_path_json, b.ordinal, b.start_offset, b.body_start_offset, \
                 b.end_offset, b.source_hash, b.body_hash, b.content_version, b.status, \
                 b.status_reason, COALESCE(r.participation, 'ENABLED'), \
                 COALESCE(r.needs_recheck, 0), \
                 CASE WHEN r.first_review_at IS NULL THEN 0 ELSE 1 END, \
                 b.missing_since, b.last_seen_at \
                 FROM KnowledgeBlock b \
                 JOIN Document d ON d.document_id = b.document_id \
                 LEFT JOIN ReviewState r ON r.block_id = b.block_id \
                 ORDER BY b.block_id",
            )
            .map_err(|e| db_err(e, "registry blocks"))?;
        let rows = stmt
            .query_map([], |r| {
                let heading_json: String = r.get(6)?;
                Ok((
                    RegisteredBlockDto {
                        block_id: r.get(0)?,
                        document_id: r.get(1)?,
                        relative_path: r.get(2)?,
                        kind: r.get(3)?,
                        heading_level: r.get(4)?,
                        title: r.get(5)?,
                        heading_path: Vec::new(), // 解析在下方
                        ordinal: r.get(7)?,
                        start_offset: r.get(8)?,
                        body_start_offset: r.get(9)?,
                        end_offset: r.get(10)?,
                        source_hash: r.get(11)?,
                        body_hash: r.get(12)?,
                        content_version: r.get(13)?,
                        status: r.get(14)?,
                        status_reason: r.get(15)?,
                        participation: r.get(16)?,
                        needs_recheck: r.get::<_, i64>(17)? == 1,
                        has_rating: r.get::<_, i64>(18)? == 1,
                        missing_since: r.get(19)?,
                        last_seen_at: r.get(20)?,
                    },
                    heading_json,
                ))
            })
            .map_err(|e| db_err(e, "registry blocks"))?;
        for row in rows {
            let (mut dto, heading_json) = row.map_err(|e| db_err(e, "registry blocks"))?;
            dto.heading_path = parse_string_array(&heading_json)?;
            blocks.push(dto);
        }
    }

    Ok(RegistrySnapshot {
        documents,
        blocks,
        recovery_mode: settings_get(conn, "recovery.mode")?,
    })
}

fn parse_string_array(json: &str) -> HostResult<Vec<String>> {
    serde_json::from_str(json).map_err(|e| {
        HostError::new(
            IO_ERROR,
            format!("heading_path_json 不是字符串数组：{e}"),
        )
    })
}

// ---------------------------------------------------------------------------
// Settings（§12.5：单行 upsert，JSON 校验由 CHECK 兜底）
// ---------------------------------------------------------------------------

pub fn settings_get(conn: &Connection, key: &str) -> HostResult<Option<String>> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value_json FROM Settings WHERE key = ?1",
            rusqlite::params![key],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
        .map_err(|e| db_err(e, "settings_get"))?;
    // value_json 是 JSON 字符串；调用方语义上要的是原值，去引号还原
    Ok(value.and_then(|v| serde_json::from_str::<serde_json::Value>(&v).ok().and_then(|x| {
        match x {
            serde_json::Value::String(s) => Some(s),
            _ => None,
        }
    })))
}

/// 以 JSON 字符串值写入（upsert）；调用方传纯字符串，内部包一层 JSON 引号
pub fn settings_set_string(conn: &Connection, key: &str, value: &str, now_ms: i64) -> HostResult<()> {
    let json = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into());
    conn.execute(
        "INSERT INTO Settings (workspace_id, key, value_json, created_at, updated_at) \
         SELECT workspace_id, ?1, ?2, ?3, ?3 FROM Workspace WHERE singleton = 1 \
         ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = ?2, updated_at = ?3",
        rusqlite::params![key, json, now_ms],
    )
    .map_err(|e| db_err(e, "settings_set"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 到期候选（§12.5 L774 示例查询；M5 Review Engine 使用）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueCandidate {
    pub block_id: String,
    pub phase: String,
    pub next_review_at: i64,
}

pub fn due_candidates_on(conn: &Connection, now_ms: i64, limit: i64) -> HostResult<Vec<DueCandidate>> {
    let mut stmt = conn
        .prepare(
            "SELECT r.block_id, r.phase, r.next_review_at \
             FROM ReviewState r \
             JOIN KnowledgeBlock b ON b.block_id = r.block_id \
             JOIN Document d ON d.document_id = b.document_id \
             WHERE r.participation = 'ENABLED' \
               AND r.next_review_at <= ?1 \
               AND b.status = 'ACTIVE' \
               AND d.status = 'PRESENT' AND d.index_status = 'READY' \
             ORDER BY r.next_review_at, r.block_id \
             LIMIT ?2",
        )
        .map_err(|e| db_err(e, "due candidates"))?;
    let rows = stmt
        .query_map(rusqlite::params![now_ms, limit], |r| {
            Ok(DueCandidate {
                block_id: r.get(0)?,
                phase: r.get(1)?,
                next_review_at: r.get(2)?,
            })
        })
        .map_err(|e| db_err(e, "due candidates"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| db_err(e, "due candidates"))?);
    }
    Ok(out)
}
