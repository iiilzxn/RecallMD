//! M7 外部移动采纳与定期核对测试（§13.5 / §13.3 L885）。
//! 采纳优先级：② file_identity 一对一 → ③ 缺席旧路径 + 唯一 hash 相等；
//! 多候选/批内路径不采纳（禁止猜配）。

use recallmd_lib::persistence::store::commit::commit_on;
use recallmd_lib::persistence::store::dto::{
    BlockNextDto, BlockProposalDto, CommitIndexBatchRequest, DocumentHeaderDto, PrevRefDto,
};
use recallmd_lib::persistence::store::open_test_db;
use rusqlite::Connection;

fn temp_db(name: &str) -> Connection {
    let dir = std::env::temp_dir().join(format!(
        "recallmd-m7a-{}-{}",
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

fn create(block_id: &str, path: &str, body_hash: &str) -> BlockProposalDto {
    BlockProposalDto {
        block_id: block_id.into(),
        action: "CREATE".into(),
        status: "ACTIVE".into(),
        relative_path: Some(path.into()),
        next: Some(next_dto(block_id, path, 0, body_hash)),
        change_class: None,
        content_version_delta: 1,
        needs_recheck: false,
        prev: None,
        reason: "首次登记".into(),
        occurrences: vec![],
    }
}

fn relocate(block_id: &str, from: &str, to: &str, body_hash: &str) -> BlockProposalDto {
    BlockProposalDto {
        block_id: block_id.into(),
        action: "UPDATE_META".into(),
        status: "ACTIVE".into(),
        relative_path: Some(to.into()),
        next: Some(next_dto(block_id, to, 0, body_hash)),
        change_class: None,
        content_version_delta: 0,
        needs_recheck: false,
        prev: Some(PrevRefDto {
            relative_path: from.into(),
            status: "ACTIVE".into(),
        }),
        reason: "外部移动".into(),
        occurrences: vec![],
    }
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn doc_id_of(conn: &Connection, path: &str) -> String {
    conn.query_row(
        "SELECT document_id FROM Document WHERE relative_path = ?1",
        rusqlite::params![path],
        |r| r.get(0),
    )
    .unwrap()
}

// ---------------------------------------------------------------------------
// ③ hash 采纳：旧路径确认缺席 + 新路径字节唯一相等 → document_id 保留
// ---------------------------------------------------------------------------

#[test]
fn m7_adopt_by_hash_on_external_move() {
    let mut conn = temp_db("hash-adopt");
    let bid = new_id();
    let body = h64("body");
    let a_hash = h64("doc-a");
    commit_on(
        &mut conn,
        &CommitIndexBatchRequest {
            documents: vec![header("a.md", 0, &a_hash)],
            block_results: vec![create(&bid, "a.md", &body)],
            snapshot_paths: vec!["a.md".into()],
        },
    )
    .unwrap();
    let original_doc_id = doc_id_of(&conn, "a.md");

    // 外部把 a.md 移到 b.md：本轮扫描 a.md（缺席，无 header）+ b.md（同一字节）
    let r = commit_on(
        &mut conn,
        &CommitIndexBatchRequest {
            documents: vec![header("b.md", 0, &a_hash)],
            block_results: vec![relocate(&bid, "a.md", "b.md", &body)],
            snapshot_paths: vec!["a.md".into(), "b.md".into()],
        },
    )
    .unwrap();
    // 采纳后块的全部落库字段（document_id/offsets/正文哈希）都没变 → 幂等 NOOP
    assert!(!r.blocks[0].applied);
    // 单一 Document：旧行迁至 b.md，document_id 保留（学习历史与 file_identity 不丢）
    assert_eq!(count(&conn, "SELECT count(*) FROM Document"), 1);
    assert_eq!(doc_id_of(&conn, "b.md"), original_doc_id);
    // 块与 ReviewState 单行绑定到（被采纳的）同一文档
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM KnowledgeBlock b JOIN Document d ON d.document_id = b.document_id \
             WHERE d.relative_path = 'b.md'"
        ),
        1
    );
    assert_eq!(count(&conn, "SELECT count(*) FROM ReviewState"), 1);
    // revision 递进而非新建（旧行 revision 1 → 2）
    let rev: i64 = conn
        .query_row(
            "SELECT index_revision FROM Document WHERE relative_path = 'b.md'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rev, 2);
}

// ---------------------------------------------------------------------------
// 不采纳：旧路径未确认缺席（不在 snapshot）→ 新文档正常新建
// ---------------------------------------------------------------------------

#[test]
fn m7_no_adopt_when_old_path_not_scanned() {
    let mut conn = temp_db("no-adopt");
    let bid = new_id();
    let body = h64("body");
    let a_hash = h64("doc-a");
    commit_on(
        &mut conn,
        &CommitIndexBatchRequest {
            documents: vec![header("a.md", 0, &a_hash)],
            block_results: vec![create(&bid, "a.md", &body)],
            snapshot_paths: vec!["a.md".into()],
        },
    )
    .unwrap();

    // 只扫 b.md（a.md 未核对 = 不能断言它消失）→ 不得猜配
    commit_on(
        &mut conn,
        &CommitIndexBatchRequest {
            documents: vec![header("b.md", 0, &a_hash)],
            block_results: vec![relocate(&bid, "a.md", "b.md", &body)],
            snapshot_paths: vec!["b.md".into()],
        },
    )
    .unwrap();
    assert_eq!(count(&conn, "SELECT count(*) FROM Document"), 2, "不采纳：两个文档并存");
}

// ---------------------------------------------------------------------------
// 不采纳：两个缺席旧路径同 hash（歧义）→ 新建（§13.5 禁止对相同文件猜配）
// ---------------------------------------------------------------------------

#[test]
fn m7_no_adopt_when_ambiguous_hash() {
    let mut conn = temp_db("ambig");
    let b1 = new_id();
    let b2 = new_id();
    let body = h64("body");
    let same_hash = h64("same");
    // 两个文档内容字节完全相同（复制场景）
    commit_on(
        &mut conn,
        &CommitIndexBatchRequest {
            documents: vec![header("a.md", 0, &same_hash), header("b.md", 0, &same_hash)],
            block_results: vec![create(&b1, "a.md", &body), create(&b2, "b.md", &body)],
            snapshot_paths: vec!["a.md".into(), "b.md".into()],
        },
    )
    .unwrap();
    // a/b 都缺席、c.md 出现同字节 → 两个候选，不采纳（只送文档头，聚焦采纳语义）
    commit_on(
        &mut conn,
        &CommitIndexBatchRequest {
            documents: vec![header("c.md", 0, &same_hash)],
            block_results: vec![],
            snapshot_paths: vec!["a.md".into(), "b.md".into(), "c.md".into()],
        },
    )
    .unwrap();
    assert_eq!(count(&conn, "SELECT count(*) FROM Document"), 3, "歧义不采纳");
}

// ---------------------------------------------------------------------------
// ② file_identity 采纳：身份一对一（正文同时改写也保留 document_id）
// ---------------------------------------------------------------------------

#[test]
fn m7_adopt_by_file_identity_even_with_rewrite() {
    let mut conn = temp_db("identity-adopt");
    let bid = new_id();
    let body = h64("body");
    let mut h = header("a.md", 0, &h64("doc-a"));
    h.file_identity = Some("VOL-1234567890abcdef".into());
    commit_on(
        &mut conn,
        &CommitIndexBatchRequest {
            documents: vec![h],
            block_results: vec![create(&bid, "a.md", &body)],
            snapshot_paths: vec!["a.md".into()],
        },
    )
    .unwrap();
    let original_doc_id = doc_id_of(&conn, "a.md");

    // 移动并改写（hash 已变）：身份一对一仍采纳（§13.5 L907 注释仍在即可恢复）
    let mut h2 = header("b.md", 0, &h64("doc-b-rewritten"));
    h2.file_identity = Some("VOL-1234567890abcdef".into());
    let mut rn = next_dto(&bid, "b.md", 0, &h64("body2"));
    rn.body_hash = h64("body2");
    rn.content_version = 2;
    let r = commit_on(
        &mut conn,
        &CommitIndexBatchRequest {
            documents: vec![h2],
            block_results: vec![BlockProposalDto {
                block_id: bid.clone(),
                action: "UPDATE_CONTENT".into(),
                status: "ACTIVE".into(),
                relative_path: Some("b.md".into()),
                next: Some(rn),
                change_class: Some("CONTENT_NEW".into()),
                content_version_delta: 1,
                needs_recheck: false,
                prev: Some(PrevRefDto {
                    relative_path: "a.md".into(),
                    status: "ACTIVE".into(),
                }),
                reason: "移动并改写".into(),
                occurrences: vec![],
            }],
            snapshot_paths: vec!["a.md".into(), "b.md".into()],
        },
    )
    .unwrap();
    assert!(r.blocks[0].applied);
    assert_eq!(count(&conn, "SELECT count(*) FROM Document"), 1);
    assert_eq!(doc_id_of(&conn, "b.md"), original_doc_id, "身份采纳保留 document_id");
}

// ---------------------------------------------------------------------------
// 副本场景：旧路径仍在批内（有 header）→ 不采纳（新文件是新知识单元）
// ---------------------------------------------------------------------------

#[test]
fn m7_no_adopt_for_copy_when_source_still_present() {
    let mut conn = temp_db("copy");
    let b1 = new_id();
    let b2 = new_id();
    let same_hash = h64("same");
    let body = h64("body");
    commit_on(
        &mut conn,
        &CommitIndexBatchRequest {
            documents: vec![header("a.md", 0, &same_hash)],
            block_results: vec![create(&b1, "a.md", &body)],
            snapshot_paths: vec!["a.md".into()],
        },
    )
    .unwrap();
    let original = doc_id_of(&conn, "a.md");

    // 复制 a.md → b.md：两者同轮扫描都在（a.md 有 header）→ b.md 新建文档
    commit_on(
        &mut conn,
        &CommitIndexBatchRequest {
            documents: vec![header("a.md", 1, &same_hash), header("b.md", 0, &same_hash)],
            block_results: vec![create(&b2, "b.md", &body)],
            snapshot_paths: vec!["a.md".into(), "b.md".into()],
        },
    )
    .unwrap();
    assert_eq!(count(&conn, "SELECT count(*) FROM Document"), 2);
    assert_ne!(doc_id_of(&conn, "b.md"), original);
}

// ---------------------------------------------------------------------------
// 纯删除批（M7 Watcher 单独同步被删文件）：无文档头 + MARK_MISSING 提案合法
// ---------------------------------------------------------------------------

#[test]
fn m7_pure_deletion_batch_marks_missing() {
    let mut conn = temp_db("pure-del");
    let bid = new_id();
    let body = h64("body");
    commit_on(
        &mut conn,
        &CommitIndexBatchRequest {
            documents: vec![header("a.md", 0, &h64("doc-a"))],
            block_results: vec![create(&bid, "a.md", &body)],
            snapshot_paths: vec!["a.md".into()],
        },
    )
    .unwrap();
    // Watcher 场景：目标文件消失 → documents 空、只有 MARK_MISSING、快照含该路径
    let r = commit_on(
        &mut conn,
        &CommitIndexBatchRequest {
            documents: vec![],
            block_results: vec![BlockProposalDto {
                block_id: bid.clone(),
                action: "MARK_MISSING".into(),
                status: "MISSING".into(),
                relative_path: Some("a.md".into()),
                next: None,
                change_class: None,
                content_version_delta: 0,
                needs_recheck: false,
                prev: Some(PrevRefDto {
                    relative_path: "a.md".into(),
                    status: "ACTIVE".into(),
                }),
                reason: "文件已删除".into(),
                occurrences: vec![],
            }],
            snapshot_paths: vec!["a.md".into()],
        },
    )
    .unwrap();
    assert!(r.blocks[0].applied);
    assert_eq!(
        count(&conn, "SELECT count(*) FROM KnowledgeBlock WHERE status = 'MISSING'"),
        1
    );
    // 全空批仍拒
    let err = commit_on(
        &mut conn,
        &CommitIndexBatchRequest {
            documents: vec![],
            block_results: vec![],
            snapshot_paths: vec![],
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "INDEX_FAILED");
}
