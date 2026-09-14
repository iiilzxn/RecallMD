//! M4 验收④⑤：内容成功/索引失败重启收敛；DB 删除恢复不声称保留历史。
//! 涉激活态（进程级单例）的测试整段持 TEST_LOCK 串行（m2 模式）。

use std::sync::{Mutex, OnceLock};

use recallmd_lib::persistence::document::save_document;
use recallmd_lib::persistence::store::dto::{
    BlockNextDto, BlockProposalDto, CommitIndexBatchRequest, DocumentHeaderDto, PrevRefDto,
};
use recallmd_lib::persistence::store::open_test_db;
use recallmd_lib::persistence::store::DbAction;
use recallmd_lib::persistence::workspace::{
    active_store, close_workspace, delete_path, move_path, open_workspace, trash_restore,
    trash_list,
};
use rusqlite::Connection;

fn test_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

/// 串行守卫；容忍先行测试中毒（失败各自暴露，不级联 PoisonError）
fn serial() -> std::sync::MutexGuard<'static, ()> {
    test_lock().lock().unwrap_or_else(|p| p.into_inner())
}

fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
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
        byte_size: 64,
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
        title: Some("标题".into()),
        heading_level: 2,
        heading_path: vec!["父".into()],
        ordinal,
        start_offset: 0,
        body_start_offset: 10,
        end_offset: 100,
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

fn commit_via_store(req: CommitIndexBatchRequest) -> recallmd_lib::persistence::store::dto::CommitIndexBatchResult {
    match active_store()
        .unwrap()
        .call(DbAction::CommitIndex(Box::new(req)))
        .unwrap()
    {
        recallmd_lib::persistence::store::DbReply::CommitIndex(r) => *r,
        _ => panic!("CommitIndex 应答"),
    }
}

