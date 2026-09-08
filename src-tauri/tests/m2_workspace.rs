//! M2 Workspace 与文件管理集成测试（设计 §18 M2 验收）。
//! 直接调用库函数；全局激活态是进程级单例，用串行锁隔离各测试。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use recallmd_lib::persistence::document::{draft_read, draft_write};
use recallmd_lib::persistence::error::HostError;
use recallmd_lib::persistence::workspace::{
    active_root, close_workspace, create_dir, create_file, delete_path, delete_preview,
    filter_files, list_dir, move_path, open_workspace, trash_list, trash_restore,
};
use windows::core::PCWSTR;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Storage::FileSystem::{
    CreateFileW, LockFileEx, UnlockFileEx, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_MODE,
    LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, OPEN_EXISTING,
};
use windows::Win32::System::IO::OVERLAPPED;

const GENERIC_READ_U32: u32 = 0x8000_0000;

static TEST_LOCK: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn temp_root(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("recallmd-m2-{tag}-{nanos}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn root_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn err_code(r: Result<impl Sized, HostError>) -> String {
    r.err().map(|e| e.code).unwrap_or_default()
}

#[test]
fn workspace_open_creates_manifest_and_keeps_id() {
    let _g = serial();
    let root = temp_root("manifest");
    let info = open_workspace(&root_str(&root)).unwrap();
    assert_eq!(info.format_version, 1);
    assert!(!info.workspace_id.is_empty());
    assert!(root.join(".recallmd/workspace.json").exists());
    assert!(root.join(".recallmd/workspace.lock").exists());
    // manifest 不含绝对路径（§7.1）
    let text = fs::read_to_string(root.join(".recallmd/workspace.json")).unwrap();
    assert!(!text.contains(&root_str(&root).replace('\\', "/")));

    // 幂等重开 + 关闭后重开：身份稳定
    let again = open_workspace(&root_str(&root)).unwrap();
    assert_eq!(again.workspace_id, info.workspace_id);
    close_workspace().unwrap();
    let third = open_workspace(&root_str(&root)).unwrap();
    assert_eq!(third.workspace_id, info.workspace_id);
    close_workspace().unwrap();
}

#[test]
fn workspace_manifest_version_guard() {
    let _g = serial();
    let root = temp_root("version");
    fs::create_dir_all(root.join(".recallmd")).unwrap();
    fs::write(
        root.join(".recallmd/workspace.json"),
        r#"{"workspaceId":"x","formatVersion":99}"#,
    )
    .unwrap();
    let err = open_workspace(&root_str(&root)).unwrap_err();
    assert_eq!(err.code, "IO_ERROR");
    assert!(err.message.contains("99"));
    close_workspace().unwrap();
}

#[test]
fn workspace_lock_is_exclusive_and_released() {
    let _g = serial();
    let root = temp_root("lock");
    open_workspace(&root_str(&root)).unwrap();

    // 模拟另一进程：打开锁文件并尝试 LockFileEx —— 必须失败
    let lock_path = root.join(".recallmd/workspace.lock");
    let wide: Vec<u16> = root_str(&lock_path).encode_utf16().chain(std::iter::once(0)).collect();
    let handle = unsafe {
        CreateFileW(
            PCWSTR::from_raw(wide.as_ptr()),
            GENERIC_READ_U32,
            FILE_SHARE_MODE(3), // READ | WRITE
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
    }
    .unwrap();
    let mut ov = OVERLAPPED::default();
    let locked = unsafe {
        LockFileEx(
            handle,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            None,
            u32::MAX,
            0,
            &mut ov,
        )
    };
    assert!(locked.is_err(), "第二个句柄不应能取得独占锁");

    close_workspace().unwrap();
    let mut ov2 = OVERLAPPED::default();
    let locked2 = unsafe {
        LockFileEx(
            handle,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            None,
            u32::MAX,
            0,
            &mut ov2,
        )
    };
    assert!(locked2.is_ok(), "释放后应可重新加锁");
    unsafe {
        let mut ov3 = OVERLAPPED::default();
        let _ = UnlockFileEx(handle, None, u32::MAX, 0, &mut ov3);
        let _ = CloseHandle(handle);
    }
    // 重新激活给后续测试一个干净状态
    open_workspace(&root_str(&root)).unwrap();
    close_workspace().unwrap();
}

#[test]
fn active_root_requires_open_workspace() {
    let _g = serial();
    close_workspace().unwrap(); // 清空
    let err = active_root().unwrap_err();
    assert_eq!(err.code, "WORKSPACE_NOT_OPEN");
}

#[test]
fn list_dir_filters_sorts_and_handles_chinese() {
    let _g = serial();
    let root = temp_root("tree");
    fs::create_dir_all(root.join("Java")).unwrap();
    fs::create_dir_all(root.join("目录")).unwrap();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::create_dir_all(root.join("node_modules")).unwrap();
    fs::write(root.join("Java/JVM.md"), "# jvm").unwrap();
    fs::write(root.join("Java/笔记.md"), "中文").unwrap();
    fs::write(root.join("note.md"), "n").unwrap();
    fs::write(root.join("pic.png"), "x").unwrap();
    fs::write(root.join(".secret.md"), "x").unwrap();
    open_workspace(&root_str(&root)).unwrap();
    let root_canon = active_root().unwrap();

    let top = list_dir(&root_canon, "").unwrap();
    let names: Vec<(String, bool)> = top.iter().map(|e| (e.name.clone(), e.is_dir)).collect();
    assert_eq!(
        names,
        vec![
            ("Java".into(), true),
            ("目录".into(), true),
            ("note.md".into(), false),
        ]
    );
    let sub = list_dir(&root_canon, "Java").unwrap();
    assert_eq!(sub.len(), 2);
    assert!(sub.iter().any(|e| e.name == "笔记.md"));

    // 大小写与中文过滤
    let hits = filter_files(&root_canon, "jvm", 200).unwrap();
    assert_eq!(hits, vec!["Java/JVM.md".to_string()]);
    let hits = filter_files(&root_canon, "笔记", 200).unwrap();
    assert!(hits.contains(&"Java/笔记.md".to_string()));
    assert!(filter_files(&root_canon, "  ", 200).unwrap().is_empty());

    // 根外/元数据目录被拒
    assert_eq!(err_code(list_dir(&root_canon, ".recallmd")), "PATH_REJECTED");
    assert_eq!(err_code(list_dir(&root_canon, "nope")), "FILE_NOT_FOUND");
    close_workspace().unwrap();
}

#[test]
fn create_file_and_dir_validate_and_reject_overwrite() {
    let _g = serial();
    let root = temp_root("create");
    fs::create_dir_all(root.join("Java")).unwrap();
    open_workspace(&root_str(&root)).unwrap();
    let rc = active_root().unwrap();

    create_file(&rc, "Java/New.md").unwrap();
    assert_eq!(fs::read_to_string(root.join("Java/New.md")).unwrap(), "");
    assert_eq!(err_code(create_file(&rc, "Java/New.md")), "FILE_CONFLICT");
    create_dir(&rc, "asdir.md").unwrap();
    assert_eq!(err_code(create_file(&rc, "asdir.md")), "FILE_CONFLICT"); // 同名目录
    assert_eq!(err_code(create_file(&rc, "Java/x.txt")), "PATH_REJECTED");
    assert_eq!(err_code(create_file(&rc, "Java/CON.md")), "PATH_REJECTED");
    assert_eq!(err_code(create_file(&rc, "../esc.md")), "PATH_REJECTED");
    assert_eq!(err_code(create_file(&rc, "Java/../x.md")), "PATH_REJECTED");
    assert_eq!(err_code(create_file(&rc, "nope/x.md")), "FILE_NOT_FOUND");

    create_dir(&rc, "Java/Sub").unwrap();
    assert_eq!(err_code(create_dir(&rc, "Java/Sub")), "FILE_CONFLICT");
    assert_eq!(err_code(create_dir(&rc, "Java/New.md")), "FILE_CONFLICT");
    assert_eq!(err_code(create_dir(&rc, ".recallmd/x")), "PATH_REJECTED");
    close_workspace().unwrap();
}

#[test]
fn move_rename_semantics() {
    let _g = serial();
    let root = temp_root("move");
    fs::create_dir_all(root.join("Java")).unwrap();
    fs::create_dir_all(root.join("Lang")).unwrap();
    fs::write(root.join("Java/JVM.md"), "content-中文").unwrap();
    fs::write(root.join("Java/keep.md"), "keep").unwrap();
    fs::write(root.join("Lang/occupied.md"), "o").unwrap();
    open_workspace(&root_str(&root)).unwrap();
    let rc = active_root().unwrap();

    // 文件重命名（同目录）
    move_path(&rc, "Java/JVM.md", "Java/Jvm2.md").unwrap();
    assert!(!root.join("Java/JVM.md").exists());
    assert_eq!(fs::read_to_string(root.join("Java/Jvm2.md")).unwrap(), "content-中文");

    // 目标被占 → 拒绝覆盖
    fs::write(root.join("Java/occ.md"), "x").unwrap();
    assert_eq!(err_code(move_path(&rc, "Java/keep.md", "Java/occ.md")), "FILE_CONFLICT");
    assert_eq!(fs::read_to_string(root.join("Java/occ.md")).unwrap(), "x");

    // 大小写重命名：单次原子调用，最终大小写生效
    move_path(&rc, "Java/occ.md", "Java/OCC.md").unwrap();
    let names: Vec<String> = list_dir(&rc, "Java")
        .unwrap()
        .iter()
        .map(|e| e.name.clone())
        .collect();
    assert!(names.contains(&"OCC.md".to_string()));
    assert!(!names.contains(&"occ.md".to_string()));

    // 目录移动：整树搬家
    move_path(&rc, "Java", "Lang/JavaMoved").unwrap();
    assert!(root.join("Lang/JavaMoved/Jvm2.md").exists());
    assert!(!root.join("Java").exists());

    // 非法目标
    assert_eq!(err_code(move_path(&rc, "Lang", "Lang/self")), "PATH_REJECTED");
    assert_eq!(err_code(move_path(&rc, "Lang/JavaMoved/keep.md", "Lang/JavaMoved/keep.md")), "PATH_REJECTED");
    assert_eq!(err_code(move_path(&rc, "none.md", "x.md")), "FILE_NOT_FOUND");
    assert_eq!(err_code(move_path(&rc, "Lang/JavaMoved/keep.md", "nodir/keep.md")), "FILE_NOT_FOUND");
    assert_eq!(err_code(move_path(&rc, ".recallmd", "meta")), "PATH_REJECTED");
    // 文件目标必须 .md
    assert_eq!(err_code(move_path(&rc, "Lang/JavaMoved/keep.md", "Lang/JavaMoved/keep.txt")), "PATH_REJECTED");
    close_workspace().unwrap();
}

#[test]
fn delete_to_trash_and_restore() {
    let _g = serial();
    let root = temp_root("trash");
    fs::create_dir_all(root.join("DirA/sub")).unwrap();
    fs::write(root.join("DirA/sub/b.md"), "b-content").unwrap();
    fs::write(root.join("DirA/c.md"), "c-content").unwrap();
    fs::write(root.join("solo.md"), "solo-content").unwrap();
    open_workspace(&root_str(&root)).unwrap();
    let rc = active_root().unwrap();

    // 文件删除：预览 → 执行 → trash 列表
    let prev = delete_preview(&rc, "solo.md").unwrap();
    assert_eq!(prev.kind, "FILE");
    assert_eq!(prev.file_count, 1);
    assert!(prev.entries.contains(&"solo.md".to_string()));
    delete_path(&rc, "solo.md").unwrap();
    assert!(!root.join("solo.md").exists());
    let trash = trash_list(&rc).unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].original_relative_path, "solo.md");
    assert_eq!(trash[0].kind, "FILE");

    // 恢复：原位空闲
    let r = trash_restore(&rc, &trash[0].operation_id, None).unwrap();
    assert_eq!(r.restored_path, "solo.md");
    assert_eq!(fs::read_to_string(root.join("solo.md")).unwrap(), "solo-content");
    assert!(trash_list(&rc).unwrap().is_empty());

    // 目录删除与恢复
    delete_path(&rc, "DirA").unwrap();
    assert!(!root.join("DirA").exists());
    let trash = trash_list(&rc).unwrap();
    assert_eq!(trash[0].kind, "DIR");
    assert_eq!(trash[0].file_count, 2);
    trash_restore(&rc, &trash[0].operation_id, None).unwrap();
    assert_eq!(fs::read_to_string(root.join("DirA/sub/b.md")).unwrap(), "b-content");

    // 占用恢复：绝不覆盖
    delete_path(&rc, "DirA/c.md").unwrap();
    fs::write(root.join("DirA/c.md"), "new-占用").unwrap();
    let entry = &trash_list(&rc).unwrap()[0];
    assert_eq!(err_code(trash_restore(&rc, &entry.operation_id, None)), "FILE_CONFLICT");
    let r = trash_restore(&rc, &entry.operation_id, Some("DirA/c-restored.md")).unwrap();
    assert_eq!(r.restored_path, "DirA/c-restored.md");
    assert_eq!(fs::read_to_string(root.join("DirA/c-restored.md")).unwrap(), "c-content");
    assert_eq!(fs::read_to_string(root.join("DirA/c.md")).unwrap(), "new-占用"); // 现存文件未被动

    // 非法 trash_id
    assert_eq!(
        err_code(trash_restore(&rc, "../../etc", None)),
        "PATH_REJECTED"
    );
    close_workspace().unwrap();
}

