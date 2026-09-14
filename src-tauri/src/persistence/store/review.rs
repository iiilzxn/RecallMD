//! M5 Review Engine 存储层（设计 §10/§11/§12.5）：评分事务、复习令牌、
//! 到期队列分组、参与策略与重置、日配额。
//!
//! 分工（M5_NOTES §2）：算法推进在 TS `src/review/scheduler.ts`（ts-fsrs 冻结版），
//! 本模块负责：
//! ① `review_token` 签发与快照核验（§10.4：进程内令牌绑定 block/content_version/
//!    body_hash/document_hash/index_revision/state_revision）；
//! ② `submit_review` 单事务：request_id 幂等查 → 令牌快照 CAS → 时钟守卫 →
//!    到期复核 → recheck 配对 → 日配额 → TS 产出 state_json 与投影一致性校验 →
//!    （沿用=ACCEPT_CHANGE / 重学=RESET）+RATE 双事件原子写入（§10.3 L413：
//!    决策与评分同事务，不产生"清了 override 却因原 due 未到被拒"的中间态）；
//! ③ PAUSE/RESUME/EXCLUDE/INCLUDE/RESET 状态操作（各写一条历史，§12.5 L763）；
//! ④ 到期队列按 §10.2 分组：LEARNING/RELEARNING → REVIEW → NEW（NEW 再分
//!    从未评分=占新卡配额 / 重置过=不占，§10.2 L399）。
//!
//! 时间语义（§12.1/§11.4）：`occurred_at` 是 UI 动作时间（请求携带，±10s 容差 +
//! 倒跳拒绝 + 进程 wall/monotonic 偏离守卫），`created_at` 是 Rust 入库时间。

use std::collections::{HashMap, VecDeque};

use rusqlite::{Connection, Transaction};
use serde::{Deserialize, Serialize};

use super::super::error::{HostError, HostResult};
use super::fsrs;
use super::map_sqlite_error;
use super::now_ms;
use super::query;

// ---------------------------------------------------------------------------
// 线上 DTO（camelCase；输入 deny_unknown_fields——契约漂移=响亮失败，M4 §4.12 教训）
// ---------------------------------------------------------------------------

