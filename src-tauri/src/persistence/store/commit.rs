//! `commit_index_batch`：单事务落库（设计 §12.5 L761、§13.1 L830）。
//!
//! 结构：Phase0 纯校验 → 开事务（Immediate）→ 装载与 CAS → **推演**（差分 + 幂等
//! NOOP 判定，不写库；dirty 标记走 Cell）→ 按序落 SQL（先 Document 后
//! Block/ReviewState，FK 依赖序）→ 提交。任何一步失败整批回滚（§14.4 行 4）。

use rusqlite::{Connection, Transaction};

use super::super::error::{HostError, HostResult, DB_BUSY, DB_CORRUPT, INDEX_FAILED, STALE_INDEX};
use super::dto::{
    truncate_reason, validate_batch, BlockNextDto, BlockProposalDto, BlockStatus,
    BlockCommitOutcomeDto, CommitIndexBatchRequest, CommitIndexBatchResult,
    DocumentCommitOutcomeDto, DocumentHeaderDto, ReconcileAction,
};
use super::fsrs;
use super::query;
use super::{map_sqlite_error, now_ms};

fn idx(msg: impl Into<String>) -> HostError {
    HostError::new(INDEX_FAILED, msg.into())
}

/// 事务内 SQL 失败的统一映射：忙/损坏保持原码，其余归为 INDEX_FAILED
fn sqlx(e: rusqlite::Error, ctx: &str) -> HostError {
    let mapped = map_sqlite_error(&e, ctx);
    if mapped.code == DB_BUSY || mapped.code == DB_CORRUPT {
        mapped
    } else {
        idx(format!("{ctx}：{e}"))
    }
}

// ---------------------------------------------------------------------------
// 装载的行结构
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct DocRow {
    document_id: String,
    index_revision: i64,
    status: String,
    index_status: String,
    content_hash: Option<String>,
    parser_version: Option<String>,
    diagnostics_json: String,
}

#[derive(Debug, Clone)]
struct BlockRow {
    document_id: String,
    kind: String,
    title: Option<String>,
    heading_level: i64,
    heading_path_json: String,
    ordinal: i64,
    start_offset: i64,
    body_start_offset: i64,
    end_offset: i64,
    source_hash: String,
    body_hash: String,
    content_version: i64,
    status: String,
}

#[derive(Debug, Clone)]
struct ReviewRow {
    participation: String,
    first_review_at: Option<i64>,
    needs_recheck: bool,
}

