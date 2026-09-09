//! M1 保存协议集成测试（设计 §13.2/§14.1）。
//! 直接调用库函数，覆盖：读取检测、快乐路径、哈希冲突、新文件协议、
//! 文件占用、回读校验后的清理、草稿生命周期。

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use recallmd_lib::persistence::document::{
    draft_discard, draft_read, draft_write, read_document, save_document, stat_document,
    SaveDocumentParams, HASH_ABSENT,
};
use recallmd_lib::persistence::error::HostError;
use windows::core::PCWSTR;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ACCESS_RIGHTS, FILE_SHARE_MODE, OPEN_EXISTING,
};

fn temp_root(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("recallmd-m1-{tag}-{nanos}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn params(text: &str, eol: &str, add_bom: bool, expected: &str) -> SaveDocumentParams {
    SaveDocumentParams {
        text: text.to_string(),
        eol: eol.to_string(),
        add_bom,
        expected_hash: expected.to_string(),
    }
}

/// 64 个 0 的假哈希，用于构造 expectedHash 不匹配
const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn sha256_file(path: &PathBuf) -> String {
    read_document_hash(path)
}

fn read_document_hash(path: &PathBuf) -> String {
    use sha2::{Digest, Sha256};
    // 测试无法依赖主 crate 私有工具，重复一份最小实现
    let bytes = fs::read(path).unwrap();
    let mut h = Sha256::new();
    h.update(bytes);
    let out = h.finalize();
    out.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn read_detects_bom_eol_and_hash() {
    let root = temp_root("read");
    fs::write(root.join("a.md"), b"\xEF\xBB\xBF# T\r\n\r\nline1\r\nline2").unwrap();
    let r = read_document(root.to_str().unwrap(), "a.md").unwrap();
    assert!(r.has_bom);
    assert_eq!(r.line_ending, "CRLF");
    assert_eq!(r.text, "# T\n\nline1\nline2");
    assert_eq!(r.byte_size, 22);

    fs::write(root.join("b.md"), b"one\ntwo").unwrap();
    let r = read_document(root.to_str().unwrap(), "b.md").unwrap();
    assert!(!r.has_bom);
    assert_eq!(r.line_ending, "LF");

    fs::write(root.join("c.md"), b"one\r\ntwo\n").unwrap();
    let r = read_document(root.to_str().unwrap(), "c.md").unwrap();
    assert_eq!(r.line_ending, "MIXED");
    assert_eq!(r.text, "one\ntwo\n");
}

#[test]
fn read_rejects_non_utf8() {
    let root = temp_root("enc");
    fs::write(root.join("gbk.md"), [0xD6, 0xD0, 0xCE, 0xC4]).unwrap();
    let e = read_document(root.to_str().unwrap(), "gbk.md").unwrap_err();
    assert_eq!(e.code, "UNSUPPORTED_ENCODING");
}

#[test]
fn path_validation_rejects_escape() {
    let root = temp_root("path");
    let cases = [
        "../escape.md",
        "a/../../x.md",
        "C:/abs.md",
        ".recallmd/meta.md",
        "sub/CON.md",
        "notes.md ",
        "doc.txt",
    ];
    // 结尾空格等用例保持原样传入，不做 trim
    for c in cases {
        let e = read_document(root.to_str().unwrap(), c).unwrap_err();
        assert_eq!(e.code, "PATH_REJECTED", "应拒绝：{c}");
    }
}

#[test]
fn save_happy_path_roundtrip_and_cleanup() {
    let root = temp_root("save");
    let file = root.join("note.md");
    fs::write(&file, "# 旧内容\n").unwrap();
    let base = read_document(root.to_str().unwrap(), "note.md").unwrap();

    // 留下一个过期草稿，保存成功后应被清除
    draft_write(
        root.to_str().unwrap(),
        "note.md",
        "草稿正文",
        "LF",
        false,
        "deadbeef",
    )
    .unwrap();

    let r = save_document(
        root.to_str().unwrap(),
        "note.md",
        params("# 新内容\n中文段落。\n", "LF", false, &base.raw_byte_hash),
    )
    .unwrap();

    assert_eq!(sha256_file(&file), r.committed_hash);
    assert_eq!(fs::read_to_string(&file).unwrap(), "# 新内容\n中文段落。\n");
    // base 副本保留旧版
    let recovery = root.join(".recallmd").join("recovery");
    assert!(recovery.exists());
    // 候选与操作日志已清理；草稿已清除
    let left: Vec<String> = fs::read_dir(&recovery)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        !left.iter().any(|f| f.contains("candidate")),
        "候选应被清理：{left:?}"
    );
    let ops = root.join(".recallmd").join("operations");
    // M4 起：日志保留在 FILE_COMMITTED，索引事务确认后才删除（§13.2 L847）
    let op_files: Vec<String> = fs::read_dir(&ops)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(op_files.len(), 1, "保存后操作日志应在：{op_files:?}");
    let log_raw = fs::read(ops.join(&op_files[0])).unwrap();
    let log: serde_json::Value = serde_json::from_slice(&log_raw).unwrap();
    assert_eq!(log["phase"], "FILE_COMMITTED");
    recallmd_lib::persistence::document::index_complete(root.to_str().unwrap(), &r.operation_id)
        .unwrap();
    assert_eq!(
        fs::read_dir(&ops).unwrap().count(),
        0,
        "索引确认后操作日志应被清理"
    );
    // 幂等：重复确认不再报错
    recallmd_lib::persistence::document::index_complete(root.to_str().unwrap(), &r.operation_id)
        .unwrap();
    let d = draft_read(root.to_str().unwrap(), "note.md").unwrap();
    assert!(!d.exists);

    // 再保存一轮：备份应等于上一版
    let r2 = save_document(
        root.to_str().unwrap(),
        "note.md",
        params("# 第三版\n", "LF", false, &r.committed_hash),
    )
    .unwrap();
    let backup = fs::read_dir(&recovery)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .contains("backup")
        })
        .expect("应存在备份文件");
    assert_eq!(
        fs::read_to_string(&backup).unwrap(),
        "# 新内容\n中文段落。\n",
        "备份必须是上一版内容"
    );
    assert_eq!(r2.committed_hash, sha256_file(&file));
}

