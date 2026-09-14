//! M6 命令层测试：队列项扩展（提示/offsets/稍后到期）、简版统计、
//! 应用配置白名单、块提示与会话失效。

use recallmd_lib::persistence::store::commit::commit_on;
use recallmd_lib::persistence::store::dto::{
    BlockNextDto, BlockProposalDto, CommitIndexBatchRequest, DocumentHeaderDto,
};
use recallmd_lib::persistence::store::open_test_db;
use recallmd_lib::persistence::store::review::{
    app_config_on, app_config_set_on, review_begin_on, review_queue_on, review_stats_on,
    set_prompt_on, submit_review_on, ReviewTokens, SchedulerOutcomeDto, SubmitReviewRequest,
};
use rusqlite::Connection;

fn temp_db(name: &str) -> Connection {
    let dir = std::env::temp_dir().join(format!(
        "recallmd-m6-{}-{}",
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

fn seed_block(conn: &mut Connection, block_id: &str, path: &str, body_tag: &str, rev: i64) {
    let body_hash = h64(body_tag);
    let req = CommitIndexBatchRequest {
        documents: vec![DocumentHeaderDto {
            relative_path: path.into(),
            expected_index_revision: rev,
            observed_hash: h64(&format!("doc-{body_tag}")),
            parser_version: "remark-parse@11.0.0/fingerprint-v1".into(),
            byte_size: 128,
            mtime_ms: 1_700_000_000_000,
            line_ending: "LF".into(),
            has_bom: false,
            diagnostics: vec![],
        }],
        block_results: vec![BlockProposalDto {
            block_id: block_id.into(),
            action: "CREATE".into(),
            status: "ACTIVE".into(),
            relative_path: Some(path.into()),
            next: Some(next_dto(block_id, path, 0, &body_hash)),
            change_class: None,
            content_version_delta: 1,
            needs_recheck: false,
            prev: None,
            reason: "首次登记".into(),
            occurrences: vec![],
        }],
        snapshot_paths: vec![path.into()],
    };
    commit_on(conn, &req).expect("落库");
}

fn make_due(conn: &Connection, block_id: &str) {
    conn.execute(
        "UPDATE ReviewState SET scheduled_due_at = 1000 WHERE block_id = ?1",
        rusqlite::params![block_id],
    )
    .unwrap();
}

fn outcome_good_on_empty(now: i64) -> SchedulerOutcomeDto {
    let due = now + 600_000;
    let iso = |ms: i64| recallmd_lib::persistence::store::fsrs::iso8601_ms(ms).unwrap();
    SchedulerOutcomeDto {
        state_json: format!(
            "{{\"due\":\"{}\",\"stability\":2.3065,\"difficulty\":2.11810397,\
             \"elapsed_days\":0,\"scheduled_days\":0,\"reps\":1,\"lapses\":0,\
             \"learning_steps\":1,\"state\":1,\"last_review\":\"{}\"}}",
            iso(due),
            iso(now)
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

fn rate_once(conn: &mut Connection, tokens: &mut ReviewTokens, block_id: &str, rating: i64) {
    make_due(conn, block_id);
    let begin = review_begin_on(conn, tokens, block_id).expect("begin");
    let req = SubmitReviewRequest {
        request_id: new_id(),
        token: begin.token,
        rating,
        now_ms: begin.now_ms,
        change_resolution: None,
        context_used: false,
        duration_ms: None,
        outcome: outcome_good_on_empty(begin.now_ms),
    };
    submit_review_on(conn, tokens, &req).expect("评分");
}

// ---------------------------------------------------------------------------
// 队列项扩展与稍后到期
// ---------------------------------------------------------------------------

#[test]
fn m6_queue_item_carries_prompt_offsets_and_upcoming() {
    let mut s = temp_db("queue-ext");
    let mut tokens = ReviewTokens::default();
    let b1 = new_id();
    let b2 = new_id();
    seed_block(&mut s, &b1, "a.md", "one", 0);
    seed_block(&mut s, &b2, "b.md", "two", 0);
    make_due(&s, &b1);
    set_prompt_on(&mut s, &b1, Some("RDB 的两种实现？")).unwrap();
    let q = review_queue_on(&s, None).unwrap();
    let item = q.items.iter().find(|i| i.block_id == b1).unwrap();
    assert_eq!(item.recall_prompt.as_deref(), Some("RDB 的两种实现？"));
    assert_eq!((item.start_offset, item.body_start_offset, item.end_offset), (0, 12, 200));
    // b2 未到期 → 不在 items，但 next_upcoming_at 指向它的 due
    assert!(!q.items.iter().any(|i| i.block_id == b2));
    let due2: i64 = s
        .query_row(
            "SELECT scheduled_due_at FROM ReviewState WHERE block_id = ?1",
            rusqlite::params![b2],
            |r| r.get(0),
        )
        .unwrap();
    assert!(due2 > q.now_ms);
    assert_eq!(q.next_upcoming_at, Some(due2));
    // 全部到期时无 upcoming
    make_due(&s, &b2);
    let q2 = review_queue_on(&s, None).unwrap();
    assert_eq!(q2.next_upcoming_at, None);
}

// ---------------------------------------------------------------------------
// 简版统计（仅 RATE 计数）
// ---------------------------------------------------------------------------

#[test]
fn m6_stats_count_only_rate_events() {
    let mut s = temp_db("stats");
    let mut tokens = ReviewTokens::default();
    let b1 = new_id();
    let b2 = new_id();
    seed_block(&mut s, &b1, "a.md", "one", 0);
    seed_block(&mut s, &b2, "b.md", "two", 0);
    rate_once(&mut s, &mut tokens, &b1, 3);
    rate_once(&mut s, &mut tokens, &b2, 4);
    rate_once(&mut s, &mut tokens, &b1, 1); // b1 第二次（重拨到期）
    // 非 RATE 事件不计入评分统计
    recallmd_lib::persistence::store::review::set_participation_on(&mut s, &[b1.clone()], "PAUSE")
        .unwrap();
    let st = review_stats_on(&s).unwrap();
    assert_eq!(st.rated_today, 3);
    assert_eq!(st.rated_7d, 3);
    assert_eq!(st.rated_30d, 3);
    assert_eq!(st.distinct_blocks_7d, 2);
    assert_eq!(st.ratings_7d, [1, 0, 1, 1]); // Again1 Good1 Easy1
    assert_eq!(st.paused, 1);
    assert_eq!(st.enabled, 1);
    assert_eq!(st.excluded, 0);
    assert_eq!(st.due.learning, 0, "b1 暂停、b2 评后未到期");
}

// ---------------------------------------------------------------------------
// 应用配置白名单
// ---------------------------------------------------------------------------

#[test]
fn m6_app_config_whitelist_and_validation() {
    let mut s = temp_db("config");
    let cfg = app_config_on(&s).unwrap();
    assert_eq!(cfg.daily_new_limit, 20, "缺省 20");
    assert!(cfg.autosave, "缺省开");
    app_config_set_on(&mut s, "review.daily_new_limit", "7").unwrap();
    app_config_set_on(&mut s, "editor.autosave", "0").unwrap();
    let cfg = app_config_on(&s).unwrap();
    assert_eq!((cfg.daily_new_limit, cfg.autosave), (7, false));
    // 越界/非法值拒绝，且不落库
    assert_eq!(
        app_config_set_on(&mut s, "review.daily_new_limit", "101").unwrap_err().code,
        "REVIEW_REJECTED"
    );
    assert_eq!(
        app_config_set_on(&mut s, "editor.autosave", "yes").unwrap_err().code,
        "REVIEW_REJECTED"
    );
    assert_eq!(
        app_config_set_on(&mut s, "evil.key", "1").unwrap_err().code,
        "REVIEW_REJECTED"
    );
    assert_eq!(app_config_on(&s).unwrap().daily_new_limit, 7);
    // 配额即时生效
    let b = new_id();
    seed_block(&mut s, &b, "a.md", "x", 0);
    make_due(&s, &b);
    let q = review_queue_on(&s, None).unwrap();
    assert_eq!(q.quota.limit, 7);
}

// ---------------------------------------------------------------------------
// 块提示：长度上限、令牌失效
// ---------------------------------------------------------------------------

#[test]
fn m6_set_prompt_updates_and_invalidates_session() {
    let mut s = temp_db("prompt");
    let mut tokens = ReviewTokens::default();
    let b = new_id();
    seed_block(&mut s, &b, "a.md", "x", 0);
    make_due(&s, &b);
    // 长度上限（200 字符，按字符计）
    let long = "提".repeat(201);
    assert_eq!(
        set_prompt_on(&mut s, &b, Some(&long)).unwrap_err().code,
        "REVIEW_REJECTED"
    );
    set_prompt_on(&mut s, &b, Some("两种持久化？")).unwrap();
    // 提示=题面变化 → 进行中令牌失效
    make_due(&s, &b);
    let begin = review_begin_on(&s, &mut tokens, &b).unwrap();
    set_prompt_on(&mut s, &b, Some("改过的提示")).unwrap();
    let req = SubmitReviewRequest {
        request_id: new_id(),
        token: begin.token,
        rating: 3,
        now_ms: begin.now_ms,
        change_resolution: None,
        context_used: false,
        duration_ms: None,
        outcome: outcome_good_on_empty(begin.now_ms),
    };
    assert_eq!(
        submit_review_on(&mut s, &mut tokens, &req).unwrap_err().code,
        "REVIEW_TOKEN_STALE"
    );
    // 重新 begin 可评，清提示回 NULL
    make_due(&s, &b);
    let begin2 = review_begin_on(&s, &mut tokens, &b).unwrap();
    let req2 = SubmitReviewRequest {
        request_id: new_id(),
        token: begin2.token,
        rating: 3,
        now_ms: begin2.now_ms,
        change_resolution: None,
        context_used: false,
        duration_ms: None,
        outcome: outcome_good_on_empty(begin2.now_ms),
    };
    submit_review_on(&mut s, &mut tokens, &req2).unwrap();
    set_prompt_on(&mut s, &b, None).unwrap();
    let prompt: Option<String> = s
        .query_row(
            "SELECT recall_prompt FROM KnowledgeBlock WHERE block_id = ?1",
            rusqlite::params![b],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(prompt, None);
    // 未知块拒绝
    assert_eq!(
        set_prompt_on(&mut s, &new_id(), Some("x")).unwrap_err().code,
        "REVIEW_REJECTED"
    );
}
