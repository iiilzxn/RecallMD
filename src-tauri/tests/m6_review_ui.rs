//! M6 命令层测试：队列项扩展（得分点状态/offsets/稍后到期）、简版统计、
//! 应用配置白名单、得分点与会话失效。

use recallmd_lib::persistence::store::commit::commit_on;
use recallmd_lib::persistence::store::dto::{
    BlockNextDto, BlockProposalDto, CommitIndexBatchRequest, DocumentHeaderDto,
};
use recallmd_lib::persistence::store::open_test_db;
use recallmd_lib::persistence::store::review::{
    app_config_on, app_config_set_on, learning_begin_on, learning_queue_on, review_begin_on, review_queue_on, review_stats_on,
    submit_review_on, ReviewTokens, SchedulerOutcomeDto, SubmitReviewRequest,
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
            file_identity: None,
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
fn m6_queue_item_carries_rubric_status_offsets_and_upcoming() {
    let mut s = temp_db("queue-ext");
    let b1 = new_id();
    let b2 = new_id();
    seed_block(&mut s, &b1, "a.md", "one", 0);
    seed_block(&mut s, &b2, "b.md", "two", 0);
    make_due(&s, &b1);
    // Existing databases may still contain the retired field; queues ignore it.
    s.execute("UPDATE KnowledgeBlock SET recall_prompt = '旧回忆目标' WHERE block_id = ?1", [&b1]).unwrap();
    let q = review_queue_on(&s, None).unwrap();
    let item = q.items.iter().find(|i| i.block_id == b1).unwrap();
    assert!(!item.has_rubric);
    assert!(!serde_json::to_string(item).unwrap().contains("recallPrompt"));
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
    assert_eq!(st.ratings_today, [1, 0, 1, 1], "今日分布=7 天分布（全在今天）");
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
// 得分点：保存、队列状态与令牌失效
// ---------------------------------------------------------------------------

#[test]
fn note_rubrics_edit_before_due_without_consuming_learning_quota() {
    use recallmd_lib::persistence::store::rubric::{note_read_on, note_save_on, SaveNoteRubric};
    let mut conn = temp_db("note-rubric");
    let id = new_id();
    seed_block(&mut conn, &id, "note.md", "original", 0);
    app_config_set_on(&conn, "review.daily_new_limit", "0").unwrap();
    let before = review_stats_on(&conn).unwrap();
    let due: i64 = conn.query_row("SELECT scheduled_due_at FROM ReviewState WHERE block_id = ?1", [&id], |r| r.get(0)).unwrap();
    let hash = h64("doc-original");
    let entries = note_read_on(&conn, "note.md", &hash).unwrap();
    assert_eq!(entries.len(), 1);
    let request = SaveNoteRubric { relative_path: "note.md".into(), expected_hash: hash.clone(), block_id: id.clone(), expected_points: vec![], points: vec!["超过五字的完整得分点仍保存全文".into(), "第二个得分点".into()] };
    let saved = note_save_on(&mut conn, &request).unwrap();
    assert_eq!(saved.points, request.points);
    assert_eq!(note_read_on(&conn, "note.md", &hash).unwrap()[0].points, request.points);
    assert_eq!(review_stats_on(&conn).unwrap().rated_today, before.rated_today);
    assert_eq!(conn.query_row("SELECT scheduled_due_at FROM ReviewState WHERE block_id = ?1", [&id], |r| r.get::<_, i64>(0)).unwrap(), due);
    let mut next = request;
    next.expected_points = saved.points;
    next.points = vec![];
    assert!(note_save_on(&mut conn, &next).unwrap().points.is_empty());
}

#[test]
fn note_rubrics_reject_stale_versions_wrong_sections_and_concurrent_edits() {
    use recallmd_lib::persistence::store::rubric::{note_read_on, note_save_on, read_on, SaveNoteRubric};
    let mut conn = temp_db("note-rubric-stale");
    let id = new_id();
    seed_block(&mut conn, &id, "note.md", "original", 0);
    make_due(&conn, &id);
    let mut tokens = ReviewTokens::default();
    let begin = review_begin_on(&conn, &mut tokens, &id).unwrap();
    let mut request = SaveNoteRubric { relative_path: "note.md".into(), expected_hash: h64("doc-original"), block_id: id.clone(), expected_points: vec![], points: vec!["当前标准".into()] };
    note_save_on(&mut conn, &request).unwrap();
    assert_eq!(note_save_on(&mut conn, &request).unwrap_err().code, "JEV_RUBRIC_STALE");
    assert_eq!(recallmd_lib::persistence::store::review::jev_grade_context_on(&conn, &tokens, &begin.token).unwrap_err().code, "REVIEW_TOKEN_STALE");
    request.expected_points = vec!["当前标准".into()];
    request.expected_hash = h64("old-version");
    assert_eq!(note_save_on(&mut conn, &request).unwrap_err().code, "JEV_NOTE_STALE");
    request.expected_hash = h64("doc-original");
    request.relative_path = "another.md".into();
    assert_eq!(note_save_on(&mut conn, &request).unwrap_err().code, "JEV_NOTE_STALE");
    assert_eq!(read_on(&conn, &id).unwrap().points, vec!["当前标准"]);
    conn.execute("UPDATE KnowledgeBlock SET status = 'ID_CONFLICT' WHERE block_id = ?1", [&id]).unwrap();
    assert!(note_read_on(&conn, "note.md", &h64("doc-original")).unwrap().is_empty());
}

#[test]
fn jev_rubric_persists_without_leaking_into_queue_and_invalidates_tokens() {
    use recallmd_lib::persistence::store::{rubric, review::jev_grade_context_on};
    let mut conn = temp_db("jev-rubric");
    let id = new_id();
    seed_block(&mut conn, &id, "jev.md", "original", 0);
    make_due(&conn, &id);
    let mut tokens = ReviewTokens::default();
    let before = review_begin_on(&conn, &mut tokens, &id).unwrap();
    assert_eq!(jev_grade_context_on(&conn, &tokens, &before.token).unwrap_err().code, "JEV_RUBRIC_MISSING");
    rubric::save_on(&mut conn, &id, &["  独立的秘密得分点  ".into(), "必要条件".into()]).unwrap();
    assert_eq!(rubric::read_on(&conn, &id).unwrap().points, vec!["独立的秘密得分点", "必要条件"]);
    assert_eq!(jev_grade_context_on(&conn, &tokens, &before.token).unwrap_err().code, "REVIEW_TOKEN_STALE");
    let queue = serde_json::to_string(&review_queue_on(&conn, None).unwrap()).unwrap();
    assert!(!queue.contains("独立的秘密得分点"));
    let item = review_queue_on(&conn, None).unwrap().items.remove(0);
    assert!(item.has_rubric);
    assert!(queue.contains("\"hasRubric\":true"));
    // Historical recall goals must not override the section question sent to Jev.
    conn.execute("UPDATE KnowledgeBlock SET recall_prompt = '旧回忆目标，不能作为题目' WHERE block_id = ?1", [&id]).unwrap();
    let fresh = review_begin_on(&conn, &mut tokens, &id).unwrap();
    let context = jev_grade_context_on(&conn, &tokens, &fresh.token).unwrap();
    assert_eq!(context.points.len(), 2);
    assert_eq!(context.prompt, item.title.unwrap());
    tokens.remove(&fresh.token);
    assert_eq!(jev_grade_context_on(&conn, &tokens, &fresh.token).unwrap_err().code, "REVIEW_TOKEN_INVALID");
}

#[test]
fn jev_invalid_rubric_does_not_overwrite_or_advance_state() {
    use recallmd_lib::persistence::store::{rubric, review::jev_grade_context_on};
    let mut conn = temp_db("jev-invalid");
    let id = new_id();
    seed_block(&mut conn, &id, "jev.md", "original", 0);
    make_due(&conn, &id);
    rubric::save_on(&mut conn, &id, &["原标准".into()]).unwrap();
    let mut tokens = ReviewTokens::default();
    let begin = review_begin_on(&conn, &mut tokens, &id).unwrap();
    for invalid in [vec![" ".into()], vec!["点".into(); 31], vec!["中".repeat(501)]] {
        assert!(rubric::save_on(&mut conn, &id, &invalid).is_err());
        assert_eq!(jev_grade_context_on(&conn, &tokens, &begin.token).unwrap().points, vec!["原标准"]);
    }
    rubric::save_on(&mut conn, &id, &[]).unwrap();
    assert!(!review_queue_on(&conn, None).unwrap().items[0].has_rubric);
    let fresh = review_begin_on(&conn, &mut tokens, &id).unwrap();
    assert_eq!(jev_grade_context_on(&conn, &tokens, &fresh.token).unwrap_err().code, "JEV_RUBRIC_MISSING");
}

#[test]
fn jev_saving_from_stale_page_does_not_adopt_changed_content() {
    use recallmd_lib::persistence::store::{rubric, review::{save_rubric_for_review_on, jev_grade_context_on}};
    let mut conn = temp_db("jev-stale-save");
    let id = new_id();
    seed_block(&mut conn, &id, "jev.md", "original", 0);
    make_due(&conn, &id);
    let mut tokens = ReviewTokens::default();
    let begin = review_begin_on(&conn, &mut tokens, &id).unwrap();
    let updated = save_rubric_for_review_on(&mut conn, &mut tokens, &begin.token, &["原标准".into()]).unwrap();
    assert_eq!(updated.state.state_revision, begin.state.state_revision + 1);
    assert_eq!(jev_grade_context_on(&conn, &tokens, &updated.token).unwrap().points, vec!["原标准"]);
    conn.execute("UPDATE KnowledgeBlock SET content_version = content_version + 1 WHERE block_id = ?1", [&id]).unwrap();
    assert_eq!(save_rubric_for_review_on(&mut conn, &mut tokens, &updated.token, &["新标准".into()]).unwrap_err().code, "REVIEW_TOKEN_STALE");
    assert_eq!(rubric::read_on(&conn, &id).unwrap().points, vec!["原标准"]);
}

#[test]
fn immediate_learning_keeps_original_schedule_until_first_rating() {
    let mut s = temp_db("learn-now");
    let mut tokens = ReviewTokens::default();
    let b = new_id();
    seed_block(&mut s, &b, "new.md", "new", 0);
    assert!(review_queue_on(&s, None).unwrap().items.is_empty());
    assert_eq!(review_begin_on(&s, &mut tokens, &b).unwrap_err().code, "REVIEW_REJECTED");
    let q = learning_queue_on(&s, None).unwrap();
    assert_eq!(q.items.len(), 1);
    assert_eq!(q.counts.new_total, 1);
    let original_due = q.items[0].next_review_at;
    let begin = learning_begin_on(&s, &mut tokens, &b).unwrap();
    assert!(original_due > begin.now_ms);
    assert_eq!(begin.state.scheduled_due_at, original_due);
    assert_eq!(begin.state.reps, 0);
    assert_eq!(begin.state.state_revision, 0);
    assert_eq!(learning_queue_on(&s, None).unwrap().quota.used_today, 0);

    recallmd_lib::persistence::store::rubric::save_on(&mut s, &b, &["查询需要索引之外的列".into()]).unwrap();
    let make_request = |token: String, now: i64| SubmitReviewRequest {
        request_id: new_id(), token, rating: 3, now_ms: now,
        change_resolution: None, context_used: false, duration_ms: Some(1000),
        outcome: outcome_good_on_empty(now),
    };
    let stale = make_request(begin.token, begin.now_ms);
    assert_eq!(submit_review_on(&mut s, &mut tokens, &stale).unwrap_err().code, "REVIEW_TOKEN_STALE");
    let q = learning_queue_on(&s, None).unwrap();
    assert!(q.items[0].has_rubric);
    assert_eq!(q.items[0].next_review_at, original_due);

    let begin = learning_begin_on(&s, &mut tokens, &b).unwrap();
    let req = make_request(begin.token, begin.now_ms);
    let result = submit_review_on(&mut s, &mut tokens, &req).unwrap();
    assert_eq!(result.next_review_at, req.now_ms + 600_000);
    assert_eq!(result.quota.used_today, 1);
    assert!(submit_review_on(&mut s, &mut tokens, &req).unwrap().replayed);
    assert!(learning_queue_on(&s, None).unwrap().items.is_empty());
    assert_eq!(learning_begin_on(&s, &mut tokens, &b).unwrap_err().code, "REVIEW_REJECTED");
    assert_eq!(review_begin_on(&s, &mut tokens, &b).unwrap_err().code, "REVIEW_REJECTED");
    make_due(&s, &b);
    assert_eq!(review_queue_on(&s, None).unwrap().items[0].phase, "LEARNING");
    assert!(review_begin_on(&s, &mut tokens, &b).is_ok());
}

#[test]
fn immediate_learning_respects_quota_even_if_it_changes_after_begin() {
    let mut s = temp_db("learn-quota");
    let mut tokens = ReviewTokens::default();
    let b = new_id();
    seed_block(&mut s, &b, "new.md", "new", 0);
    let begin = learning_begin_on(&s, &mut tokens, &b).unwrap();
    app_config_set_on(&mut s, "review.daily_new_limit", "0").unwrap();
    let q = learning_queue_on(&s, Some(50)).unwrap();
    assert!(q.items.is_empty());
    assert_eq!(q.counts.new_total, 1);
    assert_eq!(learning_begin_on(&s, &mut tokens, &b).unwrap_err().code, "QUOTA_EXCEEDED");
    let req = SubmitReviewRequest {
        request_id: new_id(), token: begin.token, rating: 3, now_ms: begin.now_ms,
        change_resolution: None, context_used: false, duration_ms: None,
        outcome: outcome_good_on_empty(begin.now_ms),
    };
    assert_eq!(submit_review_on(&mut s, &mut tokens, &req).unwrap_err().code, "QUOTA_EXCEEDED");
    app_config_set_on(&mut s, "review.daily_new_limit", "1").unwrap();
    assert_eq!(learning_queue_on(&s, None).unwrap().items.len(), 1);
    assert_eq!(learning_begin_on(&s, &mut tokens, &b).unwrap().state.reps, 0);
}

#[test]
fn immediate_learning_excludes_unavailable_and_previously_rated_blocks() {
    let mut s = temp_db("learn-eligibility");
    let mut tokens = ReviewTokens::default();
    for (index, condition) in [
        "participation = 'PAUSED'", "participation = 'EXCLUDED'",
        "first_review_at = 1000", "phase = 'REVIEW'",
    ].iter().enumerate() {
        let b = new_id();
        seed_block(&mut s, &b, &format!("{index}.md"), "new", 0);
        s.execute(&format!("UPDATE ReviewState SET {condition} WHERE block_id = ?1"), [&b]).unwrap();
        assert!(learning_begin_on(&s, &mut tokens, &b).is_err());
    }
    let missing = new_id();
    seed_block(&mut s, &missing, "missing.md", "new", 0);
    s.execute("UPDATE Document SET status = 'MISSING' WHERE relative_path = 'missing.md'", []).unwrap();
    assert!(learning_begin_on(&s, &mut tokens, &missing).is_err());
    assert!(learning_queue_on(&s, None).unwrap().items.is_empty());
    assert_eq!(learning_queue_on(&s, None).unwrap().counts.new_total, 0);
}
