//! commit/registry 的 IPC DTO 与纯校验（设计 §12.5、§6.2 L153：TS 计算结果只是提案，
//! Rust 命令必须再次校验）。输入 DTO `deny_unknown_fields`：把 TS 契约漂移变成响亮的
//! INDEX_FAILED，而不是静默丢字段。

use serde::{Deserialize, Serialize};

use crate::persistence::error::{HostError, HostResult, INDEX_FAILED, PATH_REJECTED};

/// 批量上限（16GB 开发机内存约束下有界事务/IPC；§15.2 常规每批 ≤50 文档）
pub const MAX_DOCUMENTS_PER_BATCH: usize = 256;
pub const MAX_PROPOSALS_PER_BATCH: usize = 20_000;
/// 单文件上限（M1 MAX_FILE_BYTES 一致）
pub const MAX_FILE_BYTES: i64 = 50 * 1024 * 1024;
/// status_reason 截断长度（诊断信息，不是正文）
const MAX_REASON_CHARS: usize = 500;
const MAX_TITLE_CHARS: usize = 2000;
/// mtime 允许的时钟偏移上限（观察值非决策依据）
const MAX_CLOCK_SKEW_MS: i64 = 24 * 60 * 60 * 1000;

fn index_failed(msg: impl Into<String>) -> HostError {
    HostError::new(INDEX_FAILED, msg.into())
}

fn idx_level(kind: &str, level: i64) -> HostError {
    index_failed(format!("{kind} 的 headingLevel 非法：{level}"))
}

// ---------------------------------------------------------------------------
// 枚举（TS 字符串 ↔ Rust；action/status/kind 与 §12.4 CHECK 值一致）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileAction {
    Create,
    UpdateMeta,
    UpdateContent,
    MarkMissing,
    KeepMissing,
    Restore,
    MarkConflict,
    DeferVerifyOldFile,
    Noop,
}

impl ReconcileAction {
    pub fn parse(s: &str) -> HostResult<Self> {
        Ok(match s {
            "CREATE" => Self::Create,
            "UPDATE_META" => Self::UpdateMeta,
            "UPDATE_CONTENT" => Self::UpdateContent,
            "MARK_MISSING" => Self::MarkMissing,
            "KEEP_MISSING" => Self::KeepMissing,
            "RESTORE" => Self::Restore,
            "MARK_CONFLICT" => Self::MarkConflict,
            "DEFER_VERIFY_OLD_FILE" => Self::DeferVerifyOldFile,
            "NOOP" => Self::Noop,
            other => return Err(index_failed(format!("未知 reconcile 动作：{other}"))),
        })
    }

