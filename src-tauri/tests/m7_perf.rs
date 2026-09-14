//! M7 性能预算测量（§15.1：1,000 md / 10,000 Block / 100,000 History；
//! 到期列表与统计查询 p95 ≤ 100ms——预算的两倍作断言上限防 CI 抖动，
//! 实际值经 cargo test --release -- --ignored m7_perf 输出并记录 M7_NOTES）。
//! 直接 SQL 播种（绕过引擎），聚焦查询侧；全库索引/AST 开销由 TS 引擎 perf
//! 门控覆盖（tests/engine/perf.spec.ts，RUN_PERF）。

use std::time::Instant;

use recallmd_lib::persistence::store::open_test_db;
use recallmd_lib::persistence::store::query::registry_snapshot_on;
use recallmd_lib::persistence::store::query::RegistryQuery;
use recallmd_lib::persistence::store::review::{review_queue_on, review_stats_on};
use rusqlite::Connection;

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

fn seed_scale(conn: &mut Connection) {
    let now = 1_780_000_000_000i64;
    let tx = conn.transaction().unwrap();
    let ws: String = tx
        .query_row("SELECT workspace_id FROM Workspace WHERE singleton = 1", [], |r| r.get(0))
        .unwrap();
    // 1,000 文档
    for d in 0..1000 {
        let dir_no = d / 50;
        tx.execute(
            "INSERT INTO Document (document_id, workspace_id, relative_path, path_key, status, \
             index_status, line_ending, content_hash, byte_size, disk_mtime_at, index_revision, \
             created_at, updated_at) \
             VALUES (?1, ?5, ?2, ?2, 'PRESENT', 'READY', 'LF', ?3, 2048, ?4, 1, ?4, ?4)",
            rusqlite::params![
                format!("doc-{d:04}"),
                format!("dir{dir_no:02}/file{d:04}.md"),
                h64(&format!("doc{d}")),
                now,
                ws
            ],
        )
        .unwrap();
    }
    // 10,000 块 + ReviewState（1/3 到期、participation 混合、phase 混合）
    let empty_state = recallmd_lib::persistence::store::fsrs::empty_card_state_json(1000).unwrap();
    let mut stmt = tx
        .prepare(
            "INSERT INTO KnowledgeBlock (block_id, document_id, kind, title, heading_level, \
             heading_path_json, ordinal, start_offset, body_start_offset, end_offset, source_hash, \
             body_hash, content_version, status, created_at, updated_at, content_modified_at, last_seen_at) \
             VALUES (?1, ?2, 'SECTION', ?3, 2, '[\"根\"]', 0, 0, 10, 100, ?4, ?4, 1, 'ACTIVE', ?5, ?5, ?5, ?5)",
        )
        .unwrap();
    for b in 0..10_000i64 {
        stmt.execute(rusqlite::params![
            format!("blk-{b:05}"),
            format!("doc-{:04}", b % 1000),
            format!("标题 {b}"),
            h64(&format!("blk{b}")),
            now
        ])
        .unwrap();
    }
    drop(stmt);
    let mut rs = tx
        .prepare(
            "INSERT INTO ReviewState (block_id, participation, phase, generation, state_revision, \
             algorithm_id, algorithm_version, state_schema_version, config_json, state_json, \
             scheduled_due_at, reps, lapses, stability, difficulty, first_review_at, last_review_at, \
             created_at, updated_at) \
             VALUES (?1, ?2, ?3, 0, ?8, 'fsrs', 'ts-fsrs@5.4.2+FSRS-6.0', 1, '{}', ?9, ?4, ?5, 0, \
             CASE WHEN ?3='NEW' THEN NULL ELSE 5.5 END, CASE WHEN ?3='NEW' THEN NULL ELSE 5.5 END, \
             ?6, ?6, ?7, ?7)",
        )
        .unwrap();
    for b in 0..10_000i64 {
        let phase = match b % 10 {
            0..=3 => "LEARNING",
            4..=7 => "REVIEW",
            _ => "NEW",
        };
        let participation = if b % 20 == 19 { "PAUSED" } else { "ENABLED" };
        let due = if b % 3 == 0 { 1000 } else { now + 86_400_000 }; // 1/3 到期
        rs.execute(rusqlite::params![
            format!("blk-{b:05}"),
            participation,
            phase,
            due,
            (b % 7) + 1,
            now - b,
            now,
            b, // state_revision
            &empty_state
        ])
        .unwrap();
    }
    drop(rs);
    // 100,000 条历史（RATE 分布 1-4）
    let mut hh = tx
        .prepare(
            "INSERT INTO ReviewHistory (history_id, request_id, block_id, event_type, rating, \
             generation, content_version, content_hash, document_hash, before_revision, \
             after_revision, before_state_json, after_state_json, context_used, occurred_at, \
             created_at, updated_at) \
             VALUES (?1, ?2, ?3, 'RATE', ?4, 0, 1, ?5, ?5, ?6, ?7, '{}', '{}', 0, ?8, ?8, ?8)",
        )
        .unwrap();
    for i in 0..100_000i64 {
        hh.execute(rusqlite::params![
            format!("hist-{i:06}"),
            format!("req-{i:06}"),
            format!("blk-{:05}", i % 10_000),
            (i % 4) + 1,
            h64(&format!("h{i}")),
            i,
            i + 1,
            now - i * 60_000
        ])
        .unwrap();
    }
    drop(hh);
    tx.commit().unwrap();
}

fn percentiles(mut samples: Vec<f64>) -> (f64, f64) {
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let at = |q: f64| -> f64 {
        let idx = ((samples.len() as f64 - 1.0) * q).round() as usize;
        samples[idx.min(samples.len() - 1)]
    };
    (at(0.5), at(0.95))
}