/// TS scheduler 的产出：新算法状态（权威快照）+ 可索引投影（§11.3 L501）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchedulerOutcomeDto {
    pub state_json: String,
    pub scheduled_due_at: i64,
    pub phase: String,
    pub stability: Option<f64>,
    pub difficulty: Option<f64>,
    pub interval_ms: i64,
    pub reps: i64,
    pub lapses: i64,
    pub log_json: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitReviewRequest {
    /// 评分动作一次生成的 UUID；提交超时重试必须复用（§10.4 L430）
    pub request_id: String,
    pub token: String,
    /// 1=Again 2=Hard 3=Good 4=Easy（§10.4）
    pub rating: i64,
    /// UI 动作时间（occurred_at）
    pub now_ms: i64,
    /// needs_recheck=1 时必填：KEEP=沿用进度 / RESET=重新学习
    pub change_resolution: Option<String>,
    pub context_used: bool,
    pub duration_ms: Option<i64>,
    pub outcome: SchedulerOutcomeDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitReviewResult {
    pub block_id: String,
    pub state_revision: i64,
    pub next_review_at: i64,
    pub occurred_at: i64,
    /// true = request_id 命中已保存事件，本次零写入（幂等重放）
    pub replayed: bool,
    pub quota: QuotaInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaInfo {
    pub limit: i64,
    pub used_today: i64,
    pub remaining: i64,
}

/// 题面揭示时的完整状态（TS scheduler 的输入；令牌绑定其中的核验快照）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewStateDetail {
    pub block_id: String,
    pub relative_path: String,
    pub title: Option<String>,
    pub heading_path: Vec<String>,
    pub participation: String,
    pub phase: String,
    pub generation: i64,
    pub state_revision: i64,
    pub algorithm_id: String,
    pub algorithm_version: String,
    pub state_schema_version: i64,
    pub config_json: String,
    pub state_json: String,
    pub scheduled_due_at: i64,
    pub change_due_at: Option<i64>,
    pub next_review_at: i64,
    pub stability: Option<f64>,
    pub difficulty: Option<f64>,
    pub interval_ms: i64,
    pub reps: i64,
    pub lapses: i64,
    pub first_review_at: Option<i64>,
    pub last_review_at: Option<i64>,
    pub needs_recheck: bool,
    pub last_reviewed_content_version: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewBeginResult {
    pub token: String,
    pub now_ms: i64,
    pub state: ReviewStateDetail,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub block_id: String,
    pub relative_path: String,
    pub title: Option<String>,
    pub heading_path: Vec<String>,
    pub phase: String,
    pub next_review_at: i64,
    pub needs_recheck: bool,
    /// 从未评分（占新卡配额；§10.2 L399 重置过的块不占）
    pub never_rated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueCounts {
    pub learning: i64,
    pub review: i64,
    /// 全部到期 NEW（不因配额隐藏积压，§10.2 L399）
    pub new_total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewQueueResult {
    pub now_ms: i64,
    pub items: Vec<QueueItem>,
    pub counts: QueueCounts,
    pub quota: QuotaInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetBlockResult {
    pub block_id: String,
    pub state_revision: i64,
    pub scheduled_due_at: i64,
}

// ---------------------------------------------------------------------------
// 复习令牌（DB 工作线程内单线程持有；worker 生命周期 = 工作区会话）
// ---------------------------------------------------------------------------

const TOKEN_CAP: usize = 64;

#[derive(Debug, Clone)]
pub struct TokenBinding {
    pub block_id: String,
    pub content_version: i64,
    pub body_hash: String,
    pub document_hash: String,
    pub index_revision: i64,
    pub state_revision: i64,
    pub issued_at: i64,
}

/// 进程内令牌表（§10.4）：成功提交或快照过期后移除；容量上限逐出最旧。
#[derive(Debug, Default)]
pub struct ReviewTokens {
    entries: HashMap<String, TokenBinding>,
    order: VecDeque<String>,
}

impl ReviewTokens {
    pub fn issue(&mut self, binding: TokenBinding) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        if self.entries.len() >= TOKEN_CAP {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
        self.order.push_back(token.clone());
        self.entries.insert(token.clone(), binding);
        token
    }

    pub fn peek(&self, token: &str) -> Option<&TokenBinding> {
        self.entries.get(token)
    }

    pub fn remove(&mut self, token: &str) {
        self.entries.remove(token);
        self.order.retain(|t| t != token);
    }
}

// ---------------------------------------------------------------------------
// 内部行结构
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ReviewRow {
    block_id: String,
    participation: String,
    phase: String,
    generation: i64,
    state_revision: i64,
    algorithm_id: String,
    algorithm_version: String,
    state_schema_version: i64,
    config_json: String,
    state_json: String,
    scheduled_due_at: i64,
    change_due_at: Option<i64>,
    stability: Option<f64>,
    difficulty: Option<f64>,
    interval_ms: i64,
    reps: i64,
    lapses: i64,
    first_review_at: Option<i64>,
    last_review_at: Option<i64>,
    needs_recheck: bool,
    last_reviewed_content_version: Option<i64>,
}

impl ReviewRow {
    fn next_review_at(&self) -> i64 {
        match self.change_due_at {
            Some(cd) => self.scheduled_due_at.min(cd),
            None => self.scheduled_due_at,
        }
    }
}

#[derive(Debug, Clone)]
struct BlockCtx {
    block_status: String,
    content_version: i64,
    body_hash: String,
    index_revision: i64,
    doc_status: String,
    index_status: String,
    document_hash: Option<String>,
    relative_path: String,
    title: Option<String>,
    heading_path_json: String,
}

fn db_err(e: rusqlite::Error, ctx: &str) -> HostError {
    map_sqlite_error(&e, ctx)
}

fn rejected(msg: impl Into<String>) -> HostError {
    HostError::new(super::super::error::REVIEW_REJECTED, msg)
}

fn load_review_row(conn: &Connection, block_id: &str) -> HostResult<Option<ReviewRow>> {
    let sql = "SELECT block_id, participation, phase, generation, state_revision, \
               algorithm_id, algorithm_version, state_schema_version, config_json, state_json, \
               scheduled_due_at, change_due_at, stability, difficulty, interval_ms, reps, lapses, \
               first_review_at, last_review_at, needs_recheck, last_reviewed_content_version \
               FROM ReviewState WHERE block_id = ?1";
    conn.query_row(sql, rusqlite::params![block_id], |r| {
        Ok(ReviewRow {
            block_id: r.get(0)?,
            participation: r.get(1)?,
            phase: r.get(2)?,
            generation: r.get(3)?,
            state_revision: r.get(4)?,
            algorithm_id: r.get(5)?,
            algorithm_version: r.get(6)?,
            state_schema_version: r.get(7)?,
            config_json: r.get(8)?,
            state_json: r.get(9)?,
            scheduled_due_at: r.get(10)?,
            change_due_at: r.get(11)?,
            stability: r.get(12)?,
            difficulty: r.get(13)?,
            interval_ms: r.get(14)?,
            reps: r.get(15)?,
            lapses: r.get(16)?,
            first_review_at: r.get(17)?,
            last_review_at: r.get(18)?,
            needs_recheck: r.get::<_, i64>(19)? == 1,
            last_reviewed_content_version: r.get(20)?,
        })
    })
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(db_err(other, "读取 ReviewState")),
    })
}

fn load_block_ctx(conn: &Connection, block_id: &str) -> HostResult<Option<BlockCtx>> {
    let sql = "SELECT b.status, b.content_version, b.body_hash, d.index_revision, \
               d.status, d.index_status, d.content_hash, d.relative_path, b.title, \
               b.heading_path_json \
               FROM KnowledgeBlock b JOIN Document d ON d.document_id = b.document_id \
               WHERE b.block_id = ?1";
    conn.query_row(sql, rusqlite::params![block_id], |r| {
        Ok(BlockCtx {
            block_status: r.get(0)?,
            content_version: r.get(1)?,
            body_hash: r.get(2)?,
            index_revision: r.get(3)?,
            doc_status: r.get(4)?,
            index_status: r.get(5)?,
            document_hash: r.get(6)?,
            relative_path: r.get(7)?,
            title: r.get(8)?,
            heading_path_json: r.get(9)?,
        })
    })
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(db_err(other, "读取块上下文")),
    })
}

fn parse_heading_path(json: &str) -> Vec<String> {
    serde_json::from_str(json).unwrap_or_default()
}

/// 可评分的定位/参与前置（§10.2 L396）。返回 (row, ctx)。
fn require_rateable(
    conn: &Connection,
    block_id: &str,
) -> HostResult<(ReviewRow, BlockCtx)> {
    let row = load_review_row(conn, block_id)?
        .ok_or_else(|| rejected(format!("块 {block_id} 未登记")))?;
    let ctx = load_block_ctx(conn, block_id)?
        .ok_or_else(|| rejected(format!("块 {block_id} 缺少文档上下文（库不一致）")))?;
    if ctx.block_status != "ACTIVE" {
        return Err(rejected(format!(
            "块当前身份状态为 {}，不可评分（缺失/冲突/已删除）",
            ctx.block_status
        )));
    }
    if ctx.doc_status != "PRESENT" || ctx.index_status != "READY" {
        return Err(rejected("所属文档未就绪（缺失或索引未完成），暂不可评分"));
    }
    if row.participation != "ENABLED" {
        return Err(rejected(format!(
            "该块已{}，不可评分",
            if row.participation == "PAUSED" {
                "暂停"
            } else {
                "排除"
            }
        )));
    }
    Ok((row, ctx))
}

// ---------------------------------------------------------------------------
// 时钟守卫（§11.4：倒跳 / wall vs monotonic 显著不符 → 暂停评分）
// ---------------------------------------------------------------------------

/// 进程墙钟锚点（启动时刻的 SystemTime + Instant 对）
static PROCESS_ANCHOR: std::sync::LazyLock<(std::time::SystemTime, std::time::Instant)> =
    std::sync::LazyLock::new(|| (
        std::time::SystemTime::now(),
        std::time::Instant::now(),
    ));

/// wall 与 monotonic 外推偏离超过 5 分钟视为时钟异常（睡眠不触发：QPC 跨睡眠推进）
fn wall_clock_sane(wall_ms: i64) -> bool {
    let (start_wall, start_mono) = *PROCESS_ANCHOR;
    let mono_ms = start_mono.elapsed().as_millis() as i64;
    let wall_start_ms = start_wall
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(wall_ms);
    (wall_ms - (wall_start_ms + mono_ms)).abs() <= 300_000
}

/// 动作时间与 Rust 当前时刻的最大容差（IPC 往返 + 事件循环延迟）
const NOW_TOLERANCE_MS: i64 = 10_000;

// ---------------------------------------------------------------------------
// 日配额（§10.2 L399：本地日窗口；基于 first_review_at 终身首次字段）
// ---------------------------------------------------------------------------

const DAILY_NEW_LIMIT_KEY: &str = "review.daily_new_limit";
const DAILY_NEW_LIMIT_DEFAULT: i64 = 20;

pub fn daily_new_limit(conn: &Connection) -> HostResult<i64> {
    let raw = query::settings_get(conn, DAILY_NEW_LIMIT_KEY)?;
    let parsed = raw
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DAILY_NEW_LIMIT_DEFAULT);
    Ok(parsed.clamp(0, 100))
}