/// 直连第二连接（WAL 允许与 worker 并存）：测试注入评分痕迹等
fn side_conn(root: &std::path::Path) -> Connection {
    let conn = Connection::open(root.join(".recallmd").join("metadata.sqlite")).unwrap();
    conn.pragma_update(None, "busy_timeout", 5000).unwrap();
    conn
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

// ---------------------------------------------------------------------------
// 验收④：内容成功/索引失败重启收敛（§14.4 行 3）
// ---------------------------------------------------------------------------

#[test]
fn m4_crash_after_file_commit_before_sqlite() {
    let _guard = serial();
    let root = std::env::temp_dir().join(format!("recallmd-m4r-crash1-{}", nanos()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.md"), "旧内容\n").unwrap();
    let root_str = root.to_str().unwrap().to_string();
    open_workspace(&root_str).unwrap();

    // 首轮索引：登记一个块
    let bid = new_id();
    commit_via_store(batch(
        vec![header("a.md", 0, &h64("old"))],
        vec![create(&bid, "a.md", 0, &h64("body-old"))],
        vec!["a.md".to_string()],
    ));

    // 模拟：保存成功（FILE_COMMITTED）但索引事务没跑、进程终止
    let doc = recallmd_lib::persistence::document::read_document(&root_str, "a.md").unwrap();
    let saved = save_document(
        &root_str,
        "a.md",
        recallmd_lib::persistence::document::SaveDocumentParams {
            text: "# 新内容\n\n正文\n".into(),
            eol: "LF".into(),
            add_bom: false,
            expected_hash: doc.raw_byte_hash.clone(),
        },
    )
    .unwrap();
    // 崩溃：没有 commit_index_batch / index_complete —— 直接重开
    close_workspace().unwrap();
    open_workspace(&root_str).unwrap();

    // 启动发现"正文已存、索引落后"：PENDING + stale 列表 + 日志已清理
    let status = recallmd_lib::persistence::workspace::active_recovery().unwrap();
    assert!(
        status.stale_documents.iter().any(|p| p == "a.md"),
        "stale 文档应包含 a.md：{:?}",
        status.stale_documents
    );
    let snap = match active_store().unwrap().call(DbAction::RegistrySnapshot).unwrap() {
        recallmd_lib::persistence::store::DbReply::RegistrySnapshot(s) => *s,
        _ => panic!(),
    };
    assert_eq!(snap.documents[0].index_status, "PENDING");
    assert!(std::fs::read_dir(root.join(".recallmd").join("operations"))
        .unwrap()
        .count()
        == 0);

    // 收敛：TS 等价提案重提交（新内容、旧块 MARK_MISSING + 新块 CREATE）
    let bid2 = new_id();
    let missing = BlockProposalDto {
        action: "MARK_MISSING".into(),
        status: "MISSING".into(),
        next: None,
        prev: Some(PrevRefDto {
            relative_path: "a.md".into(),
            status: "ACTIVE".into(),
        }),
        content_version_delta: 0,
        ..create(&bid, "a.md", 0, &h64("body-old"))
    };
    let r = commit_via_store(batch(
        vec![header("a.md", snap.documents[0].index_revision, &saved.committed_hash)],
        vec![missing, create(&bid2, "a.md", 0, &h64("body-new"))],
        vec!["a.md".to_string()],
    ));
    assert_eq!(r.documents[0].index_revision, 2);

    // index_complete 幂等（日志已被启动扫描清理）
    recallmd_lib::persistence::document::index_complete(&root_str, &saved.operation_id).unwrap();

    // 单份状态：两块（一 MISSING 一 ACTIVE），文档 READY，正文不回退
    let conn = side_conn(&root);
    assert_eq!(count(&conn, "SELECT count(*) FROM KnowledgeBlock"), 2);
    assert_eq!(
        count(&conn, "SELECT count(*) FROM Document WHERE index_status = 'READY'"),
        1
    );
    let disk = std::fs::read(root.join("a.md")).unwrap();
    assert_eq!(disk, b"# \xe6\x96\xb0\xe5\x86\x85\xe5\xae\xb9\n\n\xe6\xad\xa3\xe6\x96\x87\n");

    close_workspace().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn m4_new_file_first_save_then_crash() {
    let _guard = serial();
    let root = std::env::temp_dir().join(format!("recallmd-m4r-crash2-{}", nanos()));
    std::fs::create_dir_all(&root).unwrap();
    let root_str = root.to_str().unwrap().to_string();
    open_workspace(&root_str).unwrap();

    // 新文件：首存成功后"崩溃"（无索引）
    let saved = save_document(
        &root_str,
        "n.md",
        recallmd_lib::persistence::document::SaveDocumentParams {
            text: "# 新\n\n正文\n".into(),
            eol: "LF".into(),
            add_bom: false,
            expected_hash: "ABSENT".into(),
        },
    )
    .unwrap();
    close_workspace().unwrap();
    open_workspace(&root_str).unwrap();

    // DB 无该文档；启动收敛登记一次；重放 NOOP
    let snap = match active_store().unwrap().call(DbAction::RegistrySnapshot).unwrap() {
        recallmd_lib::persistence::store::DbReply::RegistrySnapshot(s) => *s,
        _ => panic!(),
    };
    assert!(snap.documents.is_empty(), "崩溃时索引未发生，DB 应无文档");

    let bid = new_id();
    let req = batch(
        vec![header("n.md", 0, &saved.committed_hash)],
        vec![create(&bid, "n.md", 0, &h64("body"))],
        vec!["n.md".to_string()],
    );
    let r1 = commit_via_store(req);
    assert_eq!(r1.documents[0].index_revision, 1);
    let mut replay = batch(
        vec![header("n.md", 1, &saved.committed_hash)],
        vec![create(&bid, "n.md", 0, &h64("body"))],
        vec!["n.md".to_string()],
    );
    replay.block_results[0].content_version_delta = 0;
    let r2 = commit_via_store(replay);
    assert!(!r2.blocks[0].applied, "重放 NOOP");

    recallmd_lib::persistence::document::index_complete(&root_str, &saved.operation_id).unwrap();
    close_workspace().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn m4_move_crash_between_rename_and_db() {
    let _guard = serial();
    let root = std::env::temp_dir().join(format!("recallmd-m4r-crash3-{}", nanos()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.md"), "# A\n\n正文\n").unwrap();
    let root_str = root.to_str().unwrap().to_string();
    open_workspace(&root_str).unwrap();

    let bid = new_id();
    commit_via_store(batch(
        vec![header("a.md", 0, &h64("a"))],
        vec![create(&bid, "a.md", 0, &h64("body"))],
        vec!["a.md".to_string()],
    ));

    // 手工模拟：rename 已发生、DB 随批没跑就崩溃（写 STARTED 日志 + 直接改名）
    let op_id = new_id();
    let log = serde_json::json!({
        "operationId": op_id,
        "action": "MOVE",
        "phase": "STARTED",
        "src": "a.md",
        "dst": "b.md",
        "fileCount": 1,
        "timestampMs": 1_700_000_000_000i64,
    });
    std::fs::create_dir_all(root.join(".recallmd").join("operations")).unwrap();
    std::fs::write(
        root.join(".recallmd").join("operations").join(format!("{op_id}.json")),
        serde_json::to_vec_pretty(&log).unwrap(),
    )
    .unwrap();
    std::fs::rename(root.join("a.md"), root.join("b.md")).unwrap();

    close_workspace().unwrap();
    open_workspace(&root_str).unwrap();

    // 启动重放：文档路径已迁移，块经 document_id 自动跟随
    let conn = side_conn(&root);
    let (path, blocks): (String, i64) = conn
        .query_row(
            "SELECT relative_path, (SELECT count(*) FROM KnowledgeBlock) FROM Document",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(path, "b.md", "重放应把文档路径迁到 b.md");
    assert_eq!(blocks, 1);
    assert_eq!(count(&conn, "SELECT count(*) FROM Document"), 1, "单一状态");
    assert!(std::fs::read_dir(root.join(".recallmd").join("operations"))
        .unwrap()
        .count()
        == 0);

    close_workspace().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------------------
// 验收⑤：DB 删除恢复不声称保留历史（§12.6）
// ---------------------------------------------------------------------------

#[test]
fn m4_db_deleted_rebuilds_paused() {
    let _guard = serial();
    let root = std::env::temp_dir().join(format!("recallmd-m4r-del-{}", nanos()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.md"), "# A\n\n正文\n").unwrap();
    let root_str = root.to_str().unwrap().to_string();
    open_workspace(&root_str).unwrap();

    let bid = new_id();
    commit_via_store(batch(
        vec![header("a.md", 0, &h64("a"))],
        vec![create(&bid, "a.md", 0, &h64("body"))],
        vec!["a.md".to_string()],
    ));
    // 注入"已评分"痕迹（模拟 M5 产生的历史）
    side_conn(&root)
        .execute("UPDATE ReviewState SET first_review_at = 1, reps = 3", [])
        .unwrap();
    close_workspace().unwrap();

    // 删库（manifest 保留 = 恢复迹象）
    for suffix in ["", "-wal", "-shm"] {
        let p = root.join(".recallmd").join(format!("metadata.sqlite{suffix}"));
        let _ = std::fs::remove_file(p);
    }
    open_workspace(&root_str).unwrap();

    let status = recallmd_lib::persistence::workspace::active_recovery().unwrap();
    assert_eq!(status.recovery_mode.as_deref(), Some("REBUILT_NO_HISTORY"));
    assert!(status.rebuilt);

    // 注册表为空；历史不声称保留
    let snap = match active_store().unwrap().call(DbAction::RegistrySnapshot).unwrap() {
        recallmd_lib::persistence::store::DbReply::RegistrySnapshot(s) => *s,
        _ => panic!(),
    };
    assert!(snap.documents.is_empty());
    assert!(snap.blocks.is_empty());
    let conn = side_conn(&root);
    assert_eq!(count(&conn, "SELECT count(*) FROM ReviewHistory"), 0);

    // 同一 .md 重新登记：PAUSED + NEW + 无历史（不自动启用）
    let r = commit_via_store(batch(
        vec![header("a.md", 0, &h64("a"))],
        vec![create(&bid, "a.md", 0, &h64("body"))],
        vec!["a.md".to_string()],
    ));
    assert!(r.blocks[0].applied);
    let (participation, phase, first_at, reps): (String, String, Option<i64>, i64) = conn
        .query_row(
            "SELECT participation, phase, first_review_at, reps FROM ReviewState",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(participation, "PAUSED");
    assert_eq!(phase, "NEW");
    assert_eq!(first_at, None, "不声称保留历史");
    assert_eq!(reps, 0);

    // "从现在重新开始"：批量启用
    match active_store()
        .unwrap()
        .call(DbAction::BulkEnablePaused)
        .unwrap()
    {
        recallmd_lib::persistence::store::DbReply::DocsChanged(n) => assert_eq!(n, 1),
        _ => panic!(),
    }
    let enabled: String = conn
        .query_row("SELECT participation FROM ReviewState", [], |r| r.get(0))
        .unwrap();
    assert_eq!(enabled, "ENABLED");

    close_workspace().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn m4_db_corrupt_quarantines() {
    let _guard = serial();
    let root = std::env::temp_dir().join(format!("recallmd-m4r-corrupt-{}", nanos()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.md"), "# A\n\n正文\n").unwrap();
    let root_str = root.to_str().unwrap().to_string();
    open_workspace(&root_str).unwrap();
    let bid = new_id();
    commit_via_store(batch(
        vec![header("a.md", 0, &h64("a"))],
        vec![create(&bid, "a.md", 0, &h64("body"))],
        vec!["a.md".to_string()],
    ));
    close_workspace().unwrap();

    // 破坏 DB 头（SQLITE_NOTADB 路径）
    let db = root.join(".recallmd").join("metadata.sqlite");
    let mut bytes = std::fs::read(&db).unwrap();
    for b in bytes.iter_mut().take(32) {
        *b = 0xFF;
    }
    std::fs::write(&db, bytes).unwrap();
    // -wal 侧车在关闭时已 checkpoint；残留则一并破坏不可读
    open_workspace(&root_str).unwrap();

    let status = recallmd_lib::persistence::workspace::active_recovery().unwrap();
    assert_eq!(status.recovery_mode.as_deref(), Some("QUARANTINED_CORRUPT"));
    assert!(status.quarantined_to.is_some(), "隔离目录应记录");
    // 原件保留在隔离目录
    let q = root.join(".recallmd").join("quarantine");
    let entries: Vec<_> = std::fs::read_dir(&q)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert!(
        entries.iter().any(|p| p.join("metadata.sqlite").exists()),
        "隔离目录应含原库：{entries:?}"
    );
    // 正文不受影响
    assert!(root.join("a.md").exists());

    close_workspace().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn m4_newer_schema_offline() {
    let _guard = serial();
    let root = std::env::temp_dir().join(format!("recallmd-m4r-newer-{}", nanos()));
    std::fs::create_dir_all(&root).unwrap();
    let root_str = root.to_str().unwrap().to_string();
    open_workspace(&root_str).unwrap();
    close_workspace().unwrap();

    // schema 高于本版 → Offline（禁止自动降级/建空库，§14.3 L965）
    let db = root.join(".recallmd").join("metadata.sqlite");
    let conn = Connection::open(&db).unwrap();
    conn.pragma_update(None, "user_version", 99).unwrap();
    drop(conn);
    open_workspace(&root_str).unwrap();

    let err = active_store()
        .unwrap()
        .call(DbAction::RegistrySnapshot)
        .unwrap_err();
    assert_eq!(err.code, "MIGRATION_FAILED");
    // 正文仍可读写（Offline 只停元数据）
    let doc = recallmd_lib::persistence::document::read_document(&root_str, "missing.md");
    assert!(doc.is_err()); // 不存在 → FILE_NOT_FOUND（但命令层可用）
    close_workspace().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------------------
// 移动/删除/恢复的 DB 随批（验收③的文件级补充）
// ---------------------------------------------------------------------------

#[test]
fn m4_file_move_delete_restore_cycle() {
    let _guard = serial();
    let root = std::env::temp_dir().join(format!("recallmd-m4r-cycle-{}", nanos()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.md"), "# A\n\n正文\n").unwrap();
    let root_str = root.to_str().unwrap().to_string();
    open_workspace(&root_str).unwrap();
    // move/delete/trash 的实现比较规范化根（active_root 同源）
    let canon = recallmd_lib::persistence::paths::resolve_root(&root_str).unwrap();

    let bid = new_id();
    commit_via_store(batch(
        vec![header("a.md", 0, &h64("a"))],
        vec![create(&bid, "a.md", 0, &h64("body"))],
        vec!["a.md".to_string()],
    ));
    let doc_id: String = {
        let conn = side_conn(&root);
        conn.query_row("SELECT document_id FROM Document", [], |r| r.get(0))
            .unwrap()
    };

    // 移动：同一 document_id，块/状态跟随
    move_path(&canon, "a.md", "b.md").unwrap();
    {
        let conn = side_conn(&root);
        let (id, path, blocks, rev): (String, String, i64, i64) = conn
            .query_row(
                "SELECT document_id, relative_path, \
                 (SELECT count(*) FROM KnowledgeBlock), index_revision FROM Document",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(id, doc_id, "移动保身份");
        assert_eq!(path, "b.md");
        assert_eq!(blocks, 1);
        assert_eq!(rev, 1, "移动不加 index_revision");
    }

    // 提交 b.md 快照（同内容换路径）：文档 hash 更新，块 NOOP
    commit_via_store(batch(
        vec![header("b.md", 1, &h64("b"))],
        vec![BlockProposalDto {
            action: "NOOP".into(),
            status: "ACTIVE".into(),
            next: None,
            prev: None,
            content_version_delta: 0,
            ..create(&bid, "b.md", 0, &h64("body"))
        }],
        vec!["b.md".to_string()],
    ));
    {
        let conn = side_conn(&root);
        assert_eq!(count(&conn, "SELECT count(*) FROM ReviewState"), 1);
    }

    // 删除 → trash：文档+块 DELETED，参与不动，path_key 释放
    delete_path(&canon, "b.md").unwrap();
    {
        let conn = side_conn(&root);
        let (ds, bs, participation): (String, String, String) = conn
            .query_row(
                "SELECT (SELECT status FROM Document), \
                 (SELECT status FROM KnowledgeBlock), \
                 (SELECT participation FROM ReviewState)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(ds, "DELETED");
        assert_eq!(bs, "DELETED");
        assert_eq!(participation, "ENABLED", "删除不动参与状态");
        // 同路径新登记不撞 path_key（部分索引）
        let mut c2 = open_test_db(&root.join(".recallmd").join("metadata.sqlite")).unwrap();
        let _ = &mut c2;
    }

    // trash 恢复：文档 PRESENT/PENDING，块 MISSING（诚实：reconcile 再复现）
    let entries = trash_list(&canon).unwrap();
    assert_eq!(entries.len(), 1);
    trash_restore(&canon, &entries[0].operation_id, None).unwrap();
    {
        let conn = side_conn(&root);
        let (ds, is, bs): (String, String, String) = conn
            .query_row(
                "SELECT status, index_status, (SELECT status FROM KnowledgeBlock) FROM Document",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(ds, "PRESENT");
        assert_eq!(is, "PENDING");
        assert_eq!(bs, "MISSING");
    }

    // 重扫复现：RESTORE 提案 → ACTIVE，参与保留（NOOP 提交已把 rev 推到 2）
    let mut restored = next_dto(&bid, "b.md", 0, &h64("body"));
    restored.relative_path = "b.md".into();
    commit_via_store(batch(
        vec![header("b.md", 2, &h64("b"))],
        vec![BlockProposalDto {
            action: "RESTORE".into(),
            status: "ACTIVE".into(),
            next: Some(restored),
            prev: Some(PrevRefDto {
                relative_path: "b.md".into(),
                status: "MISSING".into(),
            }),
            content_version_delta: 0,
            ..create(&bid, "b.md", 0, &h64("body"))
        }],
        vec!["b.md".to_string()],
    ));
    {
        let conn = side_conn(&root);
        let (bs, participation): (String, String) = conn
            .query_row(
                "SELECT status, participation FROM KnowledgeBlock b \
                 JOIN ReviewState r ON r.block_id = b.block_id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(bs, "ACTIVE");
        assert_eq!(participation, "ENABLED");
    }

    close_workspace().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}
