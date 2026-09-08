//! 原生命令的类型化错误协议（设计 §14.1）。
//! 错误消息面向用户，不含正文内容；`code` 是 UI 分支依据。

use serde::Serialize;

pub const PATH_REJECTED: &str = "PATH_REJECTED";
pub const FILE_NOT_FOUND: &str = "FILE_NOT_FOUND";
pub const FILE_CONFLICT: &str = "FILE_CONFLICT";
pub const ACCESS_DENIED: &str = "ACCESS_DENIED";
pub const FILE_BUSY: &str = "FILE_BUSY";
pub const DISK_FULL: &str = "DISK_FULL";
pub const UNSUPPORTED_ENCODING: &str = "UNSUPPORTED_ENCODING";
pub const FILE_TOO_LARGE: &str = "FILE_TOO_LARGE";
pub const VERIFY_FAILED: &str = "VERIFY_FAILED";
pub const IO_ERROR: &str = "IO_ERROR";
/// M2 新增：尚未打开/激活任何 Workspace（§14.1 表的扩展，记录于 M2_NOTES）
pub const WORKSPACE_NOT_OPEN: &str = "WORKSPACE_NOT_OPEN";
/// M2 新增：Workspace 已被其他实例锁定（§14.1 表的扩展，记录于 M2_NOTES）
pub const WORKSPACE_LOCKED: &str = "WORKSPACE_LOCKED";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl HostError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            operation_id: None,
            path: None,
        }
    }

    pub fn with_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub fn with_op(mut self, op: impl Into<String>) -> Self {
        self.operation_id = Some(op.into());
        self
    }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for HostError {}

pub type HostResult<T> = Result<T, HostError>;

/// 将底层 IO 错误映射为 §14.1 的错误码。
/// Windows 原生错误：5 拒绝访问、32 共享冲突（文件占用）、112 磁盘满。
pub fn map_io_error(err: &std::io::Error, path: Option<String>) -> HostError {
    let code = match err.raw_os_error() {
        Some(2) | Some(3) => FILE_NOT_FOUND,
        Some(5) => ACCESS_DENIED,
        Some(32) => FILE_BUSY,
        Some(112) => DISK_FULL,
        _ => IO_ERROR,
    };
    let mut e = HostError::new(code, format!("文件系统错误：{err}"));
    if let Some(p) = path {
        e = e.with_path(p);
    }
    e
}