#[test]
fn delete_carries_draft_to_trash_and_back() {
    let _g = serial();
    let root = temp_root("draft");
    fs::write(root.join("d.md"), "disk").unwrap();
    open_workspace(&root_str(&root)).unwrap();
    let rc = active_root().unwrap();
    let rs = root_str(&root);

    draft_write(&rs, "d.md", "draft-草稿", "LF", false, "hash-x").unwrap();
    assert!(draft_read(&rs, "d.md").unwrap().exists);
    delete_path(&rc, "d.md").unwrap();
    // 草稿已随删除进入回收站
    assert!(!draft_read(&rs, "d.md").unwrap().exists);
    let entry = &trash_list(&rc).unwrap()[0];
    trash_restore(&rc, &entry.operation_id, None).unwrap();
    let d = draft_read(&rs, "d.md").unwrap();
    assert!(d.exists);
    assert_eq!(d.text.unwrap(), "draft-草稿");
    close_workspace().unwrap();
}

#[test]
fn move_migrates_leftover_draft() {
    let _g = serial();
    let root = temp_root("movedraft");
    fs::write(root.join("a.md"), "disk").unwrap();
    open_workspace(&root_str(&root)).unwrap();
    let rc = active_root().unwrap();
    let rs = root_str(&root);

    draft_write(&rs, "a.md", "draft", "LF", false, "h").unwrap();
    move_path(&rc, "a.md", "b.md").unwrap();
    assert!(!draft_read(&rs, "a.md").unwrap().exists);
    let d = draft_read(&rs, "b.md").unwrap();
    assert!(d.exists);
    assert_eq!(d.text.unwrap(), "draft");
    close_workspace().unwrap();
}