/// 距本地午夜已过的毫秒（GetLocalTime；同 backup.rs 无时区库依赖）
fn ms_since_local_midnight() -> i64 {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::GetLocalTime;
        let st = unsafe { GetLocalTime() };
        (st.wHour as i64 * 3_600 + st.wMinute as i64 * 60 + st.wSecond as i64) * 1000
            + st.wMilliseconds as i64
    }
    #[cfg(not(windows))]
    0
}

/// 本地日的 UTC 毫秒窗口 [start, end)（§11.4：时区只影响配额分界，不改 UTC due）
fn local_day_window(now_utc: i64) -> (i64, i64) {
    let start = now_utc - ms_since_local_midnight();
    (start, start + 86_400_000)
}

fn first_ratings_in_window(conn: &Connection, start: i64, end: i64) -> HostResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM ReviewState \
         WHERE first_review_at IS NOT NULL AND first_review_at >= ?1 AND first_review_at < ?2",
        rusqlite::params![start, end],
        |r| r.get(0),
    )
    .map_err(|e| db_err(e, "统计今日首次评分"))
}

fn quota_info(conn: &Connection, now: i64) -> HostResult<QuotaInfo> {
    let limit = daily_new_limit(conn)?;
    let (start, end) = local_day_window(now);
    let used = first_ratings_in_window(conn, start, end)?;
    Ok(QuotaInfo {
        limit,
        used_today: used,
        remaining: (limit - used).max(0),
    })
}

// ---------------------------------------------------------------------------
// state_json 解析与投影一致性校验（§11.3 L501）
// ---------------------------------------------------------------------------

struct ParsedCard {
    due_ms: i64,
    state_num: i64,
    stability: f64,
    difficulty: f64,
    reps: i64,
    lapses: i64,
}

const PHASES: [&str; 4] = ["NEW", "LEARNING", "REVIEW", "RELEARNING"];