    /// 是否携带 next（目标位置/内容）
    pub fn requires_next(self) -> bool {
        matches!(
            self,
            Self::Create | Self::UpdateMeta | Self::UpdateContent | Self::Restore
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockStatus {
    Active,
    Missing,
    Deleted,
    IdConflict,
}

impl BlockStatus {
    pub fn parse(s: &str) -> HostResult<Self> {
        Ok(match s {
            "ACTIVE" => Self::Active,
            "MISSING" => Self::Missing,
            "DELETED" => Self::Deleted,
            "ID_CONFLICT" => Self::IdConflict,
            other => return Err(index_failed(format!("未知 Block 状态：{other}"))),
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "ACTIVE",
            Self::Missing => "MISSING",
            Self::Deleted => "DELETED",
            Self::IdConflict => "ID_CONFLICT",
        }
    }
}

impl std::fmt::Display for BlockStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    Section,
    Preamble,
}

impl BlockKind {
    pub fn parse(s: &str) -> HostResult<Self> {
        Ok(match s {
            "SECTION" => Self::Section,
            "PREAMBLE" => Self::Preamble,
            other => return Err(index_failed(format!("未知 Block 类型：{other}"))),
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Section => "SECTION",
            Self::Preamble => "PREAMBLE",
        }
    }
}

fn parse_line_ending(s: &str) -> HostResult<&'static str> {
    Ok(match s {
        "LF" => "LF",
        "CRLF" => "CRLF",
        "MIXED" => "MIXED",
        other => return Err(index_failed(format!("未知换行枚举：{other}"))),
    })
}

// ---------------------------------------------------------------------------
// commit_index_batch 输入
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitIndexBatchRequest {
    /// 本批涉及的文档头（通常 1 个；跨文件移动 = 同批多文档，§12.5 L761）
    pub documents: Vec<DocumentHeaderDto>,
    /// 引擎提案（ReconcileReport.blockResults 原样）
    pub block_results: Vec<BlockProposalDto>,
    /// 本轮扫描的全量快照路径（MARK_MISSING 合法性核对）
    pub snapshot_paths: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentHeaderDto {
    pub relative_path: String,
    /// 索引 CAS：0 = 该 path_key 无 live 行
    pub expected_index_revision: i64,
    /// 磁盘原始字节 SHA-256（read_document.rawByteHash）
    pub observed_hash: String,
    pub parser_version: String,
    pub byte_size: i64,
    /// read_document.mtime_ms（观察值，非决策依据）
    pub mtime_ms: i64,
    pub line_ending: String,
    pub has_bom: bool,
    pub diagnostics: Vec<DiagnosticDto>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticDto {
    pub code: String,
    pub block_id: Option<String>,
    pub start_offset: i64,
    pub end_offset: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockProposalDto {
    pub block_id: String,
    pub action: String,
    /// 引擎断言的目标状态；Rust 重推导，不符 → INDEX_FAILED
    pub status: String,
    pub relative_path: Option<String>,
    pub next: Option<BlockNextDto>,
    pub change_class: Option<String>,
    pub content_version_delta: i64,
    pub needs_recheck: bool,
    pub prev: Option<PrevRefDto>,
    pub reason: String,
    /// 核对证据；不落库（§12.2：重复位置只存诊断）
    pub occurrences: Vec<OccurrenceDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockNextDto {
    pub block_id: Option<String>,
    pub kind: String,
    pub title: Option<String>,
    pub heading_level: i64,
    pub heading_path: Vec<String>,
    pub ordinal: i64,
    pub start_offset: i64,
    pub body_start_offset: i64,
    pub end_offset: i64,
    pub source_hash: String,
    pub body_hash: String,
    /// 已接受不落库（无对应列；BLOCK_OVERSIZED 经 diagnostics 传递）
    pub oversized: bool,
    pub relative_path: String,
    pub content_version: i64,
    pub needs_recheck: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrevRefDto {
    pub relative_path: String,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OccurrenceDto {
    pub relative_path: String,
    pub ordinal: Option<i64>,
    pub comment_start: i64,
    pub comment_end: i64,
    pub placement: String,
    pub in_qualified_block: bool,
}

// ---------------------------------------------------------------------------
// commit_index_batch 输出
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitIndexBatchResult {
    pub documents: Vec<DocumentCommitOutcomeDto>,
    pub blocks: Vec<BlockCommitOutcomeDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCommitOutcomeDto {
    pub document_id: String,
    pub relative_path: String,
    pub index_revision: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockCommitOutcomeDto {
    pub block_id: String,
    pub action: String,
    /// false = 幂等 NOOP（行已等于提案，未写入）
    pub applied: bool,
    pub content_version: i64,
    pub needs_recheck: bool,
    pub status: String,
}

// ---------------------------------------------------------------------------
// registry 输出（reconcile 输入；RegisteredBlock 的 DB 超集）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySnapshot {
    /// 非 DELETED 文档（DELETED 的 path_key 已释放）
    pub documents: Vec<DocumentRegistryDto>,
    /// 全部 Block（含 DELETED/ID_CONFLICT——tombstone 复现检测，§9.4 L358）
    pub blocks: Vec<RegisteredBlockDto>,
    /// Settings "recovery.mode"（§12.6 L798：恢复模式必须在 UI 明示）
    pub recovery_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRegistryDto {
    pub document_id: String,
    pub relative_path: String,
    pub status: String,
    pub index_status: String,
    /// TS 回传为 expectedIndexRevision
    pub index_revision: i64,
    pub observed_hash: Option<String>,
    pub content_hash: Option<String>,
    pub parser_version: Option<String>,
    pub byte_size: Option<i64>,
    pub disk_mtime_at: Option<i64>,
    pub line_ending: String,
    pub has_bom: bool,
    pub last_seen_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredBlockDto {
    pub block_id: String,
    /// 移动中稳定的身份（relativePath 会变）
    pub document_id: String,
    pub relative_path: String,
    pub kind: String,
    pub heading_level: i64,
    pub title: Option<String>,
    pub heading_path: Vec<String>,
    pub ordinal: i64,
    pub start_offset: i64,
    pub body_start_offset: i64,
    pub end_offset: i64,
    pub source_hash: String,
    pub body_hash: String,
    pub content_version: i64,
    pub status: String,
    pub status_reason: Option<String>,
    pub participation: String,
    pub needs_recheck: bool,
    /// first_review_at IS NOT NULL（"此前从未评分"判定，§10.2 L399）
    pub has_rating: bool,
    pub missing_since: Option<i64>,
    pub last_seen_at: i64,
}

// ---------------------------------------------------------------------------
// 纯校验（Phase 0；全部在进事务前完成）
// ---------------------------------------------------------------------------

fn validate_uuid_v4(s: &str, what: &str) -> HostResult<()> {
    let ok = uuid::Uuid::parse_str(s)
        .map(|u| u.get_version_num() == 4 && u.to_string() == s)
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(index_failed(format!("{what} 不是规范小写 UUIDv4：{s}")))
    }
}

fn validate_hash64(s: &str, what: &str) -> HostResult<()> {
    let ok = s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if ok {
        Ok(())
    } else {
        Err(index_failed(format!("{what} 不是 64 位小写十六进制哈希")))
    }
}

fn validate_relative_path(rel: &str) -> HostResult<()> {
    crate::persistence::paths::validate_relative_path(rel)
        .map(|_| ())
        .map_err(|_| HostError::new(PATH_REJECTED, format!("非法相对路径：{rel}")))
}

/// Windows 比较键：Unicode 小写归一（§12.3 L591，不依赖 SQLite NOCASE）
pub fn path_key_of(relative_path: &str) -> String {
    relative_path.to_lowercase()
}

/// 全批校验；返回规范化后的 reason 截断等信息由调用方使用
pub fn validate_batch(req: &CommitIndexBatchRequest) -> HostResult<()> {
    if req.documents.is_empty() {
        return Err(index_failed("commit 批缺少文档头"));
    }
    if req.documents.len() > MAX_DOCUMENTS_PER_BATCH {
        return Err(index_failed(format!(
            "单批文档数 {} 超上限 {MAX_DOCUMENTS_PER_BATCH}",
            req.documents.len()
        )));
    }
    if req.block_results.len() > MAX_PROPOSALS_PER_BATCH {
        return Err(index_failed(format!(
            "单批提案数 {} 超上限 {MAX_PROPOSALS_PER_BATCH}",
            req.block_results.len()
        )));
    }

    let now = crate::persistence::store::now_ms();

    for doc in &req.documents {
        validate_relative_path(&doc.relative_path)?;
        validate_hash64(&doc.observed_hash, "observedHash")?;
        if doc.parser_version.is_empty() || doc.parser_version.len() > 128 {
            return Err(index_failed("parserVersion 长度须在 1..=128"));
        }
        if !(0..=MAX_FILE_BYTES).contains(&doc.byte_size) {
            return Err(index_failed(format!("byteSize 超界：{}", doc.byte_size)));
        }
        if !(0..=now + MAX_CLOCK_SKEW_MS).contains(&doc.mtime_ms) {
            return Err(index_failed(format!("mtimeMs 超界：{}", doc.mtime_ms)));
        }
        parse_line_ending(&doc.line_ending)?;
        if let Some(id) = &doc
            .diagnostics
            .iter()
            .filter_map(|d| d.block_id.as_deref())
            .next()
        {
            validate_uuid_v4(id, "diagnostics.blockId")?;
        }
    }

    for p in &req.block_results {
        validate_uuid_v4(&p.block_id, "blockId")?;
        let action = ReconcileAction::parse(&p.action)?;
        BlockStatus::parse(&p.status)?;
        if action.requires_next() != p.next.is_some() {
            return Err(index_failed(format!(
                "动作 {} 的 next 携带不符（requires_next={}）",
                p.action,
                action.requires_next()
            )));
        }
        if !(0..=1).contains(&p.content_version_delta) {
            return Err(index_failed(format!(
                "contentVersionDelta 须为 0/1，得到 {}",
                p.content_version_delta
            )));
        }
        if p.reason.chars().count() > MAX_REASON_CHARS * 4 {
            return Err(index_failed("reason 过长"));
        }
        if let Some(next) = &p.next {
            if let Some(id) = &next.block_id {
                validate_uuid_v4(id, "next.blockId")?;
                if id != &p.block_id {
                    return Err(index_failed("next.blockId 须等于提案 blockId"));
                }
            }
            let kind = BlockKind::parse(&next.kind)?;
            let level_ok = match kind {
                BlockKind::Preamble => next.heading_level == 0,
                BlockKind::Section => (1..=6).contains(&next.heading_level),
            };
            if !level_ok {
                return Err(idx_level(&next.kind, next.heading_level));
            }
            if next.ordinal < 0 {
                return Err(index_failed("ordinal 须非负"));
            }
            if !(0 <= next.start_offset
                && next.start_offset <= next.body_start_offset
                && next.body_start_offset <= next.end_offset)
            {
                return Err(index_failed("offset 须满足 0 ≤ start ≤ bodyStart ≤ end"));
            }
            validate_hash64(&next.source_hash, "next.sourceHash")?;
            validate_hash64(&next.body_hash, "next.bodyHash")?;
            if next.content_version < 1 {
                return Err(index_failed("next.contentVersion 须 ≥ 1"));
            }
            if let Some(t) = &next.title {
                if t.chars().count() > MAX_TITLE_CHARS {
                    return Err(index_failed("title 过长"));
                }
            }
            validate_relative_path(&next.relative_path)?;
            // 目标文档必须在本批（跨文件移动同批处理，§12.5 L761）
            if !req
                .documents
                .iter()
                .any(|d| d.relative_path == next.relative_path)
            {
                return Err(index_failed(format!(
                    "next.relativePath {} 不在本批文档头中",
                    next.relative_path
                )));
            }
        }
        if let Some(prev) = &p.prev {
            validate_relative_path(&prev.relative_path)?;
            BlockStatus::parse(&prev.status)?;
        }
        if action == ReconcileAction::MarkConflict && p.occurrences.len() < 2 {
            return Err(index_failed("MARK_CONFLICT 须携带 ≥2 处出现证据"));
        }
    }

    // ordinal 在 (document, batch) 内唯一
    for doc in &req.documents {
        let mut ordinals: Vec<i64> = req
            .block_results
            .iter()
            .filter_map(|p| {
                p.next
                    .as_ref()
                    .filter(|n| n.relative_path == doc.relative_path)
                    .map(|n| n.ordinal)
            })
            .collect();
        ordinals.sort_unstable();
        if ordinals.windows(2).any(|w| w[0] == w[1]) {
            return Err(index_failed(format!(
                "文档 {} 批内 ordinal 重复",
                doc.relative_path
            )));
        }
    }

    Ok(())
}

/// reason 落库截断（char 边界，非字节）
pub fn truncate_reason(reason: &str) -> String {
    reason.chars().take(MAX_REASON_CHARS).collect()
}