#[test]
fn save_preserves_crlf_and_bom() {
    let root = temp_root("eol");
    fs::write(root.join("win.md"), b"\xEF\xBB\xBF# T\r\nbody").unwrap();
    let base = read_document(root.to_str().unwrap(), "win.md").unwrap();
    save_document(
        root.to_str().unwrap(),
        "win.md",
        params("# T\n新 body", "CRLF", true, &base.raw_byte_hash),
    )
    .unwrap();
    let bytes = fs::read(root.join("win.md")).unwrap();
    assert_eq!(bytes, b"\xEF\xBB\xBF# T\r\n\xE6\x96\xB0 body".to_vec());
    // stat 与 read 的哈希一致
    let st = stat_document(root.to_str().unwrap(), "win.md").unwrap();
    assert_eq!(st.raw_byte_hash.unwrap(), sha256_file(&root.join("win.md")));
}

#[test]
fn save_conflict_keeps_original_and_candidate() {
    let root = temp_root("conflict");
    let file = root.join("note.md");
    fs::write(&file, "v1").unwrap();

    let e = save_document(
        root.to_str().unwrap(),
        "note.md",
        params("local v2", "LF", false, ZERO_HASH),
    )
    .unwrap_err();
    assert_eq!(e.code, "FILE_CONFLICT");
    // 原文未动；候选保留在 recovery（§14.4：替换前被改写 → 两版保留）
    assert_eq!(fs::read_to_string(&file).unwrap(), "v1");
    let recovery = root.join(".recallmd").join("recovery");
    let candidate = fs::read_dir(&recovery)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.file_name().unwrap().to_string_lossy().contains("candidate"))
        .expect("冲突时也必须保留候选副本");
    assert_eq!(fs::read_to_string(&candidate).unwrap(), "local v2");
}