fn load_live_doc(tx: &Transaction, workspace_id: &str, path_key: &str) -> HostResult<Option<DocRow>> {
    tx.query_row(
        "SELECT document_id, index_revision, status, index_status, content_hash, \
         parser_version, diagnostics_json \
         FROM Document WHERE workspace_id = ?1 AND path_key = ?2 AND status <> 'DELETED'",
        rusqlite::params![workspace_id, path_key],
        |r| {
            Ok(DocRow {
                document_id: r.get(0)?,
                index_revision: r.get(1)?,
                status: r.get(2)?,
                index_status: r.get(3)?,
                content_hash: r.get(4)?,
                parser_version: r.get(5)?,
                diagnostics_json: r.get(6)?,
            })
        },
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
    .map_err(|e| sqlx(e, "读取 Document"))
}

fn load_block(tx: &Transaction, block_id: &str) -> HostResult<Option<BlockRow>> {
    tx.query_row(
        "SELECT document_id, kind, title, heading_level, heading_path_json, ordinal, \
         start_offset, body_start_offset, end_offset, source_hash, body_hash, \
         content_version, status \
         FROM KnowledgeBlock WHERE block_id = ?1",
        rusqlite::params![block_id],
        |r| {
            Ok(BlockRow {
                document_id: r.get(0)?,
                kind: r.get(1)?,
                title: r.get(2)?,
                heading_level: r.get(3)?,
                heading_path_json: r.get(4)?,
                ordinal: r.get(5)?,
                start_offset: r.get(6)?,
                body_start_offset: r.get(7)?,
                end_offset: r.get(8)?,
                source_hash: r.get(9)?,
                body_hash: r.get(10)?,
                content_version: r.get(11)?,
                status: r.get(12)?,
            })
        },
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
    .map_err(|e| sqlx(e, "读取 KnowledgeBlock"))
}

fn load_review(tx: &Transaction, block_id: &str) -> HostResult<Option<ReviewRow>> {
    tx.query_row(
        "SELECT participation, first_review_at, needs_recheck FROM ReviewState WHERE block_id = ?1",
        rusqlite::params![block_id],
        |r| {
            Ok(ReviewRow {
                participation: r.get(0)?,
                first_review_at: r.get(1)?,
                needs_recheck: r.get::<_, i64>(2)? == 1,
            })
        },
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
    .map_err(|e| sqlx(e, "读取 ReviewState"))
}

// ---------------------------------------------------------------------------
// 批内文档计划（推演阶段经 Cell 标脏，写入阶段读回）
// ---------------------------------------------------------------------------

struct DocPlan {
    path_key: String,
    header: DocumentHeaderDto,
    existing: Option<DocRow>,
    dirty: std::cell::Cell<bool>,
    /// 新插入文档的 id（写入阶段回填；块写入阶段读取）
    new_id: Option<String>,
}

impl DocPlan {
    fn mark_dirty(&self) {
        self.dirty.set(true);
    }
}

/// 目标路径对应的既有 document_id（None = 本批新文档或不在批内）
fn target_doc_id<'a>(docs: &'a [DocPlan], path_key: &str) -> Option<&'a str> {
    docs.iter()
        .find(|d| d.path_key == path_key)
        .and_then(|d| d.existing.as_ref().map(|e| e.document_id.as_str()))
}

// ---------------------------------------------------------------------------
// 推演产物
// ---------------------------------------------------------------------------

enum BlockWrite {
    /// 幂等跳过 / NOOP / DEFER：零写入
    None,
    Create { paused: bool },
    Relocate { advance_content: bool, recheck: bool },
    MarkMissing,
    MarkConflict,
}

struct Planned {
    block_id: String,
    action_label: String,
    applied: bool,
    write: BlockWrite,
    reason: String,
    next: Option<BlockNextDto>,
    final_status: String,
    final_content_version: i64,
    final_needs_recheck: bool,
}

/// 历史丢失重建模式：新登记块 PAUSED（§12.6 L798；恢复模式须在 UI 明示）
fn is_history_loss_mode(mode: &Option<String>) -> bool {
    matches!(
        mode.as_deref(),
        Some("REBUILT_NO_HISTORY") | Some("QUARANTINED_CORRUPT")
    )
}

fn heading_path_json(next: &BlockNextDto) -> String {
    serde_json::to_string(&next.heading_path).unwrap_or_else(|_| "[]".into())
}

/// next 定位字段是否与已有行一致（幂等判定；时间戳列不参与，§12.5 L766）
fn relocate_fields_equal(existing: &BlockRow, next: &BlockNextDto, binding_equal: bool) -> bool {
    binding_equal
        && existing.kind == next.kind
        && existing.title == next.title
        && existing.heading_level == next.heading_level
        && existing.heading_path_json == heading_path_json(next)
        && existing.ordinal == next.ordinal
        && existing.start_offset == next.start_offset
        && existing.body_start_offset == next.body_start_offset
        && existing.end_offset == next.end_offset
        && existing.source_hash == next.source_hash
        && existing.body_hash == next.body_hash
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

pub fn commit_on(
    conn: &mut Connection,
    req: &CommitIndexBatchRequest,
) -> HostResult<CommitIndexBatchResult> {
    // Phase 0：纯校验（失败不触碰数据库）
    validate_batch(req)?;

    let now = now_ms();
    let due24 = now + fsrs::FIRST_DUE_OFFSET_MS;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| sqlx(e, "开启事务"))?;

    let workspace_id: String = tx
        .query_row(
            "SELECT workspace_id FROM Workspace WHERE singleton = 1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| sqlx(e, "读取 Workspace"))?;

    let recovery_mode = query::settings_get(&tx, "recovery.mode")?;
    let paused_creates = is_history_loss_mode(&recovery_mode);

    // ---- Phase 1：装载文档行 + CAS（§12.5：expectedIndexRevision）----
    let mut docs: Vec<DocPlan> = Vec::with_capacity(req.documents.len());
    for header in &req.documents {
        let path_key = super::dto::path_key_of(&header.relative_path);
        if docs.iter().any(|d| d.path_key == path_key) {
            return Err(idx(format!("批内路径重复：{}", header.relative_path)));
        }
        let existing = load_live_doc(&tx, &workspace_id, &path_key)?;
        match &existing {
            Some(row) => {
                if header.expected_index_revision != row.index_revision {
                    return Err(HostError::new(
                        STALE_INDEX,
                        format!(
                            "索引版本过期：{} 期望 {} 实为 {}，请重读注册表后重试",
                            header.relative_path, header.expected_index_revision, row.index_revision
                        ),
                    )
                    .with_path(header.relative_path.clone()));
                }
            }
            None => {
                if header.expected_index_revision != 0 {
                    return Err(HostError::new(
                        STALE_INDEX,
                        format!(
                            "路径 {} 当前无有效登记（expectedIndexRevision 应为 0，得到 {}）",
                            header.relative_path, header.expected_index_revision
                        ),
                    )
                    .with_path(header.relative_path.clone()));
                }
            }
        }
        docs.push(DocPlan {
            path_key,
            header: header.clone(),
            existing,
            dirty: std::cell::Cell::new(false),
            new_id: None,
        });
    }

    let snapshot_set: std::collections::HashSet<&str> =
        req.snapshot_paths.iter().map(String::as_str).collect();

    // ---- Phase 2：推演（零写入）----
    let mut planned: Vec<Planned> = Vec::with_capacity(req.block_results.len());
    for p in &req.block_results {
        planned.push(derive_proposal(&tx, p, &docs, &snapshot_set, paused_creates)?);
    }

    // ---- Phase 3a：Document 写入（先于块，满足 FK）----
    let mut doc_outcomes: Vec<DocumentCommitOutcomeDto> = Vec::with_capacity(docs.len());
    for d in &mut docs {
        let header = &d.header;
        let diag_json =
            serde_json::to_string(&header.diagnostics).unwrap_or_else(|_| "[]".into());
        let noop = match &d.existing {
            Some(row) => {
                // §12.5 L766：全部输入/派生字段相同的纯重索引 = 幂等 no-op，零写入
                !d.dirty.get()
                    && row.status == "PRESENT"
                    && row.index_status == "READY"
                    && row.content_hash.as_deref() == Some(header.observed_hash.as_str())
                    && row.parser_version.as_deref() == Some(header.parser_version.as_str())
                    && row.diagnostics_json == diag_json
            }
            None => false,
        };
        let revision = if noop {
            d.existing.as_ref().map(|r| r.index_revision).unwrap_or(0)
        } else if let Some(row) = &d.existing {
            tx.execute(
                "UPDATE Document SET status = 'PRESENT', index_status = 'READY', \
                 observed_hash = ?1, content_hash = ?1, byte_size = ?2, disk_mtime_at = ?3, \
                 line_ending = ?4, has_bom = ?5, parser_version = ?6, diagnostics_json = ?7, \
                 index_revision = index_revision + 1, updated_at = ?8, last_seen_at = ?8, \
                 missing_since = NULL, deleted_at = NULL \
                 WHERE document_id = ?9",
                rusqlite::params![
                    header.observed_hash,
                    header.byte_size,
                    header.mtime_ms,
                    header.line_ending,
                    header.has_bom as i64,
                    header.parser_version,
                    diag_json,
                    now,
                    row.document_id,
                ],
            )
            .map_err(|e| sqlx(e, "更新 Document"))?;
            row.index_revision + 1
        } else {
            let new_id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO Document (document_id, workspace_id, relative_path, path_key, \
                 status, index_status, encoding, line_ending, has_bom, observed_hash, \
                 content_hash, byte_size, disk_mtime_at, index_revision, parser_version, \
                 diagnostics_json, created_at, updated_at, last_seen_at) \
                 VALUES (?1, ?2, ?3, ?4, 'PRESENT', 'READY', 'UTF-8', ?5, ?6, ?7, ?7, ?8, \
                 ?9, 1, ?10, ?11, ?12, ?12, ?12)",
                rusqlite::params![
                    new_id,
                    workspace_id,
                    header.relative_path,
                    d.path_key,
                    header.line_ending,
                    header.has_bom as i64,
                    header.observed_hash,
                    header.byte_size,
                    header.mtime_ms,
                    header.parser_version,
                    diag_json,
                    now,
                ],
            )
            .map_err(|e| sqlx(e, "插入 Document"))?;
            d.new_id = Some(new_id);
            1
        };
        let document_id = d
            .existing
            .as_ref()
            .map(|r| r.document_id.clone())
            .or_else(|| d.new_id.clone())
            .unwrap_or_default();
        doc_outcomes.push(DocumentCommitOutcomeDto {
            document_id,
            relative_path: header.relative_path.clone(),
            index_revision: revision,
        });
    }

    // 块写入阶段解析目标 document_id（新插入的在 3a 已回填）
    let final_doc_id = |path_key: &str| -> String {
        for d in &docs {
            if d.path_key == path_key {
                return d
                    .new_id
                    .clone()
                    .or_else(|| d.existing.as_ref().map(|e| e.document_id.clone()))
                    .unwrap_or_default();
            }
        }
        String::new()
    };

    // ---- Phase 3b：Block / ReviewState 写入 ----
    let mut block_outcomes = Vec::with_capacity(planned.len());
    for plan in planned {
        if plan.applied {
            apply_block_write(&tx, &plan, &final_doc_id, now, due24)?;
        }
        block_outcomes.push(BlockCommitOutcomeDto {
            block_id: plan.block_id,
            action: plan.action_label,
            applied: plan.applied,
            content_version: plan.final_content_version,
            needs_recheck: plan.final_needs_recheck,
            status: plan.final_status,
        });
    }

    tx.commit().map_err(|e| sqlx(e, "提交事务"))?;
    Ok(CommitIndexBatchResult {
        documents: doc_outcomes,
        blocks: block_outcomes,
    })
}

fn apply_block_write(
    tx: &Transaction,
    plan: &Planned,
    final_doc_id: &dyn Fn(&str) -> String,
    now: i64,
    due24: i64,
) -> HostResult<()> {
    use rusqlite::params;
    let reason = truncate_reason(&plan.reason);
    match &plan.write {
        BlockWrite::None => Ok(()),
        BlockWrite::Create { paused } => {
            let next = plan.next.as_ref().expect("CREATE 必带 next");
            let doc_id = final_doc_id(&super::dto::path_key_of(&next.relative_path));
            tx.execute(
                "INSERT INTO KnowledgeBlock (block_id, document_id, kind, title, \
                 heading_level, heading_path_json, ordinal, start_offset, body_start_offset, \
                 end_offset, source_hash, body_hash, content_version, status, status_reason, \
                 created_at, updated_at, content_modified_at, last_seen_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'ACTIVE', \
                 ?14, ?15, ?15, ?15, ?15)",
                params![
                    plan.block_id,
                    doc_id,
                    next.kind,
                    next.title,
                    next.heading_level,
                    heading_path_json(next),
                    next.ordinal,
                    next.start_offset,
                    next.body_start_offset,
                    next.end_offset,
                    next.source_hash,
                    next.body_hash,
                    next.content_version,
                    reason,
                    now,
                ],
            )
            .map_err(|e| sqlx(e, "插入 KnowledgeBlock"))?;
            // §10.2 L394：NEW + 空算法状态 + 首提 24h；原生 due 同步为首 due
            let state_json = fsrs::empty_card_state_json(due24)?;
            tx.execute(
                "INSERT INTO ReviewState (block_id, participation, phase, generation, \
                 state_revision, algorithm_id, algorithm_version, state_schema_version, \
                 config_json, state_json, scheduled_due_at, change_due_at, interval_ms, reps, \
                 lapses, first_review_at, last_review_at, needs_recheck, \
                 last_reviewed_content_version, created_at, updated_at) \
                 VALUES (?1, ?2, 'NEW', 0, 0, ?3, ?4, ?5, ?6, ?7, ?8, NULL, 0, 0, 0, NULL, \
                 NULL, 0, NULL, ?9, ?9)",
                params![
                    plan.block_id,
                    if *paused { "PAUSED" } else { "ENABLED" },
                    fsrs::ALGORITHM_ID,
                    fsrs::ALGORITHM_VERSION,
                    fsrs::STATE_SCHEMA_VERSION,
                    fsrs::CONFIG_JSON,
                    state_json,
                    due24,
                    now,
                ],
            )
            .map_err(|e| sqlx(e, "插入 ReviewState"))?;
            Ok(())
        }
        BlockWrite::Relocate {
            advance_content,
            recheck,
        } => {
            let next = plan.next.as_ref().expect("RELOCATE 必带 next");
            let doc_id = final_doc_id(&super::dto::path_key_of(&next.relative_path));
            if *advance_content {
                tx.execute(
                    "UPDATE KnowledgeBlock SET document_id = ?1, kind = ?2, title = ?3, \
                     heading_level = ?4, heading_path_json = ?5, ordinal = ?6, \
                     start_offset = ?7, body_start_offset = ?8, end_offset = ?9, \
                     source_hash = ?10, body_hash = ?11, status = 'ACTIVE', status_reason = ?12, \
                     missing_since = NULL, deleted_at = NULL, content_version = ?13, \
                     content_modified_at = ?14, last_seen_at = ?14, updated_at = ?14 \
                     WHERE block_id = ?15",
                    params![
                        doc_id,
                        next.kind,
                        next.title,
                        next.heading_level,
                        heading_path_json(next),
                        next.ordinal,
                        next.start_offset,
                        next.body_start_offset,
                        next.end_offset,
                        next.source_hash,
                        next.body_hash,
                        reason,
                        next.content_version,
                        now,
                        plan.block_id,
                    ],
                )
                .map_err(|e| sqlx(e, "更新 KnowledgeBlock（内容）"))?;
            } else {
                tx.execute(
                    "UPDATE KnowledgeBlock SET document_id = ?1, kind = ?2, title = ?3, \
                     heading_level = ?4, heading_path_json = ?5, ordinal = ?6, \
                     start_offset = ?7, body_start_offset = ?8, end_offset = ?9, \
                     source_hash = ?10, body_hash = ?11, status = 'ACTIVE', status_reason = ?12, \
                     missing_since = NULL, deleted_at = NULL, last_seen_at = ?13, \
                     updated_at = ?13 WHERE block_id = ?14",
                    params![
                        doc_id,
                        next.kind,
                        next.title,
                        next.heading_level,
                        heading_path_json(next),
                        next.ordinal,
                        next.start_offset,
                        next.body_start_offset,
                        next.end_offset,
                        next.source_hash,
                        next.body_hash,
                        reason,
                        now,
                        plan.block_id,
                    ],
                )
                .map_err(|e| sqlx(e, "更新 KnowledgeBlock（位置）"))?;
            }
            if *recheck {
                // §10.3 L410：已评分或暂停/排除段的实质变化 → 提前确认窗口（只早不晚）
                tx.execute(
                    "UPDATE ReviewState SET needs_recheck = 1, \
                     change_due_at = CASE WHEN change_due_at IS NULL THEN ?1 \
                         ELSE MIN(change_due_at, ?1) END, \
                     state_revision = state_revision + 1, updated_at = ?2 \
                     WHERE block_id = ?3",
                    params![due24, now, plan.block_id],
                )
                .map_err(|e| sqlx(e, "更新 ReviewState（recheck）"))?;
            }
            Ok(())
        }
        BlockWrite::MarkMissing => {
            tx.execute(
                "UPDATE KnowledgeBlock SET status = 'MISSING', \
                 missing_since = COALESCE(missing_since, ?1), status_reason = ?2, \
                 updated_at = ?1 WHERE block_id = ?3",
                params![now, reason, plan.block_id],
            )
            .map_err(|e| sqlx(e, "标记缺失"))?;
            Ok(())
        }
        BlockWrite::MarkConflict => {
            tx.execute(
                "UPDATE KnowledgeBlock SET status = 'ID_CONFLICT', status_reason = ?1, \
                 updated_at = ?2 WHERE block_id = ?3",
                params![reason, now, plan.block_id],
            )
            .map_err(|e| sqlx(e, "标记冲突"))?;
            Ok(())
        }
    }
}

/// 推演单个提案：决定写入类别、幂等跳过与终态；失败即整批拒绝
fn derive_proposal(
    tx: &Transaction,
    p: &BlockProposalDto,
    docs: &[DocPlan],
    snapshot_set: &std::collections::HashSet<&str>,
    paused_creates: bool,
) -> HostResult<Planned> {
    let action = ReconcileAction::parse(&p.action)?;
    let asserted = BlockStatus::parse(&p.status)?;
    let existing = load_block(tx, &p.block_id)?;
    let review = load_review(tx, &p.block_id)?;

    macro_rules! outcome {
        ($applied:expr, $write:expr, $next:expr, $status:expr, $cv:expr, $recheck:expr) => {
            return Ok(Planned {
                block_id: p.block_id.clone(),
                action_label: p.action.clone(),
                applied: $applied,
                write: $write,
                reason: p.reason.clone(),
                next: $next,
                final_status: $status.to_string(),
                final_content_version: $cv,
                final_needs_recheck: $recheck,
            })
        };
    }

    let review_recheck = review.as_ref().map(|r| r.needs_recheck).unwrap_or(false);

    match action {
        ReconcileAction::Create => {
            if asserted != BlockStatus::Active {
                return Err(idx("CREATE 的目标状态须为 ACTIVE"));
            }
            let next = p.next.clone().expect("validate_batch 已保证");
            if next.content_version != 1 {
                return Err(idx("CREATE 的 contentVersion 须为 1"));
            }
            match (&existing, &review) {
                (Some(row), Some(rv)) => {
                    // 线级重放幂等：已登记且字段一致 → 零写入（§12.5 L766）
                    let key = super::dto::path_key_of(&next.relative_path);
                    let binding_equal =
                        target_doc_id(docs, &key) == Some(row.document_id.as_str());
                    if row.status == "ACTIVE"
                        && row.content_version == 1
                        && relocate_fields_equal(row, &next, binding_equal)
                    {
                        outcome!(
                            false,
                            BlockWrite::None,
                            None,
                            BlockStatus::Active,
                            1,
                            rv.needs_recheck
                        );
                    }
                    Err(idx(format!(
                        "CREATE 提案但 Block {} 已登记且不一致（引擎与数据库分歧，请重读注册表）",
                        p.block_id
                    )))
                }
                (None, _) => {
                    let key = super::dto::path_key_of(&next.relative_path);
                    docs.iter()
                        .find(|d| d.path_key == key)
                        .unwrap_or_else(|| panic!("validate_batch 已校验 next 在批内"))
                        .mark_dirty();
                    outcome!(
                        true,
                        BlockWrite::Create {
                            paused: paused_creates
                        },
                        Some(next),
                        BlockStatus::Active,
                        1,
                        false
                    );
                }
                (Some(_), None) => Err(idx(format!(
                    "Block {} 有行但缺 ReviewState（库不一致）",
                    p.block_id
                ))),
            }
        }
        ReconcileAction::UpdateMeta | ReconcileAction::UpdateContent | ReconcileAction::Restore => {
            if asserted != BlockStatus::Active {
                return Err(idx(format!("{} 的目标状态须为 ACTIVE", p.action)));
            }
            let next = p.next.clone().expect("validate_batch 已保证");
            let row = existing.as_ref().ok_or_else(|| {
                idx(format!("{} 提案但 Block {} 未登记", p.action, p.block_id))
            })?;
            let rv = review
                .as_ref()
                .ok_or_else(|| idx(format!("Block {} 缺 ReviewState（库不一致）", p.block_id)))?;
            let body_changed = next.body_hash != row.body_hash;
            match action {
                ReconcileAction::UpdateMeta => {
                    if body_changed {
                        return Err(idx(
                            "UPDATE_META 提案携带了新 bodyHash，应分类为 UPDATE_CONTENT",
                        ));
                    }
                    if p.content_version_delta != 0 {
                        return Err(idx("UPDATE_META 的 contentVersionDelta 须为 0"));
                    }
                }
                ReconcileAction::UpdateContent => {
                    if !body_changed {
                        // 已落地的内容变更原样重发（响应丢失后的线级重试）→ 幂等跳过
                        let target_key0 = super::dto::path_key_of(&next.relative_path);
                        let binding_equal0 =
                            target_doc_id(docs, &target_key0) == Some(row.document_id.as_str());
                        if p.content_version_delta == 1
                            && next.content_version == row.content_version
                            && relocate_fields_equal(row, &next, binding_equal0)
                            && row.status == "ACTIVE"
                        {
                            outcome!(
                                false,
                                BlockWrite::None,
                                None,
                                BlockStatus::Active,
                                row.content_version,
                                rv.needs_recheck
                            );
                        }
                        return Err(idx(
                            "UPDATE_CONTENT 提案 bodyHash 未变化（应分类 UPDATE_META/NOOP）",
                        ));
                    }
                    if p.content_version_delta != 1 {
                        return Err(idx("UPDATE_CONTENT 的 contentVersionDelta 须为 1"));
                    }
                }
                ReconcileAction::Restore => {
                    if row.status != "MISSING" && row.status != "DELETED" {
                        return Err(idx(format!(
                            "RESTORE 仅用于缺失/已删除块的复现，当前为 {}",
                            row.status
                        )));
                    }
                    let expected_delta = if body_changed { 1 } else { 0 };
                    if p.content_version_delta != expected_delta {
                        return Err(idx(format!(
                            "RESTORE 的 contentVersionDelta 须为 {expected_delta}"
                        )));
                    }
                }
                _ => unreachable!(),
            }
            if next.content_version != row.content_version + p.content_version_delta {
                return Err(idx(format!(
                    "contentVersion 不连续：现 {} + delta {} ≠ 提案 {}",
                    row.content_version, p.content_version_delta, next.content_version
                )));
            }
            // §10.3 行3/4/5：未首评 ENABLED 段不设 recheck；其余实质变化设 recheck
            let recheck = p.content_version_delta == 1
                && (rv.first_review_at.is_some() || rv.participation != "ENABLED");
            if p.needs_recheck != recheck {
                return Err(idx(format!(
                    "needsRecheck 重推导不符：提案 {} 实算 {}",
                    p.needs_recheck, recheck
                )));
            }
            let target_key = super::dto::path_key_of(&next.relative_path);
            let binding_equal =
                target_doc_id(docs, &target_key) == Some(row.document_id.as_str());
            if relocate_fields_equal(row, &next, binding_equal)
                && p.content_version_delta == 0
                && row.status == "ACTIVE"
            {
                // 幂等重放：字段未变（UPDATE_META 全等）
                outcome!(
                    false,
                    BlockWrite::None,
                    None,
                    BlockStatus::Active,
                    row.content_version,
                    rv.needs_recheck
                );
            }
            // 目标文档必脏；绑定变化时旧文档（若在本批）也脏
            docs.iter()
                .find(|d| d.path_key == target_key)
                .expect("validate_batch 已校验 next 在批内")
                .mark_dirty();
            if !binding_equal {
                if let Some(old) = docs
                    .iter()
                    .find(|d| {
                        d.existing
                            .as_ref()
                            .map(|e| e.document_id.as_str())
                            == Some(row.document_id.as_str())
                    })
                {
                    old.mark_dirty();
                }
            }
            outcome!(
                true,
                BlockWrite::Relocate {
                    advance_content: p.content_version_delta == 1,
                    recheck,
                },
                Some(next),
                BlockStatus::Active,
                p.next.as_ref().expect("checked").content_version,
                recheck || rv.needs_recheck
            );
        }
        ReconcileAction::MarkMissing | ReconcileAction::KeepMissing => {
            if asserted != BlockStatus::Missing {
                return Err(idx(format!("{} 的目标状态须为 MISSING", p.action)));
            }
            let prev = p.prev.as_ref().ok_or_else(|| idx("缺少 prev 证据"))?;
            if !snapshot_set.contains(prev.relative_path.as_str()) {
                return Err(idx(format!(
                    "{} 的 prev 路径 {} 不在本轮快照集合（未扫描的文件不能断定消失，应 DEFER）",
                    p.action, prev.relative_path
                )));
            }
            let row = existing.as_ref().ok_or_else(|| {
                idx(format!("{} 提案但 Block {} 未登记", p.action, p.block_id))
            })?;
            match row.status.as_str() {
                "MISSING" => outcome!(
                    false,
                    BlockWrite::None,
                    None,
                    BlockStatus::Missing,
                    row.content_version,
                    review_recheck
                ),
                // 用户删除的块不降级为 MISSING（Rust 侧兜底，即使引擎语义滞后）
                "DELETED" => outcome!(
                    false,
                    BlockWrite::None,
                    None,
                    BlockStatus::Deleted,
                    row.content_version,
                    review_recheck
                ),
                "ACTIVE" if action == ReconcileAction::MarkMissing => {
                    // 标缺影响其所属文档的索引行（§12.5：受影响 Document 一并推进）
                    for d in docs {
                        if d.existing.as_ref().map(|e| e.document_id.as_str())
                            == Some(row.document_id.as_str())
                        {
                            d.mark_dirty();
                        }
                    }
                    outcome!(
                        true,
                        BlockWrite::MarkMissing,
                        None,
                        BlockStatus::Missing,
                        row.content_version,
                        review_recheck
                    )
                }
                other => Err(idx(format!(
                    "动作 {} 与当前状态 {} 不符（Block {}）",
                    p.action, other, p.block_id
                ))),
            }
        }
        ReconcileAction::MarkConflict => {
            if asserted != BlockStatus::IdConflict {
                return Err(idx("MARK_CONFLICT 的目标状态须为 ID_CONFLICT"));
            }
            let row = existing.as_ref().ok_or_else(|| {
                idx(format!("MARK_CONFLICT 提案但 Block {} 未登记", p.block_id))
            })?;
            match row.status.as_str() {
                "ID_CONFLICT" => outcome!(
                    false,
                    BlockWrite::None,
                    None,
                    BlockStatus::IdConflict,
                    row.content_version,
                    review_recheck
                ),
                "ACTIVE" | "MISSING" => {
                    // 冲突影响其所属文档的索引行（§12.5）
                    for d in docs {
                        if d.existing.as_ref().map(|e| e.document_id.as_str())
                            == Some(row.document_id.as_str())
                        {
                            d.mark_dirty();
                        }
                    }
                    outcome!(
                        true,
                        BlockWrite::MarkConflict,
                        None,
                        BlockStatus::IdConflict,
                        row.content_version,
                        review_recheck
                    )
                }
                "DELETED" => Err(idx("已删除块不能再标记 ID_CONFLICT")),
                other => Err(idx(format!("未知状态 {other}"))),
            }
        }
        ReconcileAction::DeferVerifyOldFile | ReconcileAction::Noop => {
            let row = existing.as_ref().ok_or_else(|| {
                idx(format!("{} 提案但 Block {} 未登记", p.action, p.block_id))
            })?;
            if asserted != BlockStatus::parse(&row.status)? {
                return Err(idx(format!(
                    "{} 断言状态 {} 与实际 {} 不符",
                    p.action, p.status, row.status
                )));
            }
            outcome!(
                false,
                BlockWrite::None,
                None,
                row.status.clone(),
                row.content_version,
                review_recheck
            );
        }
    }
}
