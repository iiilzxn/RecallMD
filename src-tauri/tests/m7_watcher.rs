//! M7 Watcher 集成测试（真实 notify 事件；单测试串行——全局唯一 watcher 实例）。
//! 覆盖：基本事件+hash、自写识别（hash 相等）、排除目录、删除线索、稳定窗
//! （连续写入 3s 内不判删除——暂存后收敛）、停止语义。

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use recallmd_lib::persistence::watcher::{self, FsChangedPath};

fn temp_ws(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "recallmd-m7-{}-{}",
        name,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn sha256_of(path: &std::path::Path) -> String {
    use sha2::Digest as _;
    let bytes = std::fs::read(path).unwrap();
    let mut h = sha2::Sha256::new();
    h.update(&bytes);
    let out = h.finalize();
    out.iter().map(|b| format!("{b:02x}")).collect()
}

fn recv_event(rx: &mpsc::Receiver<(String, FsChangedPath)>, wait_ms: u64) -> Option<FsChangedPath> {
    let deadline = std::time::Instant::now() + Duration::from_millis(wait_ms);
    while let Ok(remain) = rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()).max(Duration::from_millis(1))) {
        if remain.0 == "fs-changed" {
            return Some(remain.1);
        }
        // fs-overflow 等其他事件忽略（本测试不触发）
    }
    None
}

#[test]
fn m7_watcher_lifecycle_and_events() {
    let ws = temp_ws("watcher");
    let (tx, rx) = mpsc::channel::<(String, FsChangedPath)>();
    let tx_send = tx.clone();
    watcher::start(ws.clone(), move |event, payload| {
        let _ = tx_send.send((event.to_string(), payload.clone()));
    });
    assert!(watcher::is_running());

    // 1. 基本外部写入：a.md → 事件带 hash、own=false
    let a = ws.join("a.md");
    std::fs::write(&a, "# T\n\n<!-- recall:block:11111111-aaaa-4bbb-8ccc-000000000001 -->\n\n答案一。\n").unwrap();
    let ev = recv_event(&rx, 8_000).expect("a.md 事件");
    assert_eq!(ev.rel, "a.md");
    assert_eq!(ev.hash.as_deref(), Some(sha256_of(&a).as_str()));
    assert!(!ev.own, "未登记自写 → 外部事件");
    assert!(!ev.dir);

    // 2. 自写识别：登记 committedHash 后同内容重写 → own=true
    watcher::record_internal_write("a.md", &sha256_of(&a));
    std::fs::write(&a, "# T\n\n<!-- recall:block:11111111-aaaa-4bbb-8ccc-000000000001 -->\n\n答案一。\n").unwrap();
    let ev = recv_event(&rx, 8_000).expect("自写事件");
    assert!(ev.own, "hash 相等 → 自写");

    // 3. 内容再变（hash 不等）→ own=false（自写匹配条件必须是 hash 相等）
    std::fs::write(&a, "# T\n\n<!-- recall:block:11111111-aaaa-4bbb-8ccc-000000000001 -->\n\n答案二。\n").unwrap();
    let ev = recv_event(&rx, 8_000).expect("再变事件");
    assert!(!ev.own);

    // 4. 排除目录：.recallmd / .git 内写入 → 无事件
    std::fs::create_dir_all(ws.join(".recallmd")).unwrap();
    std::fs::write(ws.join(".recallmd/metadata.sqlite"), b"junk").unwrap();
    std::fs::create_dir_all(ws.join(".git")).unwrap();
    std::fs::write(ws.join(".git/HEAD"), b"ref").unwrap();
    std::fs::write(ws.join("notes.txt"), b"not md").unwrap(); // 非 .md 也不发
    assert!(recv_event(&rx, 2_500).is_none(), "排除路径不得产生事件");

    // 5. 删除：只发线索（hash=None），watcher 不下删除结论
    std::fs::remove_file(&a).unwrap();
    let ev = recv_event(&rx, 8_000).expect("删除线索");
    assert_eq!(ev.rel, "a.md");
    assert!(ev.hash.is_none());

    // 6. 稳定窗：持续写入超过 3s → 不发未稳定事件；写完 2s 后（暂存重试）收敛到最终内容
    let b = ws.join("b.md");
    let b_w = b.clone();
    let handle = std::thread::spawn(move || {
        for i in 0..14 {
            std::fs::write(&b_w, format!("第 {i} 轮草稿内容，足够长以触发多事件。_padding_{i}_")).unwrap();
            std::thread::sleep(Duration::from_millis(300));
        }
        "done".to_string()
    });
    handle.join().unwrap();
    // 风暴期间的中间态会各自成事件；收敛判定=最终 hash 的事件必然出现
    let final_hash = sha256_of(&b);
    let mut converged = false;
    let deadline = std::time::Instant::now() + Duration::from_millis(12_000);
    while let Some(ev) = recv_event(&rx, deadline.saturating_duration_since(std::time::Instant::now()).max(Duration::from_millis(1)).as_millis() as u64) {
        if ev.rel == "b.md" && ev.hash.as_deref() == Some(final_hash.as_str()) {
            converged = true;
            break;
        }
    }
    assert!(converged, "风暴后必须收敛到最终内容的事件");

    // 7. 目录事件：新建子目录 → dir=true（排空残余文件事件后取目录事件）
    std::fs::create_dir_all(ws.join("sub")).unwrap();
    let mut saw_dir = false;
    let deadline7 = std::time::Instant::now() + Duration::from_millis(8_000);
    loop {
        let remain = deadline7.saturating_duration_since(std::time::Instant::now());
        if remain.is_zero() { break; }
        match recv_event(&rx, remain.as_millis() as u64) {
            Some(ev) if ev.dir => {
                saw_dir = true;
                break;
            }
            Some(_) => continue,
            None => break,
        }
    }
    assert!(saw_dir, "目录事件（dir=true）");

    // 8. 停止：不再有事件，线程 join 干净
    watcher::stop();
    assert!(!watcher::is_running());
    std::fs::write(ws.join("c.md"), "# after stop\n").unwrap();
    assert!(recv_event(&rx, 2_000).is_none(), "停止后不再产生事件");
    let _ = std::fs::remove_dir_all(&ws);
}
