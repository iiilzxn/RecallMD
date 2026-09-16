//! 最近打开的 Workspace 列表（设计 §7.1：存 Tauri 应用配置目录，不存库内）。
//! Windows 真实配置路径由 Tauri 获取，不硬编码用户名。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::error::{HostError, HostResult, IO_ERROR};
use super::util::{now_ms, write_file_atomic};

const RECENT_FILE: &str = "recent-workspaces.json";
const RECENT_CAP: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    /// 规范化根绝对路径
    pub root: String,
    pub workspace_id: Option<String>,
    /// 根文件夹名（列表展示）
    pub name: String,
    pub last_opened_at_ms: i64,
}

fn recents_path(cfg_dir: &Path) -> PathBuf {
    cfg_dir.join(RECENT_FILE)
}

/// 读取最近列表；缺失/损坏按空处理（不阻塞启动）
pub fn load_recents(cfg_dir: &Path) -> Vec<RecentEntry> {
    let Ok(text) = fs::read_to_string(recents_path(cfg_dir)) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_recents(cfg_dir: &Path, list: &[RecentEntry]) -> HostResult<()> {
    // 配置目录可能不存在（首次运行/清理后 Tauri 不会自动创建）：
    // 不建目录则 write_file_atomic 报 os error 3，最近列表永远写不进去
    fs::create_dir_all(cfg_dir).map_err(|e| {
        HostError::new(
            IO_ERROR,
            format!("配置目录创建失败：{e}（{}）", cfg_dir.display()),
        )
    })?;
    let json = serde_json::to_vec_pretty(list)
        .map_err(|e| HostError::new(IO_ERROR, format!("最近列表序列化失败：{e}")))?;
    write_file_atomic(&recents_path(cfg_dir), &json)
}

fn root_display_name(root: &str) -> String {
    Path::new(root)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| root.to_string())
}

/// 记录一次成功打开：去重（Windows 路径大小写不敏感）、置顶、截断
pub fn record_recent(cfg_dir: &Path, root: &str, workspace_id: &str) -> HostResult<Vec<RecentEntry>> {
    let mut list = load_recents(cfg_dir);
    list.retain(|e| !e.root.eq_ignore_ascii_case(root));
    list.insert(
        0,
        RecentEntry {
            root: root.to_string(),
            workspace_id: Some(workspace_id.to_string()),
            name: root_display_name(root),
            last_opened_at_ms: now_ms(),
        },
    );
    list.truncate(RECENT_CAP);
    save_recents(cfg_dir, &list)?;
    Ok(list)
}

/// 从最近列表移除一条
pub fn forget_recent(cfg_dir: &Path, root: &str) -> HostResult<Vec<RecentEntry>> {
    let mut list = load_recents(cfg_dir);
    list.retain(|e| !e.root.eq_ignore_ascii_case(root));
    save_recents(cfg_dir, &list)?;
    Ok(list)
}
