//! M4 验收⑥：从备份恢复历史与正文核验通过；备份轮换/验证；DB_BUSY 映射。
//! 备份原语（直连）与恢复流程（激活态）混合；激活态测试持锁串行。

use std::sync::{Mutex, OnceLock};

use recallmd_lib::persistence::store::backup::{
    create_verified_backup, rotate_backups, BACKUP_DB_DIR,
};
use recallmd_lib::persistence::store::dto::{
    BlockProposalDto, CommitIndexBatchRequest, DocumentHeaderDto,
};
use recallmd_lib::persistence::store::{open_test_db, DbAction};
use recallmd_lib::persistence::workspace::{active_store, close_workspace, open_workspace};
use rusqlite::Connection;

fn test_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

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
        parser_version: "p/fingerprint-v1".into(),
        byte_size: 32,
        mtime_ms: 1_700_000_000_000,
        line_ending: "LF".into(),
        has_bom: false,
        diagnostics: vec![],
        file_identity: None,
    }
}

fn create(block_id: &str, path: &str, body_hash: &str) -> BlockProposalDto {
    BlockProposalDto {
        block_id: block_id.into(),
        action: "CREATE".into(),
        status: "ACTIVE".into(),
        relative_path: Some(path.into()),
        next: Some(recallmd_lib::persistence::store::dto::BlockNextDto {
            block_id: Some(block_id.into()),
            kind: "SECTION".into(),
            title: Some("T".into()),
            heading_level: 2,
            heading_path: vec!["H".into()],
            ordinal: 0,
            start_offset: 0,
            body_start_offset: 4,
            end_offset: 40,
            source_hash: h64("s"),
            body_hash: body_hash.into(),
            oversized: false,
            relative_path: path.into(),
            content_version: 1,
            needs_recheck: false,
        }),
        change_class: None,
        content_version_delta: 1,
        needs_recheck: false,
        prev: None,
        reason: "首次登记".into(),
        occurrences: vec![],
    }
}

fn commit_via_store(req: CommitIndexBatchRequest) {
    match active_store()
        .unwrap()
        .call(DbAction::CommitIndex(Box::new(req)))
        .unwrap()
    {
        recallmd_lib::persistence::store::DbReply::CommitIndex(_) => {}
        _ => panic!(),
    }
}

