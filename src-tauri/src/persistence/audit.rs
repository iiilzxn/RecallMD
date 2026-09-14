//! M7 定期核对（§13.3 L885）：60s 目录存在性/mtime/size 快查 + 10 分钟滚动
//! 内容 hash 校验（捕获 mtime 与大小都未变化的修改）。纯文件系统命令，
//! 不经 DB 线程；比对由 TS 编排（registry 已带 disk_mtime_at/byte_size/content_hash）。
//!
//! file_identity：卷序列号 + 文件索引（§13.5 L905 外部移动识别二级优先级；
//! 仅短期线索，不作永久身份）。

use serde::Serialize;

use super::error::{HostError, HostResult, IO_ERROR};
use super::workspace::enumerate_md;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditStatDto {
    pub rel: String,
    pub byte_size: u64,
    pub mtime_ms: i64,
    pub file_identity: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditHashDto {
    pub rel: String,
    pub hash: Option<String>,
    pub byte_size: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditHashWindowDto {
    pub total: usize,
    pub offset: usize,
    pub files: Vec<AuditHashDto>,
}

/// Windows 文件身份："卷序列号-文件索引"（打开句柄读属性；失败返回 None 不阻塞）
pub fn file_identity_of(abs: &std::path::Path) -> Option<String> {
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            OPEN_EXISTING,
        };
        let wide: Vec<u16> = abs.as_os_str().to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe {
            CreateFileW(
                PCWSTR::from_raw(wide.as_ptr()),
                windows::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS, // 目录/文件均可；此处只用于文件
                None,
            )
        }
        .ok()?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        let ok = unsafe { GetFileInformationByHandle(handle, &mut info) }.is_ok();
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };
        if !ok {
            return None;
        }
        if info.dwVolumeSerialNumber == 0 && info.nFileIndexHigh == 0 && info.nFileIndexLow == 0 {
            return None;
        }
        Some(format!(
            "{}-{:08x}{:016x}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow as u64
        ))
    }
    #[cfg(not(windows))]
    {
        let _ = abs;
        None
    }
}

fn stat_of(root: &std::path::Path, rel: &str) -> Option<AuditStatDto> {
    let abs = root.join(rel);
    let meta = std::fs::metadata(&abs).ok()?;
    if meta.is_dir() {
        return None;
    }
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(AuditStatDto {
        rel: rel.to_string(),
        byte_size: meta.len(),
        mtime_ms,
        file_identity: file_identity_of(&abs),
    })
}

/// 全量快速核对（60s 节拍）：仅 stat，不读内容
pub fn audit_quick(root_canon: &std::path::Path) -> HostResult<Vec<AuditStatDto>> {
    let all = enumerate_md(root_canon)?;
    let mut out = Vec::with_capacity(all.len());
    for rel in all {
        if let Some(s) = stat_of(root_canon, &rel) {
            out.push(s);
        }
    }
    Ok(out)
}

/// 滚动内容校验窗口（§13.3 L885 每 10 分钟一轮）：排序枚举的 [offset, offset+limit)
pub fn audit_hash_batch(
    root_canon: &std::path::Path,
    offset: usize,
    limit: usize,
) -> HostResult<AuditHashWindowDto> {
    let all = enumerate_md(root_canon)?;
    let total = all.len();
    let files = all
        .into_iter()
        .skip(offset)
        .take(limit)
        .filter_map(|rel| {
            let abs = root_canon.join(&rel);
            let meta = std::fs::metadata(&abs).ok()?;
            if meta.is_dir() {
                return None;
            }
            let hash = std::fs::read(&abs).ok().and_then(|bytes| {
                use sha2::Digest as _;
                let mut h = sha2::Sha256::new();
                h.update(&bytes);
                let out = h.finalize();
                Some(out.iter().map(|b| format!("{b:02x}")).collect::<String>())
            });
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            Some(AuditHashDto {
                rel,
                hash,
                byte_size: meta.len(),
                mtime_ms,
            })
        })
        .collect();
    Ok(AuditHashWindowDto { total, offset, files })
}

/// 校验相对路径在根内（命令层防线）
pub fn ensure_in_root(root: &std::path::Path, rel: &str) -> HostResult<()> {
    if rel.contains("..") || rel.starts_with('/') || rel.starts_with('\\') {
        return Err(HostError::new(IO_ERROR, "非法相对路径").with_path(rel));
    }
    let _ = root;
    Ok(())
}
