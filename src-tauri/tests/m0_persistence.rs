//! M0 验证：SQLite 事务/Backup API 与 Windows `ReplaceFileW` 带 backup 的替换语义。
//! 对应设计文档 §6.2（rusqlite 单连接事务）、§13.2（原子替换协议）、§14.4（故障注入矩阵）。
//! 正式 PersistenceHost 在 M4/M7 实现，这里先验证底层假设成立。

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::{ReplaceFileW, REPLACE_FILE_FLAGS};

fn temp_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("recallmd-m0-{tag}-{nanos}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn to_wide(p: &PathBuf) -> Vec<u16> {
    p.to_str().unwrap().encode_utf16().chain(std::iter::once(0)).collect()
}

/// bundled SQLite 引擎版本必须 >= 3.51.3（设计 §12.1，WAL-reset 修复）
fn parse_version(v: &str) -> (u64, u64, u64) {
    let mut it = v.split('.');
    let major = it.next().unwrap().parse().unwrap();
    let minor = it.next().unwrap().parse().unwrap();
    let patch = it.next().unwrap_or("0").parse().unwrap();
    (major, minor, patch)
}

#[test]
fn sqlite_version_transaction_and_backup() {
    let ver = rusqlite::version();
    println!("bundled SQLite 版本: {ver}");
    assert!(
        parse_version(ver) >= (3, 51, 3),
        "bundled SQLite {ver} 低于设计要求的 3.51.3"
    );

    let dir = temp_dir("sqlite");
    let mut conn = Connection::open(dir.join("metadata.sqlite")).unwrap();

    // journal_mode 返回结果行，须用 query_row 执行
    let mode: String = conn
        .query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL);")
        .unwrap();

    // 回滚：不留半条数据
    {
        let tx = conn.transaction().unwrap();
        tx.execute("INSERT INTO t (v) VALUES ('rolled-back')", []).unwrap();
        tx.rollback().unwrap();
    }
    let n: i64 = conn.query_row("SELECT count(*) FROM t", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);

    // 提交：原子可见
    {
        let tx = conn.transaction().unwrap();
        tx.execute("INSERT INTO t (v) VALUES ('committed')", []).unwrap();
        tx.commit().unwrap();
    }
    let n: i64 = conn.query_row("SELECT count(*) FROM t", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);

    // Backup API：在线一致性备份（不能在 WAL 活跃时单拷文件，设计 §14.2）
    let mut dst = Connection::open(dir.join("metadata-backup.sqlite")).unwrap();
    {
        let backup = rusqlite::backup::Backup::new(&conn, &mut dst).unwrap();
        backup
            .run_to_completion(16, std::time::Duration::from_millis(250), None)
            .unwrap();
    }
    let copied: i64 = dst.query_row("SELECT count(*) FROM t", [], |r| r.get(0)).unwrap();
    assert_eq!(copied, 1);
}

#[test]
fn replace_file_w_preserves_backup() {
    let dir = temp_dir("replace");
    let target = dir.join("note.md");
    let replacement = dir.join("note.md.recallmd-tmp-7f3a");
    let backup = dir.join("note.md.recallmd-backup-7f3a");
    fs::write(&target, "OLD v1").unwrap();
    fs::write(&replacement, "NEW v2").unwrap();

    unsafe {
        let t = to_wide(&target);
        let r = to_wide(&replacement);
        let b = to_wide(&backup);
        ReplaceFileW(
            PCWSTR::from_raw(t.as_ptr()),
            PCWSTR::from_raw(r.as_ptr()),
            PCWSTR::from_raw(b.as_ptr()),
            REPLACE_FILE_FLAGS(0),
            None,
            None,
        )
        .unwrap();
    }

    assert_eq!(fs::read_to_string(&target).unwrap(), "NEW v2");
    assert_eq!(fs::read_to_string(&backup).unwrap(), "OLD v1");
    assert!(!replacement.exists(), "临时文件应被替换操作消费");
}

/// 子进程入口：由 crash_before_replace 通过环境变量触发。
/// 模拟保存协议第 4 步完成、替换未执行时进程终止。
#[test]
fn child_gate() {
    let Some(dir) = std::env::var_os("M0_CHILD_DIR") else {
        return;
    };
    let tmp = PathBuf::from(dir).join("note.md.recallmd-tmp-crash1");
    fs::write(&tmp, "CANDIDATE v2").unwrap();
    std::process::exit(101);
}

/// 故障注入（§14.4 第 1 行）：写临时文件中途终止进程 →
/// 原文仍在，临时草稿可识别、不覆盖原文。
#[test]
fn crash_before_replace_keeps_original_and_draft() {
    let dir = temp_dir("crash");
    let target = dir.join("note.md");
    fs::write(&target, "OLD v1").unwrap();

    let status = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "child_gate", "--test-threads=1", "--nocapture"])
        .env("M0_CHILD_DIR", &dir)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(101), "子进程应模拟崩溃退出");

    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "OLD v1",
        "原文必须原样保留"
    );
    let tmp = dir.join("note.md.recallmd-tmp-crash1");
    assert_eq!(
        fs::read_to_string(&tmp).unwrap(),
        "CANDIDATE v2",
        "草稿必须可识别、可恢复"
    );
}