#[test]
fn thousand_file_tree_is_usable() {
    let _g = serial();
    let root = temp_root("thousand");
    for d in 0..100 {
        let dir = root.join(format!("d{d:02}"));
        fs::create_dir_all(&dir).unwrap();
        for f in 0..10 {
            fs::write(dir.join(format!("note{d:02}x{f}.md")), format!("note {d}-{f}")).unwrap();
        }
    }
    open_workspace(&root_str(&root)).unwrap();
    let rc = active_root().unwrap();

    let start = SystemTime::now();
    let top = list_dir(&rc, "").unwrap();
    assert_eq!(top.len(), 100);
    assert!(top.iter().all(|e| e.is_dir));
    let mut total = 0usize;
    for e in &top {
        total += list_dir(&rc, &e.relative_path).unwrap().len();
    }
    assert_eq!(total, 1000);
    let hits = filter_files(&rc, "note05x5", 200).unwrap();
    assert_eq!(hits, vec!["d05/note05x5.md".to_string()]);
    let elapsed = start.elapsed().unwrap().as_millis();
    println!("1000 文件树枚举+过滤耗时 {elapsed}ms");
    assert!(elapsed < 10_000, "性能冒烟超出预算：{elapsed}ms");

    // 大目录删除/恢复往返
    delete_path(&rc, "d05").unwrap();
    assert!(!root.join("d05").exists());
    let entry = &trash_list(&rc).unwrap()[0];
    trash_restore(&rc, &entry.operation_id, None).unwrap();
    assert!(root.join("d05/note05x5.md").exists());
    close_workspace().unwrap();
}
