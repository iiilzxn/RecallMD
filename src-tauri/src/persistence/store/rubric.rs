//! 学习时保存的关键得分点。独立于题面，复习队列不携带答案。
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{map_sqlite_error, now_ms};
use crate::persistence::error::{HostError, HostResult};

pub const MAX_POINTS: usize = 30;
pub const MAX_POINT_CHARS: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rubric {
    pub points: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRubric {
    pub block_id: String,
    pub heading_offset: i64,
    pub points: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveNoteRubric {
    pub relative_path: String,
    pub expected_hash: String,
    pub block_id: String,
    pub expected_points: Vec<String>,
    pub points: Vec<String>,
}

/// 只返回当前已保存笔记的小节，不受复习到期时间或日配额限制。
pub fn note_read_on(
    conn: &Connection,
    relative_path: &str,
    expected_hash: &str,
) -> HostResult<Vec<NoteRubric>> {
    let doc: Option<(String, String, Option<String>)> = conn.query_row(
        "SELECT document_id, index_status, content_hash FROM Document WHERE path_key = ?1 AND status = 'PRESENT'",
        [super::dto::path_key_of(relative_path)], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional().map_err(|e| map_sqlite_error(&e, "读取笔记版本"))?;
    let Some((id, status, hash)) = doc else {
        return Ok(Vec::new());
    };
    if status != "READY" || hash.as_deref() != Some(expected_hash) {
        return Err(HostError::new(
            "JEV_NOTE_STALE",
            "笔记版本已变化或正在同步，请保存笔记后重试",
        ));
    }
    let mut stmt = conn.prepare(
        "SELECT b.block_id, b.start_offset, COALESCE(g.points_json, '[]') FROM KnowledgeBlock b \
         JOIN ReviewState r ON r.block_id = b.block_id \
         LEFT JOIN ReviewRubric g ON g.block_id = b.block_id \
         WHERE b.document_id = ?1 AND b.status = 'ACTIVE' AND b.kind = 'SECTION' ORDER BY b.ordinal",
    ).map_err(|e| map_sqlite_error(&e, "读取笔记得分点"))?;
    let rows = stmt
        .query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| map_sqlite_error(&e, "读取笔记得分点"))?;
    rows.map(|row| {
        let (block_id, heading_offset, raw) =
            row.map_err(|e| map_sqlite_error(&e, "读取笔记得分点"))?;
        let points = serde_json::from_str(&raw)
            .map_err(|_| HostError::new("DB_CORRUPT", "得分点数据损坏"))?;
        Ok(NoteRubric {
            block_id,
            heading_offset,
            points,
        })
    })
    .collect()
}

pub fn note_save_on(conn: &mut Connection, request: &SaveNoteRubric) -> HostResult<NoteRubric> {
    let points = normalize_points(&request.points)?;
    let tx = conn
        .transaction()
        .map_err(|e| map_sqlite_error(&e, "保存笔记得分点"))?;
    let mut entry = note_read_on(&tx, &request.relative_path, &request.expected_hash)?
        .into_iter()
        .find(|entry| entry.block_id == request.block_id)
        .ok_or_else(|| {
            HostError::new(
                "JEV_NOTE_STALE",
                "小节已移动、变更或尚未纳入复习，请刷新笔记",
            )
        })?;
    if entry.points != request.expected_points {
        return Err(HostError::new(
            "JEV_RUBRIC_STALE",
            "得分点已在其他位置修改，请重新打开后再编辑",
        ));
    }
    if entry.points != points {
        write_rows_on(&tx, &request.block_id, &points)?;
    }
    entry.points = points;
    tx.commit()
        .map_err(|e| map_sqlite_error(&e, "提交笔记得分点"))?;
    Ok(entry)
}

pub fn normalize_points(points: &[String]) -> HostResult<Vec<String>> {
    if points.len() > MAX_POINTS {
        return Err(HostError::new(
            "JEV_INPUT_INVALID",
            "每题最多设置 30 个得分点",
        ));
    }
    points
        .iter()
        .map(|point| {
            let point = point.trim();
            if point.is_empty() || point.chars().count() > MAX_POINT_CHARS {
                return Err(HostError::new(
                    "JEV_INPUT_INVALID",
                    "每个得分点须为 1–500 字",
                ));
            }
            Ok(point.to_owned())
        })
        .collect()
}

pub fn read_on(conn: &Connection, block_id: &str) -> HostResult<Rubric> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT points_json FROM ReviewRubric WHERE block_id = ?1",
            [block_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| map_sqlite_error(&e, "读取得分点"))?;
    let points = match raw {
        Some(raw) => serde_json::from_str(&raw)
            .map_err(|_| HostError::new("DB_CORRUPT", "得分点数据损坏，请重新设置"))?,
        None => Vec::new(),
    };
    Ok(Rubric { points })
}

pub fn save_on(conn: &mut Connection, block_id: &str, points: &[String]) -> HostResult<()> {
    let points = normalize_points(points)?;
    let tx = conn
        .transaction()
        .map_err(|e| map_sqlite_error(&e, "保存得分点"))?;
    write_rows_on(&tx, block_id, &points)?;
    tx.commit().map_err(|e| map_sqlite_error(&e, "提交得分点"))
}

fn write_rows_on(conn: &Connection, block_id: &str, points: &[String]) -> HostResult<()> {
    // 修改评分标准后，已打开的复习会话必须重新开始。
    let n = conn.execute(
        "UPDATE ReviewState SET state_revision = state_revision + 1, updated_at = ?1 WHERE block_id = ?2",
        params![now_ms(), block_id],
    ).map_err(|e| map_sqlite_error(&e, "更新得分点版本"))?;
    if n == 0 {
        return Err(HostError::new("REVIEW_REJECTED", "请先将本小节纳入复习"));
    }
    conn.execute(
        "INSERT INTO ReviewRubric(block_id, points_json) VALUES (?1, ?2) ON CONFLICT(block_id) DO UPDATE SET points_json = excluded.points_json",
        params![block_id, serde_json::to_string(&points).expect("字符串列表")],
    ).map_err(|e| map_sqlite_error(&e, "保存得分点"))?;
    Ok(())
}