/// 校验 TS 产出的新状态：state_json（权威）与投影字段必须一致；
/// 未知键放行（§11.3 无损保存锁定版新增字段）。失败=REVIEW_REJECTED。
fn validate_outcome(o: &SchedulerOutcomeDto, action_now_ms: i64) -> HostResult<()> {
    let bad = |msg: String| Err(rejected(format!("算法产出不一致：{msg}")));
    let v: serde_json::Value = serde_json::from_str(&o.state_json)
        .map_err(|e| rejected(format!("state_json 不是合法 JSON：{e}")))?;
    let obj = v.as_object().ok_or_else(|| rejected("state_json 须为对象"))?;
    let get_num = |k: &str| -> HostResult<f64> {
        obj.get(k)
            .and_then(|x| x.as_f64())
            .ok_or_else(|| rejected(format!("state_json 缺数字键 {k}")))
    };
    let due_str = obj
        .get("due")
        .and_then(|x| x.as_str())
        .ok_or_else(|| rejected("state_json 缺 due 字符串键"))?;
    let card = ParsedCard {
        due_ms: fsrs::parse_iso8601_ms(due_str)?,
        state_num: get_num("state")? as i64,
        stability: get_num("stability")?,
        difficulty: get_num("difficulty")?,
        reps: get_num("reps")? as i64,
        lapses: get_num("lapses")? as i64,
    };
    if !(0..=3).contains(&card.state_num) {
        return bad("state 超出 0..=3".into());
    }
    if PHASES[card.state_num as usize] != o.phase {
        return bad(format!("phase {} 与 state {} 不符", o.phase, card.state_num));
    }
    if card.due_ms != o.scheduled_due_at {
        return bad("scheduledDueAt 与 state_json.due 不一致".into());
    }
    if card.reps != o.reps || card.lapses != o.lapses {
        return bad("reps/lapses 与 state_json 不一致".into());
    }
    if card.state_num == 0 {
        // 空状态：投影须为 NULL（§11.2 L460 算法内部零值完整保留在 state_json）
        if o.stability.is_some() || o.difficulty.is_some() {
            return bad("空状态投影应为 NULL".into());
        }
    } else {
        match (o.stability, o.difficulty) {
            (Some(s), Some(d)) if s == card.stability && d == card.difficulty => {}
            _ => return bad("stability/difficulty 投影与 state_json 不一致".into()),
        }
    }
    if o.interval_ms != o.scheduled_due_at - action_now_ms {
        return bad("intervalMs 不等于 due-now".into());
    }
    if o.interval_ms < 0 {
        return bad("intervalMs 为负（时钟倒跳？）".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 历史快照（before/after_state_json：含配置、参与策略与 override 的完整快照）
// ---------------------------------------------------------------------------

fn state_snapshot(row: &ReviewRow) -> String {
    serde_json::json!({
        "participation": row.participation,
        "phase": row.phase,
        "generation": row.generation,
        "stateRevision": row.state_revision,
        "algorithmId": row.algorithm_id,
        "algorithmVersion": row.algorithm_version,
        "stateSchemaVersion": row.state_schema_version,
        "configJson": serde_json::from_str::<serde_json::Value>(&row.config_json)
            .unwrap_or(serde_json::Value::Null),
        "stateJson": serde_json::from_str::<serde_json::Value>(&row.state_json)
            .unwrap_or(serde_json::Value::Null),
        "scheduledDueAt": row.scheduled_due_at,
        "changeDueAt": row.change_due_at,
        "nextReviewAt": row.next_review_at(),
        "needsRecheck": row.needs_recheck,
    })
    .to_string()
}

/// 从 after_state_json 快照取 nextReviewAt（幂等重放时还原应答用）
fn snapshot_next_review_at(snapshot: &str) -> Option<i64> {
    serde_json::from_str::<serde_json::Value>(snapshot)
        .ok()?
        .get("nextReviewAt")?
        .as_i64()
}

#[allow(clippy::too_many_arguments)]
fn insert_history(
    tx: &Transaction,
    request_id: &str,
    block_id: &str,
    event_type: &str,
    rating: Option<i64>,
    generation: i64,
    content_version: i64,
    content_hash: &str,
    document_hash: &str,
    before_revision: i64,
    before_state_json: &str,
    after_state_json: &str,
    algorithm_log_json: Option<&str>,
    change_resolution: Option<&str>,
    context_used: bool,
    duration_ms: Option<i64>,
    occurred_at: i64,
    created_at: i64,
) -> HostResult<String> {
    let history_id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO ReviewHistory (history_id, request_id, block_id, event_type, rating, \
         generation, content_version, content_hash, document_hash, before_revision, \
         after_revision, before_state_json, after_state_json, algorithm_log_json, \
         change_resolution, context_used, duration_ms, occurred_at, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, \
         ?17, ?18, ?19, ?19)",
        rusqlite::params![
            history_id,
            request_id,
            block_id,
            event_type,
            rating,
            generation,
            content_version,
            content_hash,
            document_hash,
            before_revision,
            before_revision + 1,
            before_state_json,
            after_state_json,
            algorithm_log_json,
            change_resolution,
            context_used as i64,
            duration_ms,
            occurred_at,
            created_at,
        ],
    )
    .map_err(|e| db_err(e, "写入复习历史"))?;
    Ok(history_id)
}

// ---------------------------------------------------------------------------
// review_begin：签发令牌（§10.4）
// ---------------------------------------------------------------------------

pub fn review_begin_on(
    conn: &Connection,
    tokens: &mut ReviewTokens,
    block_id: &str,
) -> HostResult<ReviewBeginResult> {
    let now = now_ms();
    let (row, ctx) = require_rateable(conn, block_id)?;
    if row.next_review_at() > now {
        return Err(rejected(format!(
            "尚未到期（next_review_at={} > now={}）",
            row.next_review_at(),
            now
        )));
    }
    let document_hash = ctx
        .document_hash
        .clone()
        .ok_or_else(|| rejected("文档缺已核实哈希（索引未完成），暂不可评分"))?;
    let token = tokens.issue(TokenBinding {
        block_id: block_id.to_string(),
        content_version: ctx.content_version,
        body_hash: ctx.body_hash.clone(),
        document_hash,
        index_revision: ctx.index_revision,
        state_revision: row.state_revision,
        issued_at: now,
    });
    let next_at = row.next_review_at();
    Ok(ReviewBeginResult {
        token,
        now_ms: now,
        state: ReviewStateDetail {
            block_id: row.block_id,
            relative_path: ctx.relative_path,
            title: ctx.title,
            heading_path: parse_heading_path(&ctx.heading_path_json),
            participation: row.participation,
            phase: row.phase,
            generation: row.generation,
            state_revision: row.state_revision,
            algorithm_id: row.algorithm_id,
            algorithm_version: row.algorithm_version,
            state_schema_version: row.state_schema_version,
            config_json: row.config_json,
            state_json: row.state_json,
            scheduled_due_at: row.scheduled_due_at,
            change_due_at: row.change_due_at,
            next_review_at: next_at,
            stability: row.stability,
            difficulty: row.difficulty,
            interval_ms: row.interval_ms,
            reps: row.reps,
            lapses: row.lapses,
            first_review_at: row.first_review_at,
            last_review_at: row.last_review_at,
            needs_recheck: row.needs_recheck,
            last_reviewed_content_version: row.last_reviewed_content_version,
        },
    })
}

// ---------------------------------------------------------------------------
// submit_review：单事务（§12.5 L762）
// ---------------------------------------------------------------------------

pub fn submit_review_on(
    conn: &mut Connection,
    tokens: &mut ReviewTokens,
    req: &SubmitReviewRequest,
) -> HostResult<SubmitReviewResult> {
    let rust_now = now_ms();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| db_err(e, "开启事务"))?;

    // ---- 0. request_id 幂等：已保存的 RATE 原样返回，零写入（§10.4 L430）----
    let saved: Option<(String, i64, i64, i64)> = tx
        .query_row(
            "SELECT block_id, after_revision, occurred_at, 1 FROM ReviewHistory \
             WHERE request_id = ?1 AND event_type = 'RATE'",
            rusqlite::params![req.request_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(db_err(other, "幂等查重")),
        })?;
    if let Some((block_id, after_revision, occurred_at, _)) = saved {
        let quota = quota_info(&tx, rust_now)?;
        let next = load_review_row(&tx, &block_id)?
            .map(|r| r.next_review_at())
            .unwrap_or_else(|| {
                // 当前行被外部动过也不影响重放语义：从历史快照还原
                find_after_snapshot(&tx, &block_id, after_revision)
                    .and_then(|s| snapshot_next_review_at(&s))
                    .unwrap_or(occurred_at)
            });
        return Ok(SubmitReviewResult {
            block_id,
            state_revision: after_revision,
            next_review_at: next,
            occurred_at,
            replayed: true,
            quota,
        });
    }

    // ---- 1. 令牌 ----
    let binding = tokens
        .peek(&req.token)
        .cloned()
        .ok_or_else(|| HostError::new(super::super::error::REVIEW_TOKEN_INVALID, "复习令牌不存在或已使用，请重新揭示题面"))?;
    let block_id = binding.block_id.clone();

    // ---- 2. 快照 CAS：定位/参与/五元快照逐一对照（§10.4 L428）----
    let mut stale = |msg: &str| -> HostError {
        tokens.remove(&req.token);
        HostError::new(
            super::super::error::REVIEW_TOKEN_STALE,
            format!("题面已变化（{msg}），请重新揭示后再评分"),
        )
    };
    let (row, ctx) = match require_rateable(&tx, &block_id) {
        Ok(pair) => pair,
        Err(e) => return Err(stale(&e.message)),
    };
    if row.state_revision != binding.state_revision
        || ctx.content_version != binding.content_version
        || ctx.body_hash != binding.body_hash
        || ctx.document_hash.as_deref() != Some(binding.document_hash.as_str())
        || ctx.index_revision != binding.index_revision
    {
        return Err(stale("正文/索引/复习状态已推进"));
    }

    // ---- 3. 时钟守卫（§11.4）----
    if !wall_clock_sane(rust_now) || !wall_clock_sane(req.now_ms) {
        return Err(HostError::new(
            super::super::error::TIME_ANOMALY,
            "系统时钟与进程单调钟显著不符，评分已暂停，请检查系统时间",
        ));
    }
    if (req.now_ms - rust_now).abs() > NOW_TOLERANCE_MS {
        return Err(HostError::new(
            super::super::error::TIME_ANOMALY,
            format!(
                "动作时间与当前时刻偏离超容差（{}ms），请检查系统时间",
                (req.now_ms - rust_now).abs()
            ),
        ));
    }
    if let Some(last) = row.last_review_at {
        if req.now_ms < last {
            return Err(HostError::new(
                super::super::error::TIME_ANOMALY,
                "动作时间早于上次评分（时钟回拨？），不使用负间隔",
            ));
        }
    }

    // ---- 4. 到期复核（§10.2 L396）----
    if row.next_review_at() > req.now_ms {
        return Err(rejected("尚未到期，不可评分"));
    }

    // ---- 5. Rating 范围 ----
    if !(1..=4).contains(&req.rating) {
        return Err(rejected(format!("Rating 须为 1–4，得到 {}", req.rating)));
    }

    // ---- 6. recheck 配对（§10.3 L410–413）----
    let resolution = match (row.needs_recheck, req.change_resolution.as_deref()) {
        (true, Some("KEEP")) | (true, Some("RESET")) => req.change_resolution.clone(),
        (true, other) => {
            return Err(rejected(format!(
                "正文已变更，须先选择沿用/重学（得到 {other:?}）"
            )))
        }
        (false, None) => None,
        (false, Some(_)) => {
            return Err(rejected("无待确认的正文变更，无须沿用/重学决策"));
        }
    };

    // ---- 7. 算法身份冻结校验（§11.2：不静默换参数）----
    if row.algorithm_id != fsrs::ALGORITHM_ID
        || row.algorithm_version != fsrs::ALGORITHM_VERSION
        || row.state_schema_version != fsrs::STATE_SCHEMA_VERSION
    {
        return Err(rejected(format!(
            "算法身份漂移（{}@{} v{}），须走 §11.4 迁移流程",
            row.algorithm_id, row.algorithm_version, row.state_schema_version
        )));
    }

    // ---- 8. 日配额（仅终身首次评分占额；§10.2 L399）----
    let is_first = row.first_review_at.is_none();
    let quota = quota_info(&tx, req.now_ms)?;
    if is_first && quota.remaining <= 0 {
        return Err(HostError::new(
            super::super::error::QUOTA_EXCEEDED,
            format!("今日新内容首次评分已达上限 {}，明天再继续", quota.limit),
        ));
    }

    // ---- 9. TS 产出一致性（§11.3 L501：不一致即停，不择其一继续）----
    validate_outcome(&req.outcome, req.now_ms)?;

    // ---- 10. 写入：决策子事件 → RATE，逐事件 +1 revision ----
    let mut current = row.clone();
    let before_snapshot = state_snapshot(&row);
    let mut revision = row.state_revision;
    // 子事件后的中间态快照（=RATE 的 before；无决策时即原始快照）
    let mut after_subevent_snapshot = before_snapshot.clone();

    match resolution.as_deref() {
        Some("KEEP") => {
            revision += 1;
            current.needs_recheck = false;
            current.change_due_at = None;
            current.state_revision = revision;
            insert_history(
                &tx,
                &format!("{}:keep", req.request_id),
                &block_id,
                "ACCEPT_CHANGE",
                None,
                current.generation,
                binding.content_version,
                &binding.body_hash,
                &binding.document_hash,
                revision - 1,
                &before_snapshot,
                &state_snapshot(&current),
                None,
                None,
                false,
                None,
                req.now_ms,
                rust_now,
            )?;
            tx.execute(
                "UPDATE ReviewState SET needs_recheck = 0, change_due_at = NULL, \
                 state_revision = ?1, updated_at = ?2 WHERE block_id = ?3",
                rusqlite::params![revision, rust_now, block_id],
            )
            .map_err(|e| db_err(e, "更新 ReviewState（沿用）"))?;
            after_subevent_snapshot = state_snapshot(&current);
        }
        Some("RESET") => {
            revision += 1;
            current.generation += 1;
            current.phase = "NEW".into();
            current.state_json = fsrs::empty_card_state_json(req.now_ms)?;
            current.scheduled_due_at = req.now_ms;
            current.change_due_at = None;
            current.stability = None;
            current.difficulty = None;
            current.interval_ms = 0;
            current.reps = 0;
            current.lapses = 0;
            current.needs_recheck = false;
            current.last_reviewed_content_version = None;
            current.state_revision = revision;
            insert_history(
                &tx,
                &format!("{}:reset", req.request_id),
                &block_id,
                "RESET",
                None,
                current.generation,
                binding.content_version,
                &binding.body_hash,
                &binding.document_hash,
                revision - 1,
                &before_snapshot,
                &state_snapshot(&current),
                None,
                None,
                false,
                None,
                req.now_ms,
                rust_now,
            )?;
            tx.execute(
                "UPDATE ReviewState SET generation = ?1, phase = 'NEW', state_json = ?2, \
                 scheduled_due_at = ?3, change_due_at = NULL, stability = NULL, \
                 difficulty = NULL, interval_ms = 0, reps = 0, lapses = 0, needs_recheck = 0, \
                 last_reviewed_content_version = NULL, state_revision = ?4, updated_at = ?5 \
                 WHERE block_id = ?6",
                rusqlite::params![
                    current.generation,
                    current.state_json,
                    req.now_ms,
                    revision,
                    rust_now,
                    block_id
                ],
            )
            .map_err(|e| db_err(e, "更新 ReviewState（重学）"))?;
            after_subevent_snapshot = state_snapshot(&current);
        }
        _ => {}
    }

    // RATE 事件：投影与 state_json 同一事务由同一结果写入（§11.3 L501）
    revision += 1;
    current.phase = req.outcome.phase.clone();
    current.state_json = req.outcome.state_json.clone();
    current.scheduled_due_at = req.outcome.scheduled_due_at;
    current.stability = req.outcome.stability;
    current.difficulty = req.outcome.difficulty;
    current.interval_ms = req.outcome.interval_ms;
    current.reps = req.outcome.reps;
    current.lapses = req.outcome.lapses;
    current.last_review_at = Some(req.now_ms);
    if current.first_review_at.is_none() {
        current.first_review_at = Some(req.now_ms);
    }
    current.last_reviewed_content_version = Some(binding.content_version);
    current.needs_recheck = false;
    current.change_due_at = None;
    current.state_revision = revision;
    insert_history(
        &tx,
        &req.request_id,
        &block_id,
        "RATE",
        Some(req.rating),
        current.generation,
        binding.content_version,
        &binding.body_hash,
        &binding.document_hash,
        revision - 1,
        &after_subevent_snapshot,
        &state_snapshot(&current),
        req.outcome.log_json.as_deref(),
        resolution.as_deref(),
        req.context_used,
        req.duration_ms,
        req.now_ms,
        rust_now,
    )?;
    tx.execute(
        "UPDATE ReviewState SET phase = ?1, state_json = ?2, scheduled_due_at = ?3, \
         change_due_at = NULL, stability = ?4, difficulty = ?5, interval_ms = ?6, reps = ?7, \
         lapses = ?8, first_review_at = COALESCE(first_review_at, ?9), last_review_at = ?9, \
         needs_recheck = 0, last_reviewed_content_version = ?10, state_revision = ?11, \
         updated_at = ?12 WHERE block_id = ?13",
        rusqlite::params![
            current.phase,
            current.state_json,
            current.scheduled_due_at,
            current.stability,
            current.difficulty,
            current.interval_ms,
            current.reps,
            current.lapses,
            req.now_ms,
            binding.content_version,
            revision,
            rust_now,
            block_id
        ],
    )
    .map_err(|e| db_err(e, "更新 ReviewState（评分）"))?;

    let quota_after = quota_info(&tx, req.now_ms)?;
    tx.commit().map_err(|e| db_err(e, "提交评分事务"))?;
    tokens.remove(&req.token);
    Ok(SubmitReviewResult {
        block_id,
        state_revision: revision,
        next_review_at: current.next_review_at(),
        occurred_at: req.now_ms,
        replayed: false,
        quota: quota_after,
    })
}

fn find_after_snapshot(conn: &Connection, block_id: &str, after_revision: i64) -> Option<String> {
    conn.query_row(
        "SELECT after_state_json FROM ReviewHistory \
         WHERE block_id = ?1 AND after_revision = ?2",
        rusqlite::params![block_id, after_revision],
        |r| r.get(0),
    )
    .ok()
}

// ---------------------------------------------------------------------------
// 参与策略与重置（§10.1/§10.3；非 RATE 可作用于缺失块，§12.5 L768）
// ---------------------------------------------------------------------------

pub fn set_participation_on(
    conn: &mut Connection,
    block_ids: &[String],
    action: &str,
) -> HostResult<u64> {
    let (target, allowed_from, event) = match action {
        "PAUSE" => ("PAUSED", &["ENABLED"][..], "PAUSE"),
        "RESUME" => ("ENABLED", &["PAUSED"][..], "RESUME"),
        "EXCLUDE" => ("EXCLUDED", &["ENABLED", "PAUSED"][..], "EXCLUDE"),
        "INCLUDE" => ("ENABLED", &["EXCLUDED"][..], "INCLUDE"),
        other => {
            return Err(rejected(format!(
                "未知参与操作 {other:?}（须为 PAUSE/RESUME/EXCLUDE/INCLUDE）"
            )))
        }
    };
    let now = now_ms();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| db_err(e, "开启事务"))?;
    let mut applied: u64 = 0;
    for block_id in block_ids {
        let row = load_review_row(&tx, block_id)?
            .ok_or_else(|| rejected(format!("块 {block_id} 未登记")))?;
        let ctx = load_block_ctx(&tx, block_id)?
            .ok_or_else(|| rejected(format!("块 {block_id} 缺少文档上下文（库不一致）")))?;
        if !allowed_from.contains(&row.participation.as_str()) {
            return Err(rejected(format!(
                "块 {block_id} 当前为 {}，不能直接{}",
                row.participation, action
            )));
        }
        // 历史引用：最后一次成功索引的版本（§12.5 L768，不代表已重读正文）
        let document_hash = ctx
            .document_hash
            .clone()
            .ok_or_else(|| rejected(format!("块 {block_id} 缺已索引文档哈希")))?;
        let mut after = row.clone();
        after.participation = target.to_string();
        after.state_revision = row.state_revision + 1;
        // 暂停/排除不改算法 due、S/D、last_review（§10.2 L400）
        insert_history(
            &tx,
            &uuid::Uuid::new_v4().to_string(),
            block_id,
            event,
            None,
            row.generation,
            ctx.content_version,
            &ctx.body_hash,
            &document_hash,
            row.state_revision,
            &state_snapshot(&row),
            &state_snapshot(&after),
            None,
            None,
            false,
            None,
            now,
            now,
        )?;
        tx.execute(
            "UPDATE ReviewState SET participation = ?1, state_revision = ?2, updated_at = ?3 \
             WHERE block_id = ?4",
            rusqlite::params![target, after.state_revision, now, block_id],
        )
        .map_err(|e| db_err(e, "更新参与策略"))?;
        applied += 1;
    }
    tx.commit().map_err(|e| db_err(e, "提交参与策略事务"))?;
    Ok(applied)
}