#[test]
fn new_file_protocol_rejects_overwrite() {
    let root = temp_root("newfile");
    // ABSENT + 目标不存在 → 创建成功
    let r = save_document(
        root.to_str().unwrap(),
        "fresh.md",
        params("# 新建\n", "LF", false, HASH_ABSENT),
    )
    .unwrap();
    assert!(root.join("fresh.md").exists());
    // 再次以 ABSENT 保存同一路径 → 拒绝覆盖
    let e = save_document(
        root.to_str().unwrap(),
        "fresh.md",
        params("# 又一次\n", "LF", false, HASH_ABSENT),
    )
    .unwrap_err();
    assert_eq!(e.code, "FILE_CONFLICT");
    assert_eq!(fs::read_to_string(root.join("fresh.md")).unwrap(), "# 新建\n");
    let _ = r;
}

#[test]
fn save_missing_file_reports_conflict() {
    let root = temp_root("missing");
    fs::write(root.join("gone.md"), "x").unwrap();
    let base = read_document(root.to_str().unwrap(), "gone.md").unwrap();
    fs::remove_file(root.join("gone.md")).unwrap();
    let e = save_document(
        root.to_str().unwrap(),
        "gone.md",
        params("y", "LF", false, &base.raw_byte_hash),
    )
    .unwrap_err();
    assert_eq!(e.code, "FILE_CONFLICT");
    assert!(e.message.contains("删除或移动"));
}

#[test]
fn occupied_file_fails_with_file_busy_and_preserves_original() {
    let root = temp_root("busy");
    let file = root.join("locked.md");
    fs::write(&file, "占用中的内容").unwrap();
    let base = read_document(root.to_str().unwrap(), "locked.md").unwrap();

    // 以零共享模式独占打开目标：ReplaceFileW 应遇共享冲突（Win32 32）
    let wide: Vec<u16> = file
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let handle: HANDLE = unsafe {
        CreateFileW(
            PCWSTR::from_raw(wide.as_ptr()),
            0x8000_0000,        // GENERIC_READ
            FILE_SHARE_MODE(1), // 仅共享读：读取核验可通过，ReplaceFileW 的删除访问被拒
            None,
            OPEN_EXISTING,
            Default::default(),
            None,
        )
        .unwrap()
    };

    let e = save_document(
        root.to_str().unwrap(),
        "locked.md",
        params("想覆盖", "LF", false, &base.raw_byte_hash),
    )
    .unwrap_err();
    // 释放占用
    unsafe {
        let _ = windows::Win32::Foundation::CloseHandle(handle);
    };
    assert_eq!(e.code, "FILE_BUSY", "实际错误：{e}");
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "占用中的内容",
        "占用失败时原文必须原样"
    );
    // 候选副本留存，用户可稍后重试或另存
    let recovery = root.join(".recallmd").join("recovery");
    assert!(fs::read_dir(&recovery).unwrap().count() >= 1);
}

#[test]
fn draft_lifecycle() {
    let root = temp_root("draft");
    fs::write(root.join("d.md"), "盘上内容").unwrap();
    let base = read_document(root.to_str().unwrap(), "d.md").unwrap();

    draft_write(
        root.to_str().unwrap(),
        "d.md",
        "未保存的草稿",
        "LF",
        false,
        &base.raw_byte_hash,
    )
    .unwrap();
    let info = draft_read(root.to_str().unwrap(), "d.md").unwrap();
    assert!(info.exists);
    assert_eq!(info.text.unwrap(), "未保存的草稿");
    assert_eq!(info.source_hash.unwrap(), base.raw_byte_hash);

    draft_discard(root.to_str().unwrap(), "d.md").unwrap();
    let info = draft_read(root.to_str().unwrap(), "d.md").unwrap();
    assert!(!info.exists);
}

#[test]
fn error_shape_is_typed() {
    let root = temp_root("shape");
    let e = read_document(root.to_str().unwrap(), "不存在.md").unwrap_err();
    assert_eq!(e.code, "FILE_NOT_FOUND");
    assert!(e.path.is_some());
    let _: HostError = e; // 类型稳定
}