#[test]
#[ignore = "规模化测量：cargo test --release -- --ignored m7_perf（§15.1 预算验证）"]
fn m7_perf_scale_queries() {
    let dir = std::env::temp_dir().join(format!("recallmd-m7-perf-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut conn = open_test_db(&dir.join("metadata.sqlite")).expect("开库");
    let t0 = Instant::now();
    seed_scale(&mut conn);
    println!("播种 1k 文档/10k 块/100k 历史：{:.1?}", t0.elapsed());

    let mut queue = Vec::new();
    let mut stats = Vec::new();
    let mut registry = Vec::new();
    for _ in 0..30 {
        let t = Instant::now();
        let q = review_queue_on(&conn, None).unwrap();
        queue.push(t.elapsed().as_secs_f64() * 1000.0);
        let t = Instant::now();
        review_stats_on(&conn).unwrap();
        stats.push(t.elapsed().as_secs_f64() * 1000.0);
        let t = Instant::now();
        registry_snapshot_on(&conn, &RegistryQuery::default()).unwrap();
        registry.push(t.elapsed().as_secs_f64() * 1000.0);
        let _ = q.items.len();
    }
    let (q50, q95) = percentiles(queue);
    let (s50, s95) = percentiles(stats);
    let (r50, r95) = percentiles(registry);
    println!("review_queue    p50={q50:.1}ms p95={q95:.1}ms（预算 100ms）");
    println!("review_stats    p50={s50:.1}ms p95={s95:.1}ms（预算 100ms）");
    println!("registry_snapshot p50={r50:.1}ms p95={r95:.1}ms");
    assert!(q95 <= 200.0, "queue p95 {q95:.1}ms 超预算两倍");
    assert!(s95 <= 200.0, "stats p95 {s95:.1}ms 超预算两倍");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[ignore = "诊断：各子查询耗时分解"]
fn m7_perf_breakdown() {
    let dir = std::env::temp_dir().join(format!("recallmd-m7-bd-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut conn = open_test_db(&dir.join("metadata.sqlite")).expect("开库");
    seed_scale(&mut conn);
    let now = 1_789_000_000_000i64;
    let probes: Vec<(&str, &str)> = vec![
        ("grp-learning", "SELECT r.block_id, d.relative_path, b.title, b.heading_path_json, r.phase, r.next_review_at, r.needs_recheck, r.first_review_at, b.recall_prompt, b.start_offset, b.body_start_offset, b.end_offset FROM ReviewState r JOIN KnowledgeBlock b ON b.block_id=r.block_id JOIN Document d ON d.document_id=b.document_id WHERE r.participation='ENABLED' AND r.next_review_at <= ?1 AND b.status='ACTIVE' AND d.status='PRESENT' AND d.index_status='READY' AND r.phase IN ('LEARNING','RELEARNING') ORDER BY r.next_review_at, r.block_id LIMIT 50"),
        ("grp-review", "SELECT r.block_id FROM ReviewState r JOIN KnowledgeBlock b ON b.block_id=r.block_id JOIN Document d ON d.document_id=b.document_id WHERE r.participation='ENABLED' AND r.next_review_at <= ?1 AND b.status='ACTIVE' AND d.status='PRESENT' AND d.index_status='READY' AND r.phase = 'REVIEW' ORDER BY r.next_review_at, r.block_id LIMIT 50"),
        ("counts-merged", "SELECT COALESCE(SUM(CASE WHEN r.phase IN ('LEARNING','RELEARNING') THEN 1 ELSE 0 END),0), COALESCE(SUM(CASE WHEN r.phase='REVIEW' THEN 1 ELSE 0 END),0), COALESCE(SUM(CASE WHEN r.phase='NEW' THEN 1 ELSE 0 END),0) FROM ReviewState r JOIN KnowledgeBlock b ON b.block_id=r.block_id JOIN Document d ON d.document_id=b.document_id WHERE r.participation='ENABLED' AND r.next_review_at <= ?1 AND b.status='ACTIVE' AND d.status='PRESENT' AND d.index_status='READY'"),
        ("upcoming", "SELECT MIN(r.next_review_at) FROM ReviewState r JOIN KnowledgeBlock b ON b.block_id=r.block_id JOIN Document d ON d.document_id=b.document_id WHERE r.participation='ENABLED' AND r.next_review_at > ?1 AND b.status='ACTIVE' AND d.status='PRESENT' AND d.index_status='READY'"),
        ("quota", "SELECT COUNT(*) FROM ReviewState WHERE first_review_at IS NOT NULL AND first_review_at >= ?1 - 86400000 AND first_review_at < ?1 + 86400000"),
        ("explain-counts", "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM ReviewState r JOIN KnowledgeBlock b ON b.block_id=r.block_id JOIN Document d ON d.document_id=b.document_id WHERE r.participation='ENABLED' AND r.next_review_at <= ?1 AND b.status='ACTIVE' AND d.status='PRESENT' AND d.index_status='READY'"),
    ];
    for (name, sql) in &probes {
        let mut best = f64::MAX;
        for _ in 0..10 {
            let t = Instant::now();
            if name.starts_with("explain") {
                let mut stmt = conn.prepare(sql).unwrap();
                let rows: Vec<String> = stmt
                    .query_map(rusqlite::params![now], |r| r.get::<_, String>(3))
                    .unwrap()
                    .map(|x| x.unwrap())
                    .collect();
                for row in &rows {
                    println!("PLAN {name}: {row}");
                }
            } else {
                conn.query_row(sql, rusqlite::params![now], |_| Ok(())).unwrap();
            }
            best = best.min(t.elapsed().as_secs_f64() * 1000.0);
        }
        println!("{name}: best={best:.2}ms");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
