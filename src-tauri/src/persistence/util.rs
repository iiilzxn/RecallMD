//! 持久化层共享小工具：时间、哈希、Windows 调用、同步/原子写入。

use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::error::*;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let out = h.finalize();
    let mut s = String::with_capacity(64);
    for b in out {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

pub fn to_wide(p: &Path) -> Vec<u16> {
    p.as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

/// 规范化绝对路径去掉 `\\?\` verbatim 前缀，用于展示与回传
pub fn display_path(canon: &Path) -> String {
    let s = canon.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(t) => t.to_string(),
        None => s.into_owned(),
    }
}

/// 把 windows API 错误映射为 §14.1 错误码（HRESULT 低 16 位即 Win32 错误码）
pub fn map_windows_error(err: &windows::core::Error, path: &Path) -> HostError {
    let win32 = (err.code().0 as u32) & 0xFFFF;
    let code = match win32 {
        2 | 3 => FILE_NOT_FOUND,
        5 => ACCESS_DENIED,
        32 => FILE_BUSY,
        87 => PATH_REJECTED,
        112 => DISK_FULL,
        183 => FILE_CONFLICT,
        _ => IO_ERROR,
    };
    HostError::new(code, format!("Windows 错误 {win32}：{err}"))
        .with_path(path.to_string_lossy().into_owned())
}

pub fn write_file_synced(path: &Path, bytes: &[u8]) -> HostResult<()> {
    let mut f = File::create(path)
        .map_err(|e| map_io_error(&e, Some(path.to_string_lossy().into_owned())))?;
    f.write_all(bytes)
        .map_err(|e| map_io_error(&e, Some(path.to_string_lossy().into_owned())))?;
    f.sync_all()
        .map_err(|e| map_io_error(&e, Some(path.to_string_lossy().into_owned())))?;
    Ok(())
}

/// 临时文件 + rename 的原子小写入（用于元数据 JSON）
pub fn write_file_atomic(path: &Path, bytes: &[u8]) -> HostResult<()> {
    let tmp = path.with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
    write_file_synced(&tmp, bytes)?;
    // Windows 上 fs::rename 语义为 MoveFileEx(REPLACE_EXISTING)，目标存在则替换
    std::fs::rename(&tmp, path)
        .map_err(|e| map_io_error(&e, Some(path.to_string_lossy().into_owned())))?;
    Ok(())
}

pub fn read_hash(path: &Path) -> HostResult<Option<String>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(sha256_hex(&bytes))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(map_io_error(&e, Some(path.to_string_lossy().into_owned()))),
    }
}

/// recovery 目录中的文件键：相对路径的稳定哈希
pub fn recovery_key(relative: &str) -> String {
    let norm = relative.replace('\\', "/").trim_start_matches('/').to_lowercase();
    sha256_hex(norm.as_bytes())
}
