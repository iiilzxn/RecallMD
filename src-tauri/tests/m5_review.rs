//! M5 Review Engine 集成测试：评分事务（CAS/幂等/双事件原子）、令牌失效、
//! 日配额、时钟守卫、参与策略与重置、队列分组、投影一致性校验。
//! 直连 Connection（同 m4_store 模式），不经工作线程/激活态。

use recallmd_lib::persistence::store::commit::commit_on;
use recallmd_lib::persistence::store::dto::{
    BlockNextDto, BlockProposalDto, CommitIndexBatchRequest, DocumentHeaderDto,
};
use recallmd_lib::persistence::store::query::settings_set_string;
use recallmd_lib::persistence::store::review::{
    review_begin_on, review_queue_on, reset_block_on, set_participation_on, submit_review_on,
    ReviewTokens, SchedulerOutcomeDto, SubmitReviewRequest,
};
use recallmd_lib::persistence::store::open_test_db;
use rusqlite::Connection;

// ---------------------------------------------------------------------------
// 助手（沿 m4_store 模式）
// ---------------------------------------------------------------------------

fn temp_db(name: &str) -> Connection {
    let dir = std::env::temp_dir().join(format!(
        "recallmd-m5-{}-{}",
        name,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    open_test_db(&dir.join("metadata.sqlite")).expect("打开测试库")
}

fn h64(tag: &str) -> String {
    let mut out = String::new();
    let mut seed = tag;
    while out.len() < 64 {
        let mut v: u64 = 0xcbf29ce484222325;
        for b in seed.as_bytes() {
            v ^= *b as u64;
            v = v.wrapping_mul(0x100000001b3);
        }
        out.push_str(&format!("{v:016x}"));
        seed = "x";
    }
    out.truncate(64);
    out
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn header(path: &str, rev: i64, hash: &str) -> DocumentHeaderDto {
    DocumentHeaderDto {
        relative_path: path.into(),
        expected_index_revision: rev,
        observed_hash: hash.into(),
        parser_version: "remark-parse@11.0.0/fingerprint-v1".into(),
        byte_size: 128,
        mtime_ms: 1_700_000_000_000,
        line_ending: "LF".into(),
        has_bom: false,
        diagnostics: vec![],
        file_identity: None,
    }
}

fn next_dto(block_id: &str, path: &str, ordinal: i64, body_hash: &str) -> BlockNextDto {
    BlockNextDto {
        block_id: Some(block_id.into()),
        kind: "SECTION".into(),
        title: Some("小节标题".into()),
        heading_level: 2,
        heading_path: vec!["父标题".into(), "小节标题".into()],
        ordinal,
        start_offset: 0,
        body_start_offset: 12,
        end_offset: 200,
        source_hash: h64("src"),
        body_hash: body_hash.into(),
        oversized: false,
        relative_path: path.into(),
        content_version: 1,
        needs_recheck: false,
    }
}

fn create(block_id: &str, path: &str, ordinal: i64, body_hash: &str) -> BlockProposalDto {
    BlockProposalDto {
        block_id: block_id.into(),
        action: "CREATE".into(),
        status: "ACTIVE".into(),
        relative_path: Some(path.into()),
        next: Some(next_dto(block_id, path, ordinal, body_hash)),
        change_class: None,
        content_version_delta: 1,
        needs_recheck: false,
        prev: None,
        reason: "首次登记".into(),
        occurrences: vec![],
    }
}

/// 建块并落库（单文档单块；同文档多块时由调用方递增 rev）
fn seed_block(conn: &mut Connection, block_id: &str, path: &str, body_tag: &str) {
    seed_block_rev(conn, block_id, path, body_tag, 0);
}

fn seed_block_rev(conn: &mut Connection, block_id: &str, path: &str, body_tag: &str, rev: i64) {
    let body_hash = h64(body_tag);
    let req = CommitIndexBatchRequest {
        documents: vec![header(path, rev, &h64(&format!("doc-{body_tag}")))],
        block_results: vec![create(block_id, path, 0, &body_hash)],
        snapshot_paths: vec![path.into()],
    };
    commit_on(conn, &req).expect("落库");
}

/// 把块拨到"现在已到期"（直接改 due；模拟 24h 首提已过）
fn make_due(conn: &Connection, block_id: &str) {
    conn.execute(
        "UPDATE ReviewState SET scheduled_due_at = 1000 WHERE block_id = ?1",
        rusqlite::params![block_id],
    )
    .expect("拨到期");
}

fn count(conn: &Connection, sql: &str, params: &[&dyn rusqlite::ToSql]) -> i64 {
    conn.query_row(sql, params, |r| r.get(0)).unwrap()
}

/// 模拟 TS scheduler 产出：空卡 + Good（对齐 ts-fsrs@5.4.2 实测输出：
/// Learning、due=+10m、S=2.3065、D≈2.11810397、reps=1）
fn outcome_good_on_empty(now: i64) -> SchedulerOutcomeDto {
    let due = now + 600_000;
    let due_iso = recallmd_lib::persistence::store::fsrs::iso8601_ms(due).unwrap();
    let now_iso = recallmd_lib::persistence::store::fsrs::iso8601_ms(now).unwrap();
    SchedulerOutcomeDto {
        state_json: format!(
            "{{\"due\":\"{due_iso}\",\"stability\":2.3065,\"difficulty\":2.11810397,\
             \"elapsed_days\":0,\"scheduled_days\":0,\"reps\":1,\"lapses\":0,\
             \"learning_steps\":1,\"state\":1,\"last_review\":\"{now_iso}\"}}"
        ),
        scheduled_due_at: due,
        phase: "LEARNING".into(),
        stability: Some(2.3065),
        difficulty: Some(2.11810397),
        interval_ms: 600_000,
        reps: 1,
        lapses: 0,
        log_json: Some("{}".into()),
    }
}

struct Session {
    conn: Connection,
    tokens: ReviewTokens,
}

fn begin(conn: &mut Connection, tokens: &mut ReviewTokens, block_id: &str) -> (String, i64) {
    let r = review_begin_on(conn, tokens, block_id).expect("begin");
    (r.token, r.now_ms)
}

fn submit_req(token: &str, now: i64, rating: i64) -> SubmitReviewRequest {
    SubmitReviewRequest {
        request_id: new_id(),
        token: token.into(),
        rating,
        now_ms: now,
        change_resolution: None,
        context_used: false,
        duration_ms: Some(1200),
        outcome: outcome_good_on_empty(now),
    }
}

// ---------------------------------------------------------------------------
// begin：到期前置 + 令牌签发
// ---------------------------------------------------------------------------

#[test]
fn m5_begin_requires_due_and_issues_token() {
    let mut s = Session {
        conn: temp_db("begin"),
        tokens: ReviewTokens::default(),
    };
    let b = new_id();
    seed_block(&mut s.conn, &b, "a.md", "body");
    // 24h 首提未到 → 拒绝
    let err = review_begin_on(&s.conn, &mut s.tokens, &b).unwrap_err();
    assert_eq!(err.code, "REVIEW_REJECTED");
    make_due(&s.conn, &b);
    let r = review_begin_on(&s.conn, &mut s.tokens, &b).expect("begin");
    assert!(!r.token.is_empty());
    assert_eq!(r.state.block_id, b);
    assert_eq!(r.state.phase, "NEW");
    assert_eq!(r.state.reps, 0);
    assert_eq!(r.state.participation, "ENABLED");
    assert_eq!(r.state.needs_recheck, false);
    assert!(r.state.first_review_at.is_none());
    // 暂停块不可 begin
    s.conn
        .execute(
            "UPDATE ReviewState SET participation = 'PAUSED' WHERE block_id = ?1",
            rusqlite::params![b],
        )
        .unwrap();
    let err = review_begin_on(&s.conn, &mut s.tokens, &b).unwrap_err();
    assert_eq!(err.code, "REVIEW_REJECTED");
}

// ---------------------------------------------------------------------------
// submit 快乐路径 + 幂等重放（验收：超时重试只算一次）
// ---------------------------------------------------------------------------

#[test]
fn m5_submit_happy_path_and_idempotent_replay() {
    let mut s = Session {
        conn: temp_db("submit"),
        tokens: ReviewTokens::default(),
    };
    let b = new_id();
    seed_block(&mut s.conn, &b, "a.md", "body");
    make_due(&s.conn, &b);
    let (token, now) = begin(&mut s.conn, &mut s.tokens, &b);
    let req = submit_req(&token, now, 3);
    let req_replay = SubmitReviewRequest {
        request_id: req.request_id.clone(),
        ..submit_req(&token, now, 3)
    };
    let r = submit_review_on(&mut s.conn, &mut s.tokens, &req).expect("提交");
    assert!(!r.replayed);
    assert_eq!(r.block_id, b);
    assert_eq!(r.state_revision, 1);
    assert_eq!(r.next_review_at, now + 600_000);
    assert_eq!(r.occurred_at, now);
    // 行：投影 + 权威状态同事务写入
    let (phase, s_val, d_val, reps, first, last, lrcv, rev) = s
        .conn
        .query_row(
            "SELECT phase, stability, difficulty, reps, first_review_at, last_review_at, \
             last_reviewed_content_version, state_revision FROM ReviewState WHERE block_id = ?1",
            rusqlite::params![b],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, f64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, i64>(7)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(phase, "LEARNING");
    assert_eq!(s_val, 2.3065);
    assert_eq!(d_val, 2.11810397);
    assert_eq!(reps, 1);
    assert_eq!(first, Some(now));
    assert_eq!(last, Some(now));
    assert_eq!(lrcv, Some(1));
    assert_eq!(rev, 1);
    // 一条 RATE 历史，快照与 revision 配对
    assert_eq!(
        count(&s.conn, "SELECT COUNT(*) FROM ReviewHistory WHERE block_id = ?1", &[&b]),
        1
    );
    let (ev, br, ar, log) = s
        .conn
        .query_row(
            "SELECT event_type, before_revision, after_revision, algorithm_log_json \
             FROM ReviewHistory WHERE block_id = ?1",
            rusqlite::params![b],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<String>>(3)?)),
        )
        .unwrap();
    assert_eq!(ev, "RATE");
    assert_eq!((br, ar), (0, 1));
    assert_eq!(log.as_deref(), Some("{}"));
    // 幂等重放：同 request_id → 已保存结果，零写入（令牌已消耗也不受影响）
    let replay = submit_review_on(&mut s.conn, &mut s.tokens, &req_replay).expect("重放");
    assert!(replay.replayed);
    assert_eq!(replay.state_revision, 1);
    assert_eq!(replay.occurred_at, now);
    assert_eq!(
        count(&s.conn, "SELECT COUNT(*) FROM ReviewHistory WHERE block_id = ?1", &[&b]),
        1
    );
    // 令牌一次性：再次用新 request_id 提交 → TOKEN_INVALID
    let mut again = submit_req(&token, now, 3);
    again.request_id = new_id();
    let err = submit_review_on(&mut s.conn, &mut s.tokens, &again).unwrap_err();
    assert_eq!(err.code, "REVIEW_TOKEN_INVALID");
}

// ---------------------------------------------------------------------------
// 令牌快照 CAS：状态推进/正文变化 → TOKEN_STALE（验收：旧内容 token 被拒）
// ---------------------------------------------------------------------------

#[test]
fn m5_token_stale_on_state_or_content_change() {
    let mut s = Session {
        conn: temp_db("stale"),
        tokens: ReviewTokens::default(),
    };
    let b = new_id();
    seed_block(&mut s.conn, &b, "a.md", "body");
    make_due(&s.conn, &b);
    let (token, now) = begin(&mut s.conn, &mut s.tokens, &b);
    // 模拟期间发生了 recheck 写（state_revision 推进）
    s.conn
        .execute(
            "UPDATE ReviewState SET needs_recheck = 1, change_due_at = 2000, \
             state_revision = state_revision + 1 WHERE block_id = ?1",
            rusqlite::params![b],
        )
        .unwrap();
    let mut req = submit_req(&token, now, 3);
    req.change_resolution = Some("KEEP".into()); // 有 recheck 也不行：快照已过期
    let err = submit_review_on(&mut s.conn, &mut s.tokens, &req).unwrap_err();
    assert_eq!(err.code, "REVIEW_TOKEN_STALE");
    // 令牌已随 stale 移除：再提交 → TOKEN_INVALID
    let mut req2 = submit_req(&token, now, 3);
    req2.request_id = new_id();
    assert_eq!(
        submit_review_on(&mut s.conn, &mut s.tokens, &req2).unwrap_err().code,
        "REVIEW_TOKEN_INVALID"
    );
    // 正文版本变化（content_version 推进）同样拒
    let (token2, now2) = {
        s.conn
            .execute(
                "UPDATE ReviewState SET needs_recheck = 0, change_due_at = NULL WHERE block_id = ?1",
                rusqlite::params![b],
            )
            .unwrap();
        begin(&mut s.conn, &mut s.tokens, &b)
    };
    s.conn
        .execute(
            "UPDATE KnowledgeBlock SET content_version = 2 WHERE block_id = ?1",
            rusqlite::params![b],
        )
        .unwrap();
    let mut req3 = submit_req(&token2, now2, 3);
    req3.request_id = new_id();
    assert_eq!(
        submit_review_on(&mut s.conn, &mut s.tokens, &req3).unwrap_err().code,
        "REVIEW_TOKEN_STALE"
    );
}

// ---------------------------------------------------------------------------
// 变更沿用/重学：双事件同事务（验收：模拟断点不出现半条评分）
// ---------------------------------------------------------------------------

#[test]
fn m5_recheck_keep_and_reset_dual_events_atomic() {
    let mut s = Session {
        conn: temp_db("dual"),
        tokens: ReviewTokens::default(),
    };
    let b = new_id();
    seed_block(&mut s.conn, &b, "a.md", "body");
    make_due(&s.conn, &b);
    // 先评一次（有评分史），再模拟内容变化 recheck
    let (t0, n0) = begin(&mut s.conn, &mut s.tokens, &b);
    submit_review_on(&mut s.conn, &mut s.tokens, &submit_req(&t0, n0, 3)).expect("首评");
    s.conn
        .execute(
            "UPDATE ReviewState SET needs_recheck = 1, change_due_at = 2000 WHERE block_id = ?1",
            rusqlite::params![b],
        )
        .unwrap();
    let (t1, n1) = begin(&mut s.conn, &mut s.tokens, &b);
    // 缺决策 → 拒
    let mut no_decision = submit_req(&t1, n1, 3);
    no_decision.request_id = new_id();
    assert_eq!(
        submit_review_on(&mut s.conn, &mut s.tokens, &no_decision).unwrap_err().code,
        "REVIEW_REJECTED"
    );
    // KEEP：ACCEPT_CHANGE + RATE 两条，revision 各 +1
    let mut keep = submit_req(&t1, n1, 3);
    keep.request_id = new_id();
    keep.change_resolution = Some("KEEP".into());
    let r = submit_review_on(&mut s.conn, &mut s.tokens, &keep).expect("沿用");
    assert_eq!(r.state_revision, 3); // 1(首评) + 1(accept) + 1(rate)
    let events: Vec<(String, i64, i64)> = s
        .conn
        .prepare(
            "SELECT event_type, before_revision, after_revision FROM ReviewHistory \
             WHERE block_id = ?1 ORDER BY after_revision",
        )
        .unwrap()
        .query_map(rusqlite::params![b], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap()
        .map(|x| x.unwrap())
        .collect();
    assert_eq!(events.len(), 3);
    assert_eq!(events[1], ("ACCEPT_CHANGE".into(), 1, 2));
    assert_eq!(events[2], ("RATE".into(), 2, 3));
    assert_eq!(
        count(
            &s.conn,
            "SELECT COUNT(*) FROM ReviewState WHERE block_id = ?1 AND needs_recheck = 0 \
             AND change_due_at IS NULL",
            &[&b]
        ),
        1
    );
    // RESET：generation+1 + 空状态 + RATE 从空卡出发
    s.conn
        .execute(
            "UPDATE ReviewState SET needs_recheck = 1, change_due_at = 2000 WHERE block_id = ?1",
            rusqlite::params![b],
        )
        .unwrap();
    let (t2, n2) = begin(&mut s.conn, &mut s.tokens, &b);
    let mut reset = submit_req(&t2, n2, 3);
    reset.request_id = new_id();
    reset.change_resolution = Some("RESET".into());
    let r2 = submit_review_on(&mut s.conn, &mut s.tokens, &reset).expect("重学");
    assert_eq!(r2.state_revision, 5); // 3 + 1(reset) + 1(rate)
    let (gen, phase, reps, first): (i64, String, i64, Option<i64>) = s
        .conn
        .query_row(
            "SELECT generation, phase, reps, first_review_at FROM ReviewState WHERE block_id = ?1",
            rusqlite::params![b],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(gen, 1);
    assert_eq!(phase, "LEARNING");
    assert_eq!(reps, 1);
    assert!(first.is_some(), "重置保留终身首次评分时间");
    let events2: Vec<String> = s
        .conn
        .prepare(
            "SELECT event_type FROM ReviewHistory WHERE block_id = ?1 ORDER BY after_revision",
        )
        .unwrap()
        .query_map(rusqlite::params![b], |row| row.get(0))
        .unwrap()
        .map(|x| x.unwrap())
        .collect();
    assert_eq!(
        events2,
        vec!["RATE", "ACCEPT_CHANGE", "RATE", "RESET", "RATE"]
    );
    // 无 recheck 却带决策 → 拒
    make_due(&s.conn, &b);
    let (t3, n3) = begin(&mut s.conn, &mut s.tokens, &b);
    let mut stray = submit_req(&t3, n3, 3);
    stray.request_id = new_id();
    stray.change_resolution = Some("KEEP".into());
    assert_eq!(
        submit_review_on(&mut s.conn, &mut s.tokens, &stray).unwrap_err().code,
        "REVIEW_REJECTED"
    );
}

// ---------------------------------------------------------------------------
// 时钟守卫（§11.4：倒跳 / 漂移拒绝）
// ---------------------------------------------------------------------------

#[test]
fn m5_clock_guards_reject_backwards_and_drift() {
    let mut s = Session {
        conn: temp_db("clock"),
        tokens: ReviewTokens::default(),
    };
    let b = new_id();
    seed_block(&mut s.conn, &b, "a.md", "body");
    make_due(&s.conn, &b);
    let (token, now) = begin(&mut s.conn, &mut s.tokens, &b);
    // 漂移：动作时间显著早于当前（>10s 容差）
    let mut drift = submit_req(&token, now - 60_000, 3);
    drift.request_id = new_id();
    assert_eq!(
        submit_review_on(&mut s.conn, &mut s.tokens, &drift).unwrap_err().code,
        "TIME_ANOMALY"
    );
    // 倒跳：先正常评分建立 last_review，再用更早时间评
    let (token2, now2) = begin(&mut s.conn, &mut s.tokens, &b);
    submit_review_on(&mut s.conn, &mut s.tokens, &submit_req(&token2, now2, 3)).expect("评");
    // 重新到期后倒跳提交
    make_due(&s.conn, &b);
    let (token3, _) = begin(&mut s.conn, &mut s.tokens, &b);
    let mut backwards = submit_req(&token3, now2 - 1000, 3);
    backwards.request_id = new_id();
    assert_eq!(
        submit_review_on(&mut s.conn, &mut s.tokens, &backwards).unwrap_err().code,
        "TIME_ANOMALY"
    );
    // 未到期 → begin 与提交都拦（REVIEW_REJECTED，非令牌/时钟错误）
    s.conn
        .execute(
            "UPDATE ReviewState SET scheduled_due_at = ?1 WHERE block_id = ?2",
            rusqlite::params![now2 + 86_400_000, b],
        )
        .unwrap();
    assert_eq!(
        review_begin_on(&s.conn, &mut s.tokens, &b).unwrap_err().code,
        "REVIEW_REJECTED"
    );
    make_due(&s.conn, &b);
    let (token4, now4) = begin(&mut s.conn, &mut s.tokens, &b);
    s.conn
        .execute(
            "UPDATE ReviewState SET scheduled_due_at = ?1 WHERE block_id = ?2",
            rusqlite::params![now4 + 3_600_000, b],
        )
        .unwrap();
    let mut future = submit_req(&token4, now4, 3);
    future.request_id = new_id();
    assert_eq!(
        submit_review_on(&mut s.conn, &mut s.tokens, &future).unwrap_err().code,
        "REVIEW_REJECTED"
    );
}

// ---------------------------------------------------------------------------
// 日配额（§10.2 L399：只限终身首评；重置块不占新卡名额）
// ---------------------------------------------------------------------------

#[test]
fn m5_daily_new_quota() {
    let mut s = Session {
        conn: temp_db("quota"),
        tokens: ReviewTokens::default(),
    };
    settings_set_string(&s.conn, "review.daily_new_limit", "1", 0).unwrap();
    let b1 = new_id();
    let b2 = new_id();
    seed_block(&mut s.conn, &b1, "a.md", "b1");
    seed_block(&mut s.conn, &b2, "b.md", "b2");
    make_due(&s.conn, &b1);
    make_due(&s.conn, &b2);
    let (t1, n1) = begin(&mut s.conn, &mut s.tokens, &b1);
    let r1 = submit_review_on(&mut s.conn, &mut s.tokens, &submit_req(&t1, n1, 3)).unwrap();
    assert_eq!(r1.quota.limit, 1);
    assert_eq!(r1.quota.used_today, 1);
    assert_eq!(r1.quota.remaining, 0);
    // 第二个未评分块：begin 可过（队列侧本应限制），提交时兜底拒绝
    let (t2, n2) = begin(&mut s.conn, &mut s.tokens, &b2);
    let err = submit_review_on(&mut s.conn, &mut s.tokens, &submit_req(&t2, n2, 3)).unwrap_err();
    assert_eq!(err.code, "QUOTA_EXCEEDED");
    // 重置 b1（保留 first_review_at）→ 立即到期 → 再评不占新卡名额
    make_due(&s.conn, &b1);
    reset_block_on(&mut s.conn, &b1).expect("重置");
    let (t3, n3) = begin(&mut s.conn, &mut s.tokens, &b1);
    let r3 = submit_review_on(&mut s.conn, &mut s.tokens, &submit_req(&t3, n3, 3)).unwrap();
    assert_eq!(r3.quota.used_today, 1, "重置块不重复计数");
    // 队列：new_total 计入 b2（不隐藏积压），但 items 不含它（配额为 0）；
    // b1 重评后 due=+10m 亦不在到期集合
    let q = review_queue_on(&s.conn, None).unwrap();
    assert_eq!(q.counts.new_total, 1);
    assert!(!q.items.iter().any(|i| i.block_id == b2));
    assert!(!q.items.iter().any(|i| i.block_id == b1));
}

// ---------------------------------------------------------------------------
// 参与策略：事件成对、不动算法状态（验收：暂停恢复不冻结时间）
// ---------------------------------------------------------------------------

#[test]
fn m5_participation_ops_keep_schedule() {
    let mut s = Session {
        conn: temp_db("participation"),
        tokens: ReviewTokens::default(),
    };
    let b = new_id();
    seed_block(&mut s.conn, &b, "a.md", "body");
    make_due(&s.conn, &b);
    let (t, n) = begin(&mut s.conn, &mut s.tokens, &b);
    submit_review_on(&mut s.conn, &mut s.tokens, &submit_req(&t, n, 3)).expect("评");
    let (due_before, state_before, rev_before) = s
        .conn
        .query_row(
            "SELECT scheduled_due_at, state_json, state_revision FROM ReviewState WHERE block_id = ?1",
            rusqlite::params![b],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)),
        )
        .unwrap();
    // PAUSE → RESUME：due/算法状态字节不变
    assert_eq!(
        set_participation_on(&mut s.conn, &[b.clone()], "PAUSE").unwrap(),
        1
    );
    assert_eq!(
        set_participation_on(&mut s.conn, &[b.clone()], "RESUME").unwrap(),
        1
    );
    let (due_after, state_after, rev_after) = s
        .conn
        .query_row(
            "SELECT scheduled_due_at, state_json, state_revision FROM ReviewState WHERE block_id = ?1",
            rusqlite::params![b],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)),
        )
        .unwrap();
    assert_eq!(due_before, due_after);
    assert_eq!(state_before, state_after);
    assert_eq!(rev_after, rev_before + 2);
    // 事件与 revision 一一配对
    let events: Vec<(String, i64)> = s
        .conn
        .prepare(
            "SELECT event_type, after_revision FROM ReviewHistory WHERE block_id = ?1 \
             AND event_type <> 'RATE' ORDER BY after_revision",
        )
        .unwrap()
        .query_map(rusqlite::params![b], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .unwrap()
        .map(|x| x.unwrap())
        .collect();
    assert_eq!(events[0], ("PAUSE".into(), rev_before + 1));
    assert_eq!(events[1], ("RESUME".into(), rev_before + 2));
    // 非法转换拒绝
    assert_eq!(
        set_participation_on(&mut s.conn, &[b.clone()], "RESUME").unwrap_err().code,
        "REVIEW_REJECTED"
    );
    // EXCLUDE→INCLUDE；EXCLUDED 无自动恢复，仅显式 INCLUDE
    set_participation_on(&mut s.conn, &[b.clone()], "EXCLUDE").unwrap();
    make_due(&s.conn, &b); // 到期也不出现在队列
    let q = review_queue_on(&s.conn, None).unwrap();
    assert!(!q.items.iter().any(|i| i.block_id == b));
    set_participation_on(&mut s.conn, &[b.clone()], "INCLUDE").unwrap();
    let q2 = review_queue_on(&s.conn, None).unwrap();
    assert!(q2.items.iter().any(|i| i.block_id == b), "恢复后原计划已过期即到期");
    // 暂停可作用于缺失块（§12.5 L768）
    let b2 = new_id();
    seed_block(&mut s.conn, &b2, "c.md", "b2");
    s.conn
        .execute(
            "UPDATE KnowledgeBlock SET status = 'MISSING' WHERE block_id = ?1",
            rusqlite::params![b2],
        )
        .unwrap();
    assert_eq!(
        set_participation_on(&mut s.conn, &[b2.clone()], "PAUSE").unwrap(),
        1
    );
}

// ---------------------------------------------------------------------------
// 单独重置（§10.3 L413/§12.5 L770）
// ---------------------------------------------------------------------------

#[test]
fn m5_reset_block_empties_generation() {
    let mut s = Session {
        conn: temp_db("reset"),
        tokens: ReviewTokens::default(),
    };
    let b = new_id();
    seed_block(&mut s.conn, &b, "a.md", "body");
    make_due(&s.conn, &b);
    let (t, n) = begin(&mut s.conn, &mut s.tokens, &b);
    submit_review_on(&mut s.conn, &mut s.tokens, &submit_req(&t, n, 3)).expect("评");
    let r = reset_block_on(&mut s.conn, &b).expect("重置");
    let (phase, gen, reps, sd, first, lrcv, recheck): (
        String,
        i64,
        i64,
        i64,
        Option<i64>,
        Option<i64>,
        i64,
    ) = s
        .conn
        .query_row(
            "SELECT phase, generation, reps, scheduled_due_at, first_review_at, \
             last_reviewed_content_version, needs_recheck FROM ReviewState WHERE block_id = ?1",
            rusqlite::params![b],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(phase, "NEW");
    assert_eq!(gen, 1);
    assert_eq!(reps, 0);
    assert_eq!(sd, r.scheduled_due_at, "重置 due=操作时间");
    assert!(first.is_some(), "终身首评时间保留");
    assert_eq!(lrcv, None);
    assert_eq!(recheck, 0);
    // 重置后立即可 begin（due=now 已到期）
    review_begin_on(&s.conn, &mut s.tokens, &b).expect("重置后可评分");
    // 孤儿 request_id / 块不存在
    assert_eq!(
        reset_block_on(&mut s.conn, &new_id()).unwrap_err().code,
        "REVIEW_REJECTED"
    );
}

// ---------------------------------------------------------------------------
// 队列分组与顺序（§10.2 L398）
// ---------------------------------------------------------------------------

#[test]
fn m5_queue_groups_priority_learning_review_new() {
    let mut s = Session {
        conn: temp_db("queue"),
        tokens: ReviewTokens::default(),
    };
    let doc = "q.md";
    let mut seeded: i64 = 0;
    // b_learn: LEARNING；b_review: REVIEW；b_new: NEW（未评）；b_reset_new: NEW（重置过，已评）
    for (tag, phase, first_reviewed) in [
        ("learn", "LEARNING", true),
        ("review", "REVIEW", true),
        ("fresh", "NEW", false),
        ("resetnew", "NEW", true),
    ] {
        let id = new_id();
        seed_block_rev(&mut s.conn, &id, doc, tag, seeded);
        seeded += 1;
        s.conn
            .execute(
                "UPDATE ReviewState SET phase = ?1, \
                 first_review_at = CASE WHEN ?2 THEN 1000 ELSE NULL END, \
                 scheduled_due_at = 1000 WHERE block_id = ?3",
                rusqlite::params![phase, first_reviewed, id],
            )
            .unwrap();
    }
    let q = review_queue_on(&s.conn, None).unwrap();
    let phases: Vec<&str> = q.items.iter().map(|i| i.phase.as_str()).collect();
    assert_eq!(phases, vec!["LEARNING", "REVIEW", "NEW", "NEW"]);
    // 两个 NEW（同 due）按 block_id 排序；never_rated 与 first_review_at 实值对应
    let news: Vec<bool> = q
        .items
        .iter()
        .filter(|i| i.phase == "NEW")
        .map(|i| i.never_rated)
        .collect();
    assert_eq!(news.len(), 2);
    assert_eq!(news.iter().filter(|x| **x).count(), 1, "恰一个从未评分");
    assert_eq!(q.counts.learning, 1);
    assert_eq!(q.counts.review, 1);
    assert_eq!(q.counts.new_total, 2);
    assert_eq!(q.quota.remaining, q.quota.limit); // 无今日首评
}

// ---------------------------------------------------------------------------
// 投影一致性校验（§11.3 L501：不一致即停）
// ---------------------------------------------------------------------------

#[test]
fn m5_outcome_validation_rejects_inconsistent_projections() {
    let mut s = Session {
        conn: temp_db("validate"),
        tokens: ReviewTokens::default(),
    };
    let b = new_id();
    seed_block(&mut s.conn, &b, "a.md", "body");
    make_due(&s.conn, &b);
    let (token, now) = begin(&mut s.conn, &mut s.tokens, &b);
    let reqs = |outcome: SchedulerOutcomeDto| {
        let mut r = submit_req(&token, now, 3);
        r.request_id = new_id();
        r.outcome = outcome;
        r
    };
    let base = outcome_good_on_empty(now);
    // phase 与 state 不符
    let mut bad_phase = base.clone();
    bad_phase.phase = "REVIEW".into();
    assert_eq!(
        submit_review_on(&mut s.conn, &mut s.tokens, &reqs(bad_phase)).unwrap_err().code,
        "REVIEW_REJECTED"
    );
    // due 与 scheduled_due_at 不符
    let mut bad_due = base.clone();
    bad_due.scheduled_due_at += 1;
    assert_eq!(
        submit_review_on(&mut s.conn, &mut s.tokens, &reqs(bad_due)).unwrap_err().code,
        "REVIEW_REJECTED"
    );
    // interval 不等于 due-now
    let mut bad_interval = base.clone();
    bad_interval.interval_ms += 1;
    assert_eq!(
        submit_review_on(&mut s.conn, &mut s.tokens, &reqs(bad_interval)).unwrap_err().code,
        "REVIEW_REJECTED"
    );
    // 投影 S/D 缺失（state=1 时须有值）
    let mut bad_proj = base.clone();
    bad_proj.stability = None;
    assert_eq!(
        submit_review_on(&mut s.conn, &mut s.tokens, &reqs(bad_proj)).unwrap_err().code,
        "REVIEW_REJECTED"
    );
    // reps 不符
    let mut bad_reps = base.clone();
    bad_reps.reps = 2;
    assert_eq!(
        submit_review_on(&mut s.conn, &mut s.tokens, &reqs(bad_reps)).unwrap_err().code,
        "REVIEW_REJECTED"
    );
    // 未知键放行（无损保存未来新增字段）+ 正常提交成功
    let mut extended = base.clone();
    extended.state_json = extended
        .state_json
        .replace("{\"due\"", "{\"future_field\":42,\"due\"");
    let ok = submit_review_on(&mut s.conn, &mut s.tokens, &reqs(extended)).unwrap();
    assert!(!ok.replayed);
    // 非法 rating（上一步成功提交把 due 推进 10 分钟，先拨回到期）
    make_due(&s.conn, &b);
    let (t2, n2) = begin(&mut s.conn, &mut s.tokens, &b);
    let mut bad_rating = submit_req(&t2, n2, 9);
    bad_rating.request_id = new_id();
    assert_eq!(
        submit_review_on(&mut s.conn, &mut s.tokens, &bad_rating).unwrap_err().code,
        "REVIEW_REJECTED"
    );
}

// ---------------------------------------------------------------------------
// tombstone 复现：原计划已过期则立即到期（§9.4 L358；M4 遗留输入）
// ---------------------------------------------------------------------------

#[test]
fn m5_restore_tombstone_overdue_is_immediately_due() {
    let mut s = Session {
        conn: temp_db("tombstone"),
        tokens: ReviewTokens::default(),
    };
    let b = new_id();
    seed_block(&mut s.conn, &b, "a.md", "body");
    make_due(&s.conn, &b);
    let (t, n) = begin(&mut s.conn, &mut s.tokens, &b);
    submit_review_on(&mut s.conn, &mut s.tokens, &submit_req(&t, n, 3)).expect("评");
    let due_after_rate: i64 = s
        .conn
        .query_row(
            "SELECT scheduled_due_at FROM ReviewState WHERE block_id = ?1",
            rusqlite::params![b],
            |r| r.get(0),
        )
        .unwrap();
    // 丢失（外部删锚）→ 复现（RESTORE 走 M4 提案路径）
    let req_missing = CommitIndexBatchRequest {
        documents: vec![header("a.md", 1, &h64("doc-body"))],
        block_results: vec![BlockProposalDto {
            block_id: b.clone(),
            action: "MARK_MISSING".into(),
            status: "MISSING".into(),
            relative_path: Some("a.md".into()),
            next: None,
            change_class: None,
            content_version_delta: 0,
            needs_recheck: false,
            prev: Some(recallmd_lib::persistence::store::dto::PrevRefDto {
                relative_path: "a.md".into(),
                status: "ACTIVE".into(),
            }),
            reason: "锚点消失".into(),
            occurrences: vec![],
        }],
        snapshot_paths: vec!["a.md".into()],
    };
    commit_on(&mut s.conn, &req_missing).expect("标缺");
    let req_restore = CommitIndexBatchRequest {
        documents: vec![header("a.md", 2, &h64("doc-body"))],
        block_results: vec![BlockProposalDto {
            block_id: b.clone(),
            action: "RESTORE".into(),
            status: "ACTIVE".into(),
            relative_path: Some("a.md".into()),
            next: Some(next_dto(&b, "a.md", 0, &h64("body"))),
            change_class: None,
            content_version_delta: 0,
            needs_recheck: false,
            prev: Some(recallmd_lib::persistence::store::dto::PrevRefDto {
                relative_path: "a.md".into(),
                status: "MISSING".into(),
            }),
            reason: "锚点复现".into(),
            occurrences: vec![],
        }],
        snapshot_paths: vec!["a.md".into()],
    };
    commit_on(&mut s.conn, &req_restore).expect("复现");
    let due_now: i64 = s
        .conn
        .query_row(
            "SELECT scheduled_due_at FROM ReviewState WHERE block_id = ?1",
            rusqlite::params![b],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(due_now, due_after_rate, "缺失期不冻结也不顺延记忆时间");
    // 原计划已过期 → 复现后立即到期，无额外等待
    s.conn
        .execute(
            "UPDATE ReviewState SET scheduled_due_at = 1000 WHERE block_id = ?1",
            rusqlite::params![b],
        )
        .unwrap();
    let q2 = review_queue_on(&s.conn, None).unwrap();
    assert!(
        q2.items.iter().any(|i| i.block_id == b),
        "原计划已过期 → 复现后立即到期"
    );
}
