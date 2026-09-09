//! SQLite 六表 schema（设计 §12.4 第一版 DDL，逐字内嵌）。
//! PRAGMA 是每连接设置（mod.rs 负责）；user_version 由迁移器写入，不在 DDL 内。
//! CHECK 只做存储底线，Rust DTO 继续做应用层校验（§12.4 L755）。

use rusqlite::Connection;

use super::super::error::{HostError, HostResult, DB_CORRUPT};

/// 第一版业务 schema：六表 + 五组索引（§12.4 L601–751，PRAGMA 行除外）。
/// 修改任何约束都必须新增迁移版本，不得原地改动。
pub const DDL_V1: &str = r#"
CREATE TABLE Workspace (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
  name TEXT NOT NULL,
  format_version INTEGER NOT NULL CHECK (format_version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);

CREATE TABLE Document (
  document_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES Workspace(workspace_id) ON DELETE RESTRICT,
  relative_path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  file_identity TEXT,
  status TEXT NOT NULL CHECK (status IN ('PRESENT','MISSING','DELETED')),
  index_status TEXT NOT NULL CHECK (index_status IN ('PENDING','READY','ERROR','CONFLICT')),
  encoding TEXT NOT NULL DEFAULT 'UTF-8',
  line_ending TEXT NOT NULL CHECK (line_ending IN ('LF','CRLF','MIXED')),
  has_bom INTEGER NOT NULL DEFAULT 0 CHECK (has_bom IN (0,1)),
  observed_hash TEXT CHECK (observed_hash IS NULL OR length(observed_hash) = 64),
  content_hash TEXT CHECK (content_hash IS NULL OR length(content_hash) = 64),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  disk_mtime_at INTEGER,
  index_revision INTEGER NOT NULL DEFAULT 0 CHECK (index_revision >= 0),
  parser_version TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(diagnostics_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  missing_since INTEGER,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX document_live_path
  ON Document(workspace_id, path_key) WHERE status <> 'DELETED';
CREATE INDEX document_status ON Document(status, index_status);
CREATE INDEX document_file_identity ON Document(file_identity)
  WHERE file_identity IS NOT NULL;

CREATE TABLE KnowledgeBlock (
  block_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES Document(document_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('SECTION','PREAMBLE')),
  title TEXT,
  heading_level INTEGER NOT NULL CHECK (heading_level BETWEEN 0 AND 6),
  heading_path_json TEXT NOT NULL CHECK (json_valid(heading_path_json)),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  body_start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  body_hash TEXT NOT NULL CHECK (length(body_hash) = 64),
  content_version INTEGER NOT NULL DEFAULT 1 CHECK (content_version >= 1),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','MISSING','DELETED','ID_CONFLICT')),
  status_reason TEXT,
  recall_prompt TEXT CHECK (recall_prompt IS NULL OR length(recall_prompt) <= 200),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  content_modified_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  missing_since INTEGER,
  deleted_at INTEGER,
  CHECK (start_offset <= body_start_offset AND body_start_offset <= end_offset),
  CHECK ((kind = 'PREAMBLE' AND heading_level = 0) OR
         (kind = 'SECTION' AND heading_level BETWEEN 1 AND 6))
);
CREATE INDEX block_document_order ON KnowledgeBlock(document_id, status, ordinal);
CREATE INDEX block_status ON KnowledgeBlock(status);

CREATE TABLE ReviewState (
  block_id TEXT PRIMARY KEY NOT NULL REFERENCES KnowledgeBlock(block_id) ON DELETE RESTRICT,
  participation TEXT NOT NULL DEFAULT 'ENABLED'
    CHECK (participation IN ('ENABLED','PAUSED','EXCLUDED')),
  phase TEXT NOT NULL CHECK (phase IN ('NEW','LEARNING','REVIEW','RELEARNING')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  algorithm_id TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  state_schema_version INTEGER NOT NULL CHECK (state_schema_version >= 1),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  scheduled_due_at INTEGER NOT NULL,
  change_due_at INTEGER,
  next_review_at INTEGER GENERATED ALWAYS AS (
    CASE WHEN change_due_at IS NULL OR scheduled_due_at <= change_due_at
      THEN scheduled_due_at ELSE change_due_at END
  ) STORED,
  stability REAL CHECK (stability IS NULL OR stability >= 0),
  difficulty REAL,
  interval_ms INTEGER NOT NULL DEFAULT 0 CHECK (interval_ms >= 0),
  reps INTEGER NOT NULL DEFAULT 0 CHECK (reps >= 0),
  lapses INTEGER NOT NULL DEFAULT 0 CHECK (lapses >= 0),
  first_review_at INTEGER,
  last_review_at INTEGER,
  needs_recheck INTEGER NOT NULL DEFAULT 0 CHECK (needs_recheck IN (0,1)),
  last_reviewed_content_version INTEGER CHECK (
    last_reviewed_content_version IS NULL OR last_reviewed_content_version >= 1
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((needs_recheck = 0 AND change_due_at IS NULL) OR
         (needs_recheck = 1 AND change_due_at IS NOT NULL))
);
CREATE INDEX review_due ON ReviewState(next_review_at, block_id)
  WHERE participation = 'ENABLED';
CREATE INDEX review_first_seen ON ReviewState(first_review_at, block_id)
  WHERE first_review_at IS NOT NULL;

CREATE TABLE ReviewHistory (
  history_id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  block_id TEXT NOT NULL REFERENCES KnowledgeBlock(block_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'RATE','RESET','ACCEPT_CHANGE','PAUSE','RESUME','EXCLUDE','INCLUDE'
  )),
  rating INTEGER,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  content_version INTEGER NOT NULL CHECK (content_version >= 1),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  document_hash TEXT NOT NULL CHECK (length(document_hash) = 64),
  before_revision INTEGER NOT NULL CHECK (before_revision >= 0),
  after_revision INTEGER NOT NULL,
  before_state_json TEXT NOT NULL CHECK (json_valid(before_state_json)),
  after_state_json TEXT NOT NULL CHECK (json_valid(after_state_json)),
  algorithm_log_json TEXT CHECK (algorithm_log_json IS NULL OR json_valid(algorithm_log_json)),
  change_resolution TEXT CHECK (change_resolution IN ('KEEP','RESET') OR change_resolution IS NULL),
  context_used INTEGER NOT NULL DEFAULT 0 CHECK (context_used IN (0,1)),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(block_id, after_revision),
  CHECK (after_revision = before_revision + 1),
  CHECK ((event_type = 'RATE' AND rating IS NOT NULL AND rating BETWEEN 1 AND 4) OR
         (event_type <> 'RATE' AND rating IS NULL)),
  CHECK (updated_at = created_at)
);
CREATE INDEX history_block_time ON ReviewHistory(block_id, occurred_at, history_id);
CREATE INDEX history_rating_time ON ReviewHistory(occurred_at, block_id)
  WHERE event_type = 'RATE';

CREATE TABLE Settings (
  workspace_id TEXT NOT NULL REFERENCES Workspace(workspace_id) ON DELETE RESTRICT,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, key)
);
"#;

/// bundled 引擎版本下限（§12.1：官方已记录 WAL-reset 修复须已包含）
pub const SQLITE_MIN_VERSION: (u32, u32, u32) = (3, 51, 3);

/// `PRAGMA quick_check` 是否返回 ok（损坏检测第一道，§14.2 L957）
pub fn quick_check_ok(conn: &Connection) -> HostResult<bool> {
    let mut stmt = conn
        .prepare("PRAGMA quick_check")
        .map_err(|e| super::map_sqlite_error(&e, "quick_check"))?;
    let mut rows = stmt.query([]).map_err(|e| super::map_sqlite_error(&e, "query"))?;
    while let Some(row) = rows.next().map_err(|e| super::map_sqlite_error(&e, "row"))? {
        let v: String = row.get(0).map_err(|e| super::map_sqlite_error(&e, "read"))?;
        if v != "ok" {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `PRAGMA foreign_key_check` 是否零违例（备份验证/恢复校验，§14.2 L957）
pub fn foreign_key_check_clean(conn: &Connection) -> HostResult<bool> {
    let n: i64 = conn
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0))
        .map_err(|e| super::map_sqlite_error(&e, "foreign_key_check"))?;
    Ok(n == 0)
}

/// 引擎版本是否达到下限；同时返回版本串供记录（§12.1 L529：实测查询，不看 crate 版本）
pub fn sqlite_version_ok(conn: &Connection) -> HostResult<(bool, String)> {
    let v: String = conn
        .query_row("SELECT sqlite_version()", [], |r| r.get(0))
        .map_err(|e| super::map_sqlite_error(&e, "sqlite_version"))?;
    let mut parts = v.splitn(3, '.');
    let major = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let patch = parts
        .next()
        .and_then(|s| s.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    Ok(((major, minor, patch) >= SQLITE_MIN_VERSION, v))
}

/// Workspace 单例行：存在则刷新 last_opened_at 并返回其 id（manifest 丢失时的身份恢复，
/// §7.1 L186）；不存在则用给定 id（或新 UUID）插入。
pub fn ensure_workspace_row(
    conn: &Connection,
    workspace_id: Option<&str>,
    name: &str,
    now_ms: i64,
) -> HostResult<String> {
    let existing: Option<String> = conn
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
        .map_err(|e| super::map_sqlite_error(&e, "workspace row"))?;

    if let Some(id) = existing {
        conn.execute(
            "UPDATE Workspace SET last_opened_at = ?1, updated_at = ?1, name = ?2 \
             WHERE workspace_id = ?3",
            rusqlite::params![now_ms, name, id],
        )
        .map_err(|e| super::map_sqlite_error(&e, "workspace row"))?;
        return Ok(id);
    }

    let id = match workspace_id {
        Some(given) => given.to_string(),
        None => uuid::Uuid::new_v4().to_string(),
    };
    conn.execute(
        "INSERT INTO Workspace (workspace_id, singleton, name, format_version, \
         created_at, updated_at, last_opened_at) VALUES (?1, 1, ?2, 1, ?3, ?3, ?3)",
        rusqlite::params![id, name, now_ms],
    )
    .map_err(|e| super::map_sqlite_error(&e, "workspace row insert"))?;
    Ok(id)
}

/// 供损坏诊断：quick_check 不通过时构造 DB_CORRUPT
pub fn corrupt_error(detail: impl std::fmt::Display) -> HostError {
    HostError::new(DB_CORRUPT, format!("数据库完整性检查未通过：{detail}"))
}