/// 单独重置（§10.3 L413 / §12.5 L770）：清空本代算法计数、generation+1、
/// due=操作时间；保留 first_review_at 与历史；不当作记忆成功。
pub fn reset_block_on(conn: &mut Connection, block_id: &str) -> HostResult<ResetBlockResult> {
    let now = now_ms();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| db_err(e, "开启事务"))?;
    let row = load_review_row(&tx, block_id)?
        .ok_or_else(|| rejected(format!("块 {block_id} 未登记")))?;
    let ctx = load_block_ctx(&tx, block_id)?
        .ok_or_else(|| rejected(format!("块 {block_id} 缺少文档上下文（库不一致）")))?;
    let document_hash = ctx
        .document_hash
        .clone()
        .ok_or_else(|| rejected(format!("块 {block_id} 缺已索引文档哈希")))?;

    let empty_state = fsrs::empty_card_state_json(now)?;
    let mut after = row.clone();
    after.generation += 1;
    after.phase = "NEW".into();
    after.state_json = empty_state.clone();
    after.scheduled_due_at = now;
    after.change_due_at = None;
    after.stability = None;
    after.difficulty = None;
    after.interval_ms = 0;
    after.reps = 0;
    after.lapses = 0;
    after.needs_recheck = false;
    after.last_reviewed_content_version = None;
    after.state_revision = row.state_revision + 1;
    insert_history(
        &tx,
        &uuid::Uuid::new_v4().to_string(),
        block_id,
        "RESET",
        None,
        after.generation,
        ctx.content_version,
        &ctx.body_hash,
        &document_hash,
        row.state_revision,
        &state_snapshot(&row),
        &state_snapshot(&after),
        None,
        None,
        false,
        None,
        now,
        now,
    )?;
    tx.execute(
        "UPDATE ReviewState SET generation = ?1, phase = 'NEW', state_json = ?2, \
         scheduled_due_at = ?3, change_due_at = NULL, stability = NULL, difficulty = NULL, \
         interval_ms = 0, reps = 0, lapses = 0, needs_recheck = 0, \
         last_reviewed_content_version = NULL, state_revision = ?4, updated_at = ?5 \
         WHERE block_id = ?6",
        rusqlite::params![
            after.generation,
            empty_state,
            now,
            after.state_revision,
            now,
            block_id
        ],
    )
    .map_err(|e| db_err(e, "更新 ReviewState（重置）"))?;
    tx.commit().map_err(|e| db_err(e, "提交重置事务"))?;
    Ok(ResetBlockResult {
        block_id: block_id.to_string(),
        state_revision: after.state_revision,
        scheduled_due_at: now,
    })
}

