//! 路径安全边界（设计 §6.3 的 M1 基础版）。
//! Rust 侧只接受已激活根目录内的相对路径；拒绝 `..`、盘符/绝对路径、
//! NTFS ADS 冒号、结尾点/空格、Windows 保留名、reparse point 逃逸。

use std::fs;
use std::path::{Path, PathBuf};

use super::error::{map_io_error, HostError, HostResult, PATH_REJECTED};

pub const RECALLMD_DIR: &str = ".recallmd";

/// Windows 保留设备名（不含扩展名部分）
fn is_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("");
    let upper = stem.to_ascii_uppercase();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    RESERVED.contains(&upper.as_str())
}

/// 词法校验相对路径并拆成组件（不限制扩展名，文件/目录通用）。
/// 拒绝空段、`.`/`..`、反斜杠、绝对路径/盘符/ADS 冒号、结尾点/空格、
/// Windows 保留名、首段 `.recallmd`。
pub fn validate_entry_relative(relative: &str) -> HostResult<Vec<String>> {
    let rejected = |reason: &str| HostError::new(PATH_REJECTED, format!("路径被拒绝：{reason}"));

    if relative.is_empty() {
        return Err(rejected("路径为空"));
    }
    if relative.contains('\\') {
        return Err(rejected("不允许反斜杠，请使用 / 分隔"));
    }
    if relative.starts_with('/') || relative.contains(':') {
        return Err(rejected("不允许绝对路径、盘符或 NTFS 数据流"));
    }
    let mut parts = Vec::new();
    for seg in relative.split('/') {
        if seg.is_empty() {
            return Err(rejected("存在空路径段"));
        }
        if seg == "." || seg == ".." {
            return Err(rejected("不允许 . 或 .."));
        }
        if seg.ends_with('.') || seg.ends_with(' ') {
            return Err(rejected("段以点或空格结尾"));
        }
        if is_reserved_name(seg) {
            return Err(rejected("Windows 保留名"));
        }
        parts.push(seg.to_string());
    }
    if parts[0].eq_ignore_ascii_case(RECALLMD_DIR) {
        return Err(rejected("不能访问元数据目录 .recallmd"));
    }
    Ok(parts)
}

/// 校验用户相对路径并拆成组件。要求 `.md` 扩展（大小写不敏感）。
pub fn validate_relative_path(relative: &str) -> HostResult<Vec<String>> {
    let parts = validate_entry_relative(relative)?;
    let file_name = parts.last().unwrap();
    if !file_name.to_ascii_lowercase().ends_with(".md") {
        return Err(HostError::new(
            PATH_REJECTED,
            "路径被拒绝：仅支持 .md 文件",
        ));
    }
    Ok(parts)
}

/// 校验目录相对路径（目录树、新建目录、目录移动/删除用）。
pub fn validate_dir_relative(relative: &str) -> HostResult<Vec<String>> {
    validate_entry_relative(relative)
}

/// 解析并规范化根目录：必须存在、是目录、且不是符号链接/junction。
pub fn resolve_root(root: &str) -> HostResult<PathBuf> {
    let p = PathBuf::from(root);
    let meta = fs::symlink_metadata(&p)
        .map_err(|e| map_io_error(&e, Some(root.to_string())))?;
    if !meta.is_dir() {
        return Err(HostError::new(PATH_REJECTED, "根路径不是目录").with_path(root));
    }
    if meta.file_type().is_symlink() {
        // Windows 上 junction/symlink 的 reparse 点均在此暴露（§6.3：不遍历 reparse point）
        return Err(HostError::new(PATH_REJECTED, "根目录不能是符号链接或 junction").with_path(root));
    }
    p.canonicalize()
        .map_err(|e| map_io_error(&e, Some(root.to_string())))
}

/// 将校验后的组件拼进根。逐段检查已存在部分位于根内且不是 reparse point。
/// 返回 (绝对路径, 目标是否存在)。目标不存在时，其已存在的最深父目录已被核验。
pub fn join_and_check(root_canon: &Path, parts: &[String]) -> HostResult<(PathBuf, bool)> {
    let mut cur = root_canon.to_path_buf();
    let mut idx = 0usize;
    for (i, seg) in parts.iter().enumerate() {
        cur.push(seg);
        match fs::symlink_metadata(&cur) {
            Ok(m) => {
                if m.file_type().is_symlink() {
                    return Err(HostError::new(
                        PATH_REJECTED,
                        format!("路径段 `{seg}` 是符号链接/junction，已拒绝"),
                    ));
                }
                idx = i + 1;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // 剩余段已通过词法校验，直接拼接
                for seg2 in &parts[i + 1..] {
                    cur.push(seg2);
                }
                return Ok((cur, false));
            }
            Err(e) => return Err(map_io_error(&e, Some(cur.to_string_lossy().into_owned()))),
        }
    }
    Ok((cur, idx == parts.len()))
}

/// 元数据子目录（惰性创建）
pub fn recallmd_sub(root_canon: &Path, sub: &str) -> HostResult<PathBuf> {
    let dir = root_canon.join(RECALLMD_DIR).join(sub);
    fs::create_dir_all(&dir)
        .map_err(|e| map_io_error(&e, Some(dir.to_string_lossy().into_owned())))?;
    Ok(dir)
}
