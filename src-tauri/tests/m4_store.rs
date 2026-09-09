//! M4 Stage 1 集成测试：DDL/FK/CHECK/生成列（验收①）、索引幂等与 CAS（②）、
//! 跨文件移动单一状态（③）、事务原子性。直连 Connection，不经工作线程/激活态，
//! 无需 TEST_LOCK 串行。

use recallmd_lib::persistence::store::commit::commit_on;
use recallmd_lib::persistence::store::dto::{
    BlockNextDto, BlockProposalDto, CommitIndexBatchRequest, DocumentHeaderDto, PrevRefDto,
};
use recallmd_lib::persistence::store::fsrs;
use recallmd_lib::persistence::store::open_test_db;
use recallmd_lib::persistence::store::query::registry_snapshot_on;
use rusqlite::Connection;

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

fn temp_db(name: &str) -> Connection {
    let dir = std::env::temp_dir().join(format!(
        "recallmd-m4-{}-{}",
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
    // 确定性 64 位小写十六进制（合法哈希形状；内容语义由 tag 区分）
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

fn batch(
    docs: Vec<DocumentHeaderDto>,
    proposals: Vec<BlockProposalDto>,
    snapshot_paths: Vec<String>,
) -> CommitIndexBatchRequest {
    CommitIndexBatchRequest {
        documents: docs,
        block_results: proposals,
        snapshot_paths,
    }
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

// ---------------------------------------------------------------------------
// 验收①：DDL / FK / CHECK / 索引 / 生成列
// ---------------------------------------------------------------------------

#[test]
fn m4_ddl_matches_spec() {
    let conn = temp_db("ddl");
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(),
        1
    );
    let mut stmt = conn
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .unwrap();
    let rows: Vec<(String, String, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let names: Vec<&str> = rows.iter().map(|(_, n, _)| n.as_str()).collect();
    for table in [
        "Workspace", "Document", "KnowledgeBlock", "ReviewState", "ReviewHistory", "Settings",
    ] {
        assert!(names.contains(&table), "缺表 {table}");
    }
    for index in [
        "document_live_path",
        "document_status",
        "document_file_identity",
        "block_document_order",
        "block_status",
        "review_due",
        "review_first_seen",
        "history_block_time",
        "history_rating_time",
    ] {
        assert!(names.contains(&index), "缺索引 {index}");
    }
    // 关键 CHECK 原文（§12.4）
    let all_sql: String = rows
        .iter()
        .filter_map(|(_, _, sql)| sql.clone())
        .collect::<Vec<_>>()
        .join("\n");
    for fragment in [
        "CHECK (singleton = 1)",
        "CHECK (start_offset <= body_start_offset AND body_start_offset <= end_offset)",
        "CHECK (after_revision = before_revision + 1)",
        "CHECK (updated_at = created_at)",
        "CHECK ((needs_recheck = 0 AND change_due_at IS NULL) OR",
        "GENERATED ALWAYS AS",
        "WHERE status <> 'DELETED'",
        "WHERE participation = 'ENABLED'",
    ] {
        assert!(all_sql.contains(fragment), "DDL 缺片段：{fragment}");
    }
}

#[test]
fn m4_fk_restrict_rejects_orphans() {
    let conn = temp_db("fk");
    let ws: String = conn
        .query_row("SELECT workspace_id FROM Workspace", [], |r| r.get(0))
        .unwrap();
    let now = 1_700_000_000_000i64;
    // KnowledgeBlock → 未知 Document
    assert!(conn
        .execute(
            "INSERT INTO KnowledgeBlock (block_id, document_id, kind, title, heading_level, \
             heading_path_json, ordinal, start_offset, body_start_offset, end_offset, \
             source_hash, body_hash, content_version, status, created_at, updated_at, \
             content_modified_at, last_seen_at) \
             VALUES ('00000000-0000-4000-8000-000000000001', 'no-such-doc', 'SECTION', NULL, 2, \
             '[]', 0, 0, 1, 2, ?1, ?1, 1, 'ACTIVE', ?2, ?2, ?2, ?2)",
            rusqlite::params![h64("x"), now],
        )
        .is_err());
    // Settings → 未知 Workspace
    assert!(conn
        .execute(
            "INSERT INTO Settings (workspace_id, key, value_json, created_at, updated_at) \
             VALUES ('no-such-ws', 'k', '\"v\"', ?1, ?1)",
            rusqlite::params![now],
        )
        .is_err());
    let _ = ws;
}

#[test]
fn m4_check_constraints_reject_bad_rows() {
    let conn = temp_db("check");
    let now = 1_700_000_000_000i64;
    conn.execute(
        "INSERT INTO Document (document_id, workspace_id, relative_path, path_key, status, \
         index_status, line_ending, has_bom, observed_hash, content_hash, index_revision, \
         diagnostics_json, created_at, updated_at) \
         SELECT '00000000-0000-4000-8000-0000000000d1', workspace_id, 'a.md', 'a.md', \
         'PRESENT', 'READY', 'LF', 0, ?1, ?1, 1, '[]', ?2, ?2 \
         FROM Workspace WHERE singleton = 1",
        rusqlite::params![h64("doc"), now],
    )
    .unwrap();
    let doc_id: String = conn
        .query_row("SELECT document_id FROM Document", [], |r| r.get(0))
        .unwrap();

    // 非法 status
    assert!(conn
        .execute(
            "INSERT INTO KnowledgeBlock (block_id, document_id, kind, heading_level, \
             heading_path_json, ordinal, start_offset, body_start_offset, end_offset, \
             source_hash, body_hash, content_version, status, created_at, updated_at, \
             content_modified_at, last_seen_at) \
             VALUES ('00000000-0000-4000-8000-0000000000a1', ?1, 'SECTION', 2, '[]', 0, 0, 1, \
             2, ?2, ?2, 1, 'BAD_STATUS', ?3, ?3, ?3, ?3)",
            rusqlite::params![doc_id, h64("x"), now],
        )
        .is_err());
    // heading_level 7
    assert!(conn
        .execute(
            "INSERT INTO KnowledgeBlock (block_id, document_id, kind, heading_level, \
             heading_path_json, ordinal, start_offset, body_start_offset, end_offset, \
             source_hash, body_hash, content_version, status, created_at, updated_at, \
             content_modified_at, last_seen_at) \
             VALUES ('00000000-0000-4000-8000-0000000000a2', ?1, 'SECTION', 7, '[]', 0, 0, 1, \
             2, ?2, ?2, 1, 'ACTIVE', ?3, ?3, ?3, ?3)",
            rusqlite::params![doc_id, h64("x"), now],
        )
        .is_err());
    // 哈希长度 63
    let bad_hash = {
        let mut h = h64("x");
        h.truncate(63);
        h
    };
    assert!(conn
        .execute(
            "INSERT INTO KnowledgeBlock (block_id, document_id, kind, heading_level, \
             heading_path_json, ordinal, start_offset, body_start_offset, end_offset, \
             source_hash, body_hash, content_version, status, created_at, updated_at, \
             content_modified_at, last_seen_at) \
             VALUES ('00000000-0000-4000-8000-0000000000a3', ?1, 'SECTION', 2, '[]', 0, 0, 1, \
             2, ?2, ?2, 1, 'ACTIVE', ?3, ?3, ?3, ?3)",
            rusqlite::params![doc_id, bad_hash, now],
        )
        .is_err());
    // 合法块 + ReviewState：needs_recheck=1 与 change_due_at NULL 组合禁止
    conn.execute(
        "INSERT INTO KnowledgeBlock (block_id, document_id, kind, heading_level, \
         heading_path_json, ordinal, start_offset, body_start_offset, end_offset, \
         source_hash, body_hash, content_version, status, created_at, updated_at, \
         content_modified_at, last_seen_at) \
         VALUES ('00000000-0000-4000-8000-0000000000b1', ?1, 'SECTION', 2, '[]', 0, 0, 1, \
         2, ?2, ?2, 1, 'ACTIVE', ?3, ?3, ?3, ?3)",
        rusqlite::params![doc_id, h64("x"), now],
    )
    .unwrap();
    assert!(conn
        .execute(
            "INSERT INTO ReviewState (block_id, phase, algorithm_id, algorithm_version, \
             state_schema_version, config_json, state_json, scheduled_due_at, \
             needs_recheck, created_at, updated_at) \
             VALUES ('00000000-0000-4000-8000-0000000000b1', 'NEW', 'fsrs', 'v', 1, '{}', '{}', \
             ?1, 1, ?2, ?2)",
            rusqlite::params![now, now],
        )
        .is_err());
    // 活文档同 path_key 唯一（部分索引）
    assert!(conn
        .execute(
            "INSERT INTO Document (document_id, workspace_id, relative_path, path_key, status, \
             index_status, line_ending, has_bom, index_revision, diagnostics_json, \
             created_at, updated_at) \
             SELECT '00000000-0000-4000-8000-0000000000c1', workspace_id, 'A.md', 'a.md', \
             'PRESENT', 'READY', 'LF', 0, 1, '[]', ?1, ?1 FROM Workspace WHERE singleton = 1",
            rusqlite::params![now],
        )
        .is_err());
    // DELETED 行不占 path_key
    conn.execute(
        "UPDATE Document SET status = 'DELETED' WHERE document_id = ?1",
        rusqlite::params![doc_id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO Document (document_id, workspace_id, relative_path, path_key, status, \
         index_status, line_ending, has_bom, index_revision, diagnostics_json, \
         created_at, updated_at) \
         SELECT '00000000-0000-4000-8000-0000000000c2', workspace_id, 'a.md', 'a.md', \
         'PRESENT', 'READY', 'LF', 0, 1, '[]', ?1, ?1 FROM Workspace WHERE singleton = 1",
        rusqlite::params![now],
    )
    .unwrap();
}

#[test]
fn m4_generated_next_review_at_min_semantics() {
    let conn = temp_db("gen");
    let bid = new_id();
    let path = "g.md";
    let mut conn = conn;
    commit_on(
        &mut conn,
        &batch(
            vec![header(path, 0, &h64("g"))],
            vec![create(&bid, path, 0, &h64("body"))],
            vec![path.to_string()],
        ),
    )
    .unwrap();

    let (sched, due, next): (i64, Option<i64>, i64) = conn
        .query_row(
            "SELECT scheduled_due_at, change_due_at, next_review_at FROM ReviewState",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(due, None);
    assert_eq!(next, sched, "change_due_at NULL → next = scheduled");
    // 首提 = created_at + 24h（§10.2）
    let created: i64 = conn
        .query_row("SELECT created_at FROM ReviewState", [], |r| r.get(0))
        .unwrap();
    assert_eq!(sched - created, fsrs::FIRST_DUE_OFFSET_MS);
    // 原生状态 due 与 scheduled_due_at 一致（§10.2 L394）
    let state_json: String = conn
        .query_row("SELECT state_json FROM ReviewState", [], |r| r.get(0))
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(&state_json).unwrap();
    let native_due = fsrs::parse_iso8601_ms(v["due"].as_str().unwrap()).unwrap();
    assert_eq!(native_due, sched);

    // change_due_at 更早 → next = min（生成列 STORED 自动重算；CHECK 要求与 recheck 配对）
    conn.execute(
        "UPDATE ReviewState SET needs_recheck = 1, change_due_at = ?1 WHERE block_id = ?2",
        rusqlite::params![sched - 1000, bid],
    )
    .unwrap();
    let next2: i64 = conn
        .query_row("SELECT next_review_at FROM ReviewState", [], |r| r.get(0))
        .unwrap();
    assert_eq!(next2, sched - 1000);
}

// ---------------------------------------------------------------------------
// 验收②：同一索引输入幂等 / CAS
// ---------------------------------------------------------------------------

#[test]
fn m4_commit_create_then_replay_is_noop() {
    let mut conn = temp_db("idem-create");
    let bid = new_id();
    let path = "a.md";
    let req = batch(
        vec![header(path, 0, &h64("a"))],
        vec![create(&bid, path, 0, &h64("body"))],
        vec![path.to_string()],
    );
    let r1 = commit_on(&mut conn, &req).unwrap();
    assert!(r1.blocks[0].applied);
    assert_eq!(r1.documents[0].index_revision, 1);

    let (updated_at, last_seen): (i64, i64) = conn
        .query_row("SELECT updated_at, last_seen_at FROM Document", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();

    // 线级重放：同批同 expected（注册表已刷新到 rev=1）
    let mut replay = batch(
        vec![header(path, 1, &h64("a"))],
        vec![create(&bid, path, 0, &h64("body"))],
        vec![path.to_string()],
    );
    replay.block_results[0].content_version_delta = 0; // 引擎重算后 delta 归零
    let r2 = commit_on(&mut conn, &replay).unwrap();
    assert!(!r2.blocks[0].applied, "重放应幂等跳过");
    assert_eq!(r2.documents[0].index_revision, 1, "revision 不增加");

    // 零写入：updated_at/last_seen_at 字节不变（§12.5 L766）
    let (updated_at2, last_seen2): (i64, i64) = conn
        .query_row("SELECT updated_at, last_seen_at FROM Document", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!((updated_at, last_seen), (updated_at2, last_seen2));

    // 引擎重算路径（真实场景）：注册表读回 → NOOP 动作
    let snap = registry_snapshot_on(&conn, &Default::default()).unwrap();
    assert_eq!(snap.blocks.len(), 1);
    assert_eq!(snap.blocks[0].block_id, bid);
    assert_eq!(snap.blocks[0].status, "ACTIVE");
    assert!(!snap.blocks[0].has_rating);
    assert_eq!(snap.blocks[0].participation, "ENABLED");
    assert_eq!(snap.documents[0].index_revision, 1);
}

#[test]
fn m4_commit_update_meta_and_content_replay() {
    let mut conn = temp_db("idem-update");
    let bid = new_id();
    let path = "a.md";
    commit_on(
        &mut conn,
        &batch(
            vec![header(path, 0, &h64("a"))],
            vec![create(&bid, path, 0, &h64("body1"))],
            vec![path.to_string()],
        ),
    )
    .unwrap();

    // 位置变化（同文件移动）：hash 不变也 bump revision（META_ONLY 是位置/元数据变化）
    let mut moved = next_dto(&bid, path, 1, &h64("body1"));
    moved.ordinal = 1;
    moved.title = Some("改名小节".into());
    let r = commit_on(
        &mut conn,
        &batch(
            vec![header(path, 1, &h64("a"))],
            vec![BlockProposalDto {
                action: "UPDATE_META".into(),
                status: "ACTIVE".into(),
                next: Some(moved),
                content_version_delta: 0,
                ..create(&bid, path, 0, &h64("body1"))
            }],
            vec![path.to_string()],
        ),
    )
    .unwrap();
    assert!(r.blocks[0].applied);
    assert_eq!(r.documents[0].index_revision, 2);

    let (updated_at, cv): (i64, i64) = conn
        .query_row(
            "SELECT d.updated_at, b.content_version FROM Document d JOIN KnowledgeBlock b \
             ON b.document_id = d.document_id",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    // UPDATE_META 原样重放 → 零写入
    let mut moved2 = next_dto(&bid, path, 1, &h64("body1"));
    moved2.ordinal = 1;
    moved2.title = Some("改名小节".into());
    let r2 = commit_on(
        &mut conn,
        &batch(
            vec![header(path, 2, &h64("a"))],
            vec![BlockProposalDto {
                action: "UPDATE_META".into(),
                status: "ACTIVE".into(),
                next: Some(moved2),
                content_version_delta: 0,
                ..create(&bid, path, 0, &h64("body1"))
            }],
            vec![path.to_string()],
        ),
    )
    .unwrap();
    assert!(!r2.blocks[0].applied);
    assert_eq!(r2.documents[0].index_revision, 2);
    let (updated_at2, cv2): (i64, i64) = conn
        .query_row(
            "SELECT d.updated_at, b.content_version FROM Document d JOIN KnowledgeBlock b \
             ON b.document_id = d.document_id",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(updated_at, updated_at2, "重放不得触碰 updated_at");
    assert_eq!(cv, cv2, "UPDATE_META 不增加 content_version");

    // 内容变化（未首评 ENABLED）：content_version+1、不设 recheck（§10.3 行3）
    let mut content2 = next_dto(&bid, path, 1, &h64("body2"));
    content2.content_version = 2;
    let r3 = commit_on(
        &mut conn,
        &batch(
            vec![header(path, 2, &h64("a2"))],
            vec![BlockProposalDto {
                action: "UPDATE_CONTENT".into(),
                status: "ACTIVE".into(),
                next: Some(content2),
                content_version_delta: 1,
                ..create(&bid, path, 0, &h64("body1"))
            }],
            vec![path.to_string()],
        ),
    )
    .unwrap();
    assert!(r3.blocks[0].applied);
    let (cv3, recheck, change_due): (i64, i64, Option<i64>) = conn
        .query_row(
            "SELECT b.content_version, r.needs_recheck, r.change_due_at \
             FROM KnowledgeBlock b JOIN ReviewState r ON r.block_id = b.block_id",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(cv3, 2);
    assert_eq!(recheck, 0, "未首评段不设 needs_recheck");
    assert!(change_due.is_none());

    // 已首评后再改内容：recheck 置位、change_due_at = min(现值, now+24h)、state_revision+1
    conn.execute(
        "UPDATE ReviewState SET first_review_at = 1 WHERE block_id = ?1",
        rusqlite::params![bid],
    )
    .unwrap();
    let before_rev: i64 = conn
        .query_row("SELECT state_revision FROM ReviewState", [], |r| r.get(0))
        .unwrap();
    let before = recallmd_lib::persistence::store::now_ms();
    let mut content3 = next_dto(&bid, path, 1, &h64("body3"));
    content3.content_version = 3;
    let r4 = commit_on(
        &mut conn,
        &batch(
            vec![header(path, 3, &h64("a3"))],
            vec![BlockProposalDto {
                action: "UPDATE_CONTENT".into(),
                status: "ACTIVE".into(),
                next: Some(content3.clone()),
                content_version_delta: 1,
                needs_recheck: true,
                ..create(&bid, path, 0, &h64("body1"))
            }],
            vec![path.to_string()],
        ),
    )
    .unwrap();
    assert!(r4.blocks[0].applied);
    assert!(r4.blocks[0].needs_recheck);
    let after = recallmd_lib::persistence::store::now_ms();
    let (recheck4, due4, rev4, cv4): (i64, i64, i64, i64) = conn
        .query_row(
            "SELECT needs_recheck, change_due_at, state_revision, \
             (SELECT content_version FROM KnowledgeBlock) \
             FROM ReviewState",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(recheck4, 1);
    assert!(due4 >= before + fsrs::FIRST_DUE_OFFSET_MS);
    assert!(due4 <= after + fsrs::FIRST_DUE_OFFSET_MS);
    assert_eq!(rev4, before_rev + 1, "recheck 写入递增 state_revision");
    assert_eq!(cv4, 3);

    // 已落地 UPDATE_CONTENT 的线级重放 → 幂等跳过
    let r5 = commit_on(
        &mut conn,
        &batch(
            vec![header(path, 4, &h64("a3"))],
            vec![BlockProposalDto {
                action: "UPDATE_CONTENT".into(),
                status: "ACTIVE".into(),
                next: Some(content3.clone()),
                content_version_delta: 1,
                needs_recheck: true,
                ..create(&bid, path, 0, &h64("body1"))
            }],
            vec![path.to_string()],
        ),
    )
    .unwrap();
    assert!(!r5.blocks[0].applied, "已落地内容变更重放 = 幂等");
    assert_eq!(r5.documents[0].index_revision, 4);
}

#[test]
fn m4_stale_index_cas_rejected() {
    let mut conn = temp_db("cas");
    let bid = new_id();
    let path = "a.md";
    commit_on(
        &mut conn,
        &batch(
            vec![header(path, 0, &h64("a"))],
            vec![create(&bid, path, 0, &h64("body"))],
            vec![path.to_string()],
        ),
    )
    .unwrap();

    // 期望 revision 落后
    let err = commit_on(
        &mut conn,
        &batch(
            vec![header(path, 0, &h64("a2"))],
            vec![],
            vec![path.to_string()],
        ),
    )
    .unwrap_err();
    assert_eq!(err.code, "STALE_INDEX");

    // 未知路径但期望非 0
    let err2 = commit_on(
        &mut conn,
        &batch(
            vec![header("never.md", 3, &h64("n"))],
            vec![],
            vec!["never.md".to_string()],
        ),
    )
    .unwrap_err();
    assert_eq!(err2.code, "STALE_INDEX");

    // 无变化、无提案、CAS 正确 → 文档级 NOOP
    let r = commit_on(
        &mut conn,
        &batch(vec![header(path, 1, &h64("a"))], vec![], vec![path.to_string()]),
    )
    .unwrap();
    assert_eq!(r.documents[0].index_revision, 1);
}

// ---------------------------------------------------------------------------
// 验收③：跨文件移动不创建第二份状态
// ---------------------------------------------------------------------------

#[test]
fn m4_block_cross_file_move_single_state() {
    let mut conn = temp_db("xfile");
    let bid = new_id();
    commit_on(
        &mut conn,
        &batch(
            vec![header("a.md", 0, &h64("a1"))],
            vec![create(&bid, "a.md", 0, &h64("body"))],
            vec!["a.md".to_string()],
        ),
    )
    .unwrap();

    // 同批两文档头：块从 a.md 移到 b.md（正文相同，仅位置/文件变）
    let mut in_b = next_dto(&bid, "b.md", 3, &h64("body"));
    in_b.ordinal = 3;
    let r = commit_on(
        &mut conn,
        &batch(
            vec![header("a.md", 1, &h64("a2")), header("b.md", 0, &h64("b1"))],
            vec![BlockProposalDto {
                action: "UPDATE_META".into(),
                status: "ACTIVE".into(),
                next: Some(in_b),
                prev: Some(PrevRefDto {
                    relative_path: "a.md".into(),
                    status: "ACTIVE".into(),
                }),
                content_version_delta: 0,
                ..create(&bid, "a.md", 0, &h64("body"))
            }],
            vec!["a.md".to_string(), "b.md".to_string()],
        ),
    )
    .unwrap();
    assert!(r.blocks[0].applied);

    // 单一状态：一行 Block、一行 ReviewState、绑定到 b.md 的 document
    assert_eq!(count(&conn, "SELECT count(*) FROM KnowledgeBlock"), 1);
    assert_eq!(count(&conn, "SELECT count(*) FROM ReviewState"), 1);
    let (doc_path, cv): (String, i64) = conn
        .query_row(
            "SELECT d.relative_path, b.content_version FROM KnowledgeBlock b \
             JOIN Document d ON d.document_id = b.document_id",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(doc_path, "b.md");
    assert_eq!(cv, 1, "正文未变，content_version 不动");
    // 两个文档都在（a.md 索引到无块状态）
    assert_eq!(count(&conn, "SELECT count(*) FROM Document"), 2);
}

#[test]
fn m4_mark_missing_and_conflict_transitions() {
    let mut conn = temp_db("missing");
    let bid = new_id();
    let path = "a.md";
    commit_on(
        &mut conn,
        &batch(
            vec![header(path, 0, &h64("a"))],
            vec![create(&bid, path, 0, &h64("body"))],
            vec![path.to_string()],
        ),
    )
    .unwrap();

    let missing = |delta: i64| BlockProposalDto {
        action: if delta == 0 { "KEEP_MISSING" } else { "MARK_MISSING" }.into(),
        status: "MISSING".into(),
        next: None,
        prev: Some(PrevRefDto {
            relative_path: path.into(),
            status: "ACTIVE".into(),
        }),
        content_version_delta: 0,
        ..create(&bid, path, 0, &h64("body"))
    };

    // prev 不在快照集合 → 拒绝（未扫描不能断定消失）
    let err = commit_on(
        &mut conn,
        &batch(vec![header(path, 1, &h64("a"))], vec![missing(1)], vec![]),
    )
    .unwrap_err();
    assert_eq!(err.code, "INDEX_FAILED");

    // 正常标缺
    let r = commit_on(
        &mut conn,
        &batch(
            vec![header(path, 1, &h64("a"))],
            vec![missing(1)],
            vec![path.to_string()],
        ),
    )
    .unwrap();
    assert!(r.blocks[0].applied);
    // 重复 KEEP_MISSING → 幂等
    let r2 = commit_on(
        &mut conn,
        &batch(
            vec![header(path, 2, &h64("a"))],
            vec![missing(0)],
            vec![path.to_string()],
        ),
    )
    .unwrap();
    assert!(!r2.blocks[0].applied);

    // 复现：RESTORE（正文不变 → delta 0）
    let r3 = commit_on(
        &mut conn,
        &batch(
            vec![header(path, 2, &h64("a"))],
            vec![BlockProposalDto {
                action: "RESTORE".into(),
                status: "ACTIVE".into(),
                next: Some(next_dto(&bid, path, 0, &h64("body"))),
                prev: Some(PrevRefDto {
                    relative_path: path.into(),
                    status: "MISSING".into(),
                }),
                content_version_delta: 0,
                ..create(&bid, path, 0, &h64("body"))
            }],
            vec![path.to_string()],
        ),
    )
    .unwrap();
    assert!(r3.blocks[0].applied);
    let (status, sched_changed): (String, i64) = conn
        .query_row(
            "SELECT b.status, r.scheduled_due_at FROM KnowledgeBlock b \
             JOIN ReviewState r ON r.block_id = b.block_id",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "ACTIVE");
    assert!(sched_changed > 0, "RESTORE 不动调度（§9.4 L358）");

    // MARK_CONFLICT 需要 ≥2 处出现证据
    let conflict_bad = BlockProposalDto {
        action: "MARK_CONFLICT".into(),
        status: "ID_CONFLICT".into(),
        next: None,
        prev: Some(PrevRefDto {
            relative_path: path.into(),
            status: "ACTIVE".into(),
        }),
        content_version_delta: 0,
        occurrences: vec![],
        ..create(&bid, path, 0, &h64("body"))
    };
    let err = commit_on(
        &mut conn,
        &batch(
            vec![header(path, 3, &h64("a"))],
            vec![conflict_bad],
            vec![path.to_string()],
        ),
    )
    .unwrap_err();
    assert_eq!(err.code, "INDEX_FAILED");
}

// ---------------------------------------------------------------------------
// 事务原子性：中途失败整批回滚
// ---------------------------------------------------------------------------

#[test]
fn m4_tx_rollback_no_partial_state() {
    let mut conn = temp_db("rollback");
    let bid = new_id();
    let path = "a.md";
    // 同批两份 CREATE 同 block_id：第二份 INSERT 触发 PK 冲突（Phase 3，验证回滚）
    let err = commit_on(
        &mut conn,
        &batch(
            vec![header(path, 0, &h64("a"))],
            vec![
                create(&bid, path, 0, &h64("body")),
                create(&bid, path, 1, &h64("body2")),
            ],
            vec![path.to_string()],
        ),
    )
    .unwrap_err();
    assert_eq!(err.code, "INDEX_FAILED");
    assert_eq!(count(&conn, "SELECT count(*) FROM Document"), 0, "文档回滚");
    assert_eq!(count(&conn, "SELECT count(*) FROM KnowledgeBlock"), 0);
    assert_eq!(count(&conn, "SELECT count(*) FROM ReviewState"), 0);
}

#[test]
fn m4_recovery_mode_pauses_new_blocks() {
    let mut conn = temp_db("rebuild-mode");
    recallmd_lib::persistence::store::query::settings_set_string(
        &conn,
        "recovery.mode",
        "REBUILT_NO_HISTORY",
        1_700_000_000_000,
    )
    .unwrap();
    let bid = new_id();
    let path = "a.md";
    commit_on(
        &mut conn,
        &batch(
            vec![header(path, 0, &h64("a"))],
            vec![create(&bid, path, 0, &h64("body"))],
            vec![path.to_string()],
        ),
    )
    .unwrap();
    let (participation, phase): (String, String) = conn
        .query_row(
            "SELECT participation, phase FROM ReviewState",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(participation, "PAUSED", "历史丢失重建 → PAUSED（§12.6 L798）");
    assert_eq!(phase, "NEW");
}

// ---------------------------------------------------------------------------
// M4：按路径保存队列（document.rs M1 全局队列升级）
// ---------------------------------------------------------------------------

#[test]
fn m4_per_path_save_queue() {
    use recallmd_lib::persistence::document::{read_document, save_document, SaveDocumentParams};

    fn save_txt(
        root: &str,
        rel: &str,
        text: &str,
        expected: &str,
    ) -> recallmd_lib::persistence::error::HostResult<
        recallmd_lib::persistence::document::SaveDocumentResult,
    > {
        save_document(
            root,
            rel,
            SaveDocumentParams {
                text: text.to_string(),
                eol: "LF".to_string(),
                add_bom: false,
                expected_hash: expected.to_string(),
            },
        )
    }

    let root = std::env::temp_dir().join(format!(
        "recallmd-m4-saveq-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(root.join(".recallmd")).unwrap();
    std::fs::write(root.join("a.md"), "A1\n").unwrap();
    std::fs::write(root.join("b.md"), "B1\n").unwrap();
    let root_str = root.to_str().unwrap().to_string();

    let ha = read_document(&root_str, "a.md").unwrap().raw_byte_hash;
    let hb = read_document(&root_str, "b.md").unwrap().raw_byte_hash;

    // 不同路径并发保存：两个线程互不阻塞，均成功
    let ra = {
        let root_str = root_str.clone();
        let ha = ha.clone();
        std::thread::spawn(move || save_txt(&root_str, "a.md", "A2\n", &ha))
    };
    let rb = {
        let root_str = root_str.clone();
        std::thread::spawn(move || save_txt(&root_str, "b.md", "B2\n", &hb))
    };
    ra.join().unwrap().expect("a.md 并发保存成功");
    rb.join().unwrap().expect("b.md 并发保存成功");

    // 同路径串行：同 expected 并发两次，恰好一次成功、一次 FILE_CONFLICT
    let ha2 = read_document(&root_str, "a.md").unwrap().raw_byte_hash;
    let t1 = {
        let root_str = root_str.clone();
        let ha2 = ha2.clone();
        std::thread::spawn(move || save_txt(&root_str, "a.md", "A3\n", &ha2))
    };
    let t2 = {
        let root_str = root_str.clone();
        std::thread::spawn(move || save_txt(&root_str, "a.md", "A4\n", &ha2))
    };
    let r1 = t1.join().unwrap();
    let r2 = t2.join().unwrap();
    let successes = [&r1, &r2].iter().filter(|r| r.is_ok()).count();
    let conflicts = [&r1, &r2]
        .iter()
        .filter(|r| matches!(r, Err(e) if e.code == "FILE_CONFLICT"))
        .count();
    assert_eq!(successes, 1, "同路径两次并发保存恰一次成功");
    assert_eq!(conflicts, 1, "另一次须为 FILE_CONFLICT（后到者 CAS 失败）");

    let _ = std::fs::remove_dir_all(&root);
}