// ---------------------------------------------------------------------------
// 到期队列（§10.2 L398：学习/重学 → REVIEW → NEW；组内 next_review_at, block_id）
// ---------------------------------------------------------------------------

const QUEUE_SQL_PREFIX: &str = "SELECT r.block_id, d.relative_path, b.title, \
     b.heading_path_json, r.phase, r.next_review_at, r.needs_recheck, r.first_review_at \
     FROM ReviewState r \
     JOIN KnowledgeBlock b ON b.block_id = r.block_id \
     JOIN Document d ON d.document_id = b.document_id \
     WHERE r.participation = 'ENABLED' AND r.next_review_at <= ?1 \
       AND b.status = 'ACTIVE' AND d.status = 'PRESENT' AND d.index_status = 'READY'";

fn query_group(
    conn: &Connection,
    now: i64,
    phase_filter: &str,
    never_rated: Option<bool>,
    limit: i64,
) -> HostResult<Vec<QueueItem>> {
    if limit <= 0 {
        return Ok(Vec::new());
    }
    let (extra, _) = match never_rated {
        Some(true) => (" AND r.first_review_at IS NULL", ()),
        Some(false) => (" AND r.first_review_at IS NOT NULL", ()),
        None => ("", ()),
    };
    let sql = format!(
        "{QUEUE_SQL_PREFIX} AND r.phase IN ({phase_filter}){extra} \
         ORDER BY r.next_review_at, r.block_id LIMIT ?2"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| db_err(e, "队列查询准备"))?;
    let rows = stmt
        .query_map(rusqlite::params![now, limit], |r| {
            let heading_json: String = r.get(3)?;
            let first_review_at: Option<i64> = r.get(7)?;
            Ok((
                QueueItem {
                    block_id: r.get(0)?,
                    relative_path: r.get(1)?,
                    title: r.get(2)?,
                    heading_path: Vec::new(),
                    phase: r.get(4)?,
                    next_review_at: r.get(5)?,
                    needs_recheck: r.get::<_, i64>(6)? == 1,
                    // 行内实值（分组谓词已约束；两路合并后以此为准）
                    never_rated: first_review_at.is_none(),
                },
                heading_json,
            ))
        })
        .map_err(|e| db_err(e, "队列查询"))?;
    let mut out = Vec::new();
    for row in rows {
        let (mut item, heading_json) = row.map_err(|e| db_err(e, "队列查询"))?;
        item.heading_path = parse_heading_path(&heading_json);
        out.push(item);
    }
    Ok(out)
}