fn side_conn(root: &std::path::Path) -> Connection {
    let conn = Connection::open(root.join(".recallmd").join("metadata.sqlite")).unwrap();
    conn.pragma_update(None, "busy_timeout", 5000).unwrap();
    conn
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

// ---------------------------------------------------------------------------
// 轮换与验证（直连，无需激活态）
// ---------------------------------------------------------------------------

#[test]
fn m4_backup_rotation_keeps_verified_recent() {
    let dir = std::env::temp_dir().join(format!("recallmd-m4b-rot-{}", nanos()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("meta.sqlite");
    let conn = open_test_db(&db).unwrap();

    let backup_dir = dir.join("backups").join(BACKUP_DB_DIR);
    for i in 0..9 {
        let p = create_verified_backup(&conn, &backup_dir).unwrap();
        assert!(p.extension().is_none() || p.extension().and_then(|e| e.to_str()) == Some("sqlite"));
        // 强制唯一名（同毫秒退让）
        let _ = i;
    }
    rotate_backups(&backup_dir, 7).unwrap();
    let kept: Vec<_> = std::fs::read_dir(&backup_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("sqlite"))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(kept.len(), 7, "9 份轮换后留 7：{kept:?}");
    let mut sorted = kept.clone();
    sorted.sort();
    assert!(kept.iter().max() == sorted.last());

    // 每份都能通过验证
    for name in &kept {
        recallmd_lib::persistence::store::backup::verify_backup_file(&backup_dir.join(name))
            .unwrap_or_else(|e| panic!("{name} 验证失败：{e}"));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn m4_restore_rejects_bad_backup() {
    let dir = std::env::temp_dir().join(format!("recallmd-m4b-bad-{}", nanos()));
    std::fs::create_dir_all(&dir).unwrap();
    let conn = open_test_db(&dir.join("meta.sqlite")).unwrap();
    let backup_dir = dir.join("backups").join(BACKUP_DB_DIR);
    let good = create_verified_backup(&conn, &backup_dir).unwrap();

    // 篡改备份 → 验证拒绝
    let bad = backup_dir.join("bad.sqlite");
    let mut bytes = std::fs::read(&good).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xFF;
    std::fs::write(&bad, bytes).unwrap();
    let err = recallmd_lib::persistence::store::backup::verify_backup_file(&bad).unwrap_err();
    assert_eq!(err.code, "DB_CORRUPT");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 验收⑥：DB 备份恢复端到端（激活态）
// ---------------------------------------------------------------------------

#[test]
fn m4_db_restore_recovers_history() {
    let _guard = serial();
    let root = std::env::temp_dir().join(format!("recallmd-m4b-restore-{}", nanos()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.md"), "# A\n\n正文\n").unwrap();
    let root_str = root.to_str().unwrap().to_string();
    open_workspace(&root_str).unwrap();

    // 登记 + 模拟已评分历史
    let bid = new_id();
    commit_via_store(CommitIndexBatchRequest {
        documents: vec![header("a.md", 0, &h64("a"))],
        block_results: vec![create(&bid, "a.md", &h64("body"))],
        snapshot_paths: vec!["a.md".to_string()],
    });
    side_conn(&root)
        .execute(
            "UPDATE ReviewState SET first_review_at = 9, reps = 5, stability = 12.5, \
             participation = 'PAUSED'",
            [],
        )
        .unwrap();

    // 备份（backup_db_now 走 worker）
    let recallmd = root.join(".recallmd");
    let backup_name = match active_store()
        .unwrap()
        .call(DbAction::BackupDbNow {
            recallmd_dir: recallmd.clone(),
        })
        .unwrap()
    {
        recallmd_lib::persistence::store::DbReply::DbBackup(e) => e.file_name,
        _ => panic!(),
    };

    // 删库重开（REBUILT_NO_HISTORY），然后从备份恢复
    close_workspace().unwrap();
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(recallmd.join(format!("metadata.sqlite{suffix}")));
    }
    open_workspace(&root_str).unwrap();
    assert_eq!(
        recallmd_lib::persistence::workspace::active_recovery()
            .unwrap()
            .recovery_mode
            .as_deref(),
        Some("REBUILT_NO_HISTORY")
    );

    match active_store()
        .unwrap()
        .call(DbAction::RestoreDb {
            recallmd_dir: recallmd.clone(),
            file_name: backup_name,
        })
        .unwrap()
    {
        recallmd_lib::persistence::store::DbReply::DbRestore(r) => {
            assert_eq!(r.documents_pending, 1);
            assert!(r.quarantined_to.is_some());
        }
        _ => panic!(),
    }

    // 历史/状态完整恢复；文档 PENDING；再提交同内容 → 收敛且 content_version 不虚增
    let snap = match active_store().unwrap().call(DbAction::RegistrySnapshot).unwrap() {
        recallmd_lib::persistence::store::DbReply::RegistrySnapshot(s) => *s,
        _ => panic!(),
    };
    assert_eq!(snap.blocks.len(), 1);
    assert_eq!(snap.blocks[0].block_id, bid);
    assert!(snap.blocks[0].has_rating, "历史评分保留");
    assert_eq!(snap.blocks[0].participation, "PAUSED");
    assert_eq!(snap.documents[0].index_status, "PENDING");
    let rev = snap.documents[0].index_revision;

    let r = match active_store()
        .unwrap()
        .call(DbAction::CommitIndex(Box::new(CommitIndexBatchRequest {
            documents: vec![header("a.md", rev, &h64("a"))],
            block_results: vec![BlockProposalDto {
                action: "NOOP".into(),
                status: "ACTIVE".into(),
                next: None,
                prev: None,
                content_version_delta: 0,
                ..create(&bid, "a.md", &h64("body"))
            }],
            snapshot_paths: vec!["a.md".to_string()],
        })))
        .unwrap()
    {
        recallmd_lib::persistence::store::DbReply::CommitIndex(r) => *r,
        _ => panic!(),
    };
    assert_eq!(r.documents[0].index_revision, rev + 1, "PENDING→READY 计一次写入");
    let conn = side_conn(&root);
    assert_eq!(count(&conn, "SELECT content_version FROM KnowledgeBlock"), 1);
    let (stability, reps): (f64, i64) = conn
        .query_row("SELECT stability, reps FROM ReviewState", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(stability, 12.5);
    assert_eq!(reps, 5);

    close_workspace().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn m4_db_busy_maps_retryable() {
    let _guard = serial();
    let root = std::env::temp_dir().join(format!("recallmd-m4b-busy-{}", nanos()));
    std::fs::create_dir_all(&root).unwrap();
    let root_str = root.to_str().unwrap().to_string();
    open_workspace(&root_str).unwrap();

    // 外部连接持写锁 → worker 提交在 busy_timeout(5s) 后 DB_BUSY + retryable
    let holder = side_conn(&root);
    holder.execute_batch("BEGIN EXCLUSIVE; SELECT count(*) FROM Document;").unwrap();

    let start = std::time::Instant::now();
    let err = active_store()
        .unwrap()
        .call(DbAction::CommitIndex(Box::new(CommitIndexBatchRequest {
            documents: vec![header("x.md", 0, &h64("x"))],
            block_results: vec![],
            snapshot_paths: vec!["x.md".to_string()],
        })))
        .unwrap_err();
    assert_eq!(err.code, "DB_BUSY", "{err:?}");
    assert!(err.retryable, "DB_BUSY 须可重试");
    assert!(start.elapsed() >= std::time::Duration::from_secs(4), "应等满 busy_timeout");

    holder.execute_batch("ROLLBACK;").unwrap();
    close_workspace().unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------------------
// 完整 Workspace 备份/恢复（§14.2.4–5）
// ---------------------------------------------------------------------------

#[test]
fn m4_full_backup_and_restore_roundtrip() {
    let _guard = serial();
    let root = std::env::temp_dir().join(format!("recallmd-m4b-full-{}", nanos()));
    std::fs::create_dir_all(root.join("assets")).unwrap();
    std::fs::write(root.join("a.md"), "# A\n\n正文\n").unwrap();
    std::fs::write(root.join("assets").join("pic.png"), b"\x89PNG-bytes").unwrap();
    let root_str = root.to_str().unwrap().to_string();
    open_workspace(&root_str).unwrap();

    let bid = new_id();
    commit_via_store(CommitIndexBatchRequest {
        documents: vec![header("a.md", 0, &h64("a"))],
        block_results: vec![create(&bid, "a.md", &h64("body"))],
        snapshot_paths: vec!["a.md".to_string()],
    });

    // 完整备份到库外目录
    let target = std::env::temp_dir().join(format!("recallmd-m4b-full-target-{}", nanos()));
    std::fs::create_dir_all(&target).unwrap();
    let ws_id = recallmd_lib::persistence::workspace::active_info()
        .unwrap()
        .workspace_id;
    let backup_dir = match active_store()
        .unwrap()
        .call(DbAction::BackupFull {
            root_canon: root.clone(),
            workspace_id: ws_id,
            target_dir: target.clone(),
        })
        .unwrap()
    {
        recallmd_lib::persistence::store::DbReply::FullBackup(r) => {
            std::path::PathBuf::from(r.backup_dir)
        }
        _ => panic!(),
    };
    assert!(backup_dir.join("manifest.json").exists(), "manifest 存在才算成功");
    assert!(backup_dir.join("files").join("a.md").exists());
    assert!(backup_dir.join("db").join("metadata.sqlite").exists());

    // 篡改备份内文件 → verify-first 恢复拒绝
    let tampered = backup_dir.join("files").join("a.md");
    std::fs::write(&tampered, b"tampered").unwrap();
    let bad_target = std::env::temp_dir().join(format!("recallmd-m4b-full-bad-{}", nanos()));
    let err = recallmd_lib::persistence::store::backup::backup_full_restore(
        &backup_dir,
        &bad_target,
    )
    .unwrap_err();
    assert_eq!(err.code, "VERIFY_FAILED");
    assert!(!bad_target.join("a.md").exists(), "失败不落部分产物");
    std::fs::write(&tampered, "# A\n\n正文\n").unwrap(); // 还原

    // 正常恢复到空目录 → 重开 → 注册表与正文一致
    let ok_target = std::env::temp_dir().join(format!("recallmd-m4b-full-ok-{}", nanos()));
    let result = recallmd_lib::persistence::store::backup::backup_full_restore(
        &backup_dir,
        &ok_target,
    )
    .unwrap();
    assert_eq!(result.file_count, 2); // a.md + pic.png
    assert_eq!(
        std::fs::read(ok_target.join("a.md")).unwrap(),
        std::fs::read(root.join("a.md")).unwrap()
    );
    // 恢复非空目标拒绝
    let err2 = recallmd_lib::persistence::store::backup::backup_full_restore(
        &backup_dir,
        &ok_target,
    )
    .unwrap_err();
    assert_eq!(err2.code, "FILE_CONFLICT");

    close_workspace().unwrap();
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&target);
    let _ = std::fs::remove_dir_all(&ok_target);
}