fn count_group(conn: &Connection, now: i64, phase_filter: &str) -> HostResult<i64> {
    let sql = format!(
        "SELECT COUNT(*) FROM ReviewState r \
         JOIN KnowledgeBlock b ON b.block_id = r.block_id \
         JOIN Document d ON d.document_id = b.document_id \
         WHERE r.participation = 'ENABLED' AND r.next_review_at <= ?1 \
           AND b.status = 'ACTIVE' AND d.status = 'PRESENT' AND d.index_status = 'READY' \
           AND r.phase IN ({phase_filter})"
    );
    conn.query_row(&sql, rusqlite::params![now], |r| r.get(0))
        .map_err(|e| db_err(e, "队列计数"))
}

pub fn review_queue_on(conn: &Connection, page_size: Option<i64>) -> HostResult<ReviewQueueResult> {
    let now = now_ms();
    let page = page_size.unwrap_or(50).clamp(1, 200);
    let quota = quota_info(conn, now)?;

    let learning = query_group(conn, now, "'LEARNING','RELEARNING'", None, page)?;
    let review = query_group(conn, now, "'REVIEW'", None, page)?;
    // NEW 再分：从未评分（占配额，上限=剩余名额）与重置过（不占，§10.2 L399）
    let new_fresh = query_group(conn, now, "'NEW'", Some(true), quota.remaining.min(page))?;
    let new_reset = query_group(conn, now, "'NEW'", Some(false), page)?;
    let mut new_all = new_fresh;
    new_all.extend(new_reset);
    new_all.sort_by(|a, b| {
        (a.next_review_at, &a.block_id).cmp(&(b.next_review_at, &b.block_id))
    });

    let counts = QueueCounts {
        learning: count_group(conn, now, "'LEARNING','RELEARNING'")?,
        review: count_group(conn, now, "'REVIEW'")?,
        new_total: count_group(conn, now, "'NEW'")?,
    };

    let mut items = learning;
    items.extend(review);
    items.extend(new_all);
    items.truncate(page as usize);

    Ok(ReviewQueueResult {
        now_ms: now,
        items,
        counts,
        quota,
    })
}
