//! 备份与恢复（§14.2）：每日 SQLite 在线备份（Backup API，不拷文件）、轮换、
//! DB 恢复、完整 Workspace 备份/恢复。仅验证通过的备份计入轮换保留。

use std::path::{Path, PathBuf};

use rusqlite::backup::Backup;
use rusqlite::Connection;

use super::super::error::{HostError, HostResult, DB_CORRUPT, DISK_FULL, FILE_CONFLICT, IO_ERROR, VERIFY_FAILED};
use super::super::util::{display_path, sha256_hex, write_file_atomic};
use super::schema;
use super::{map_sqlite_error, now_ms};

pub const BACKUP_DB_DIR: &str = "db"; // 留 7
pub const BACKUP_PREMIGRATION_DIR: &str = "premigration"; // 留 3
pub const KEEP_DAILY: usize = 7;
pub const KEEP_PREMIGRATION: usize = 3;

fn sqlx(e: &rusqlite::Error, ctx: &str) -> HostError {
    map_sqlite_error(e, ctx)
}

/// UTC 定宽文件名：字典序 = 时间序
pub fn backup_file_name(now_ms: i64) -> String {
    let iso = super::fsrs::iso8601_ms(now_ms).unwrap_or_default();
    iso.replace([':', '-'], "-").replace(".", "-")
        + ".sqlite"
}

// ---------------------------------------------------------------------------
// 本地日界（§14.2.3 "每天首次打开"按本地日）
// ---------------------------------------------------------------------------

/// Windows 本地日期 YYYY-MM-DD（GetLocalTime；无时区依赖）
pub fn local_today() -> String {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::GetLocalTime;
        let st = unsafe { GetLocalTime() };
        format!("{:04}-{:02}-{:02}", st.wYear, st.wMonth, st.wDay)
    }
    #[cfg(not(windows))]
    "1970-01-01".to_string()
}

// ---------------------------------------------------------------------------
// 单次备份 + 验证 + 轮换
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbBackupEntry {
    pub file_name: String,
    pub byte_size: u64,
    pub created_at_ms: i64,
}

/// Backup API 在线复制到 dst（全新连接），分页 16 页/250ms（§6.2）
fn online_backup_to(src: &Connection, dst_path: &Path) -> HostResult<()> {
    let mut dst = Connection::open(dst_path)
        .map_err(|e| sqlx(&e, "打开备份目标"))?;
    let backup = Backup::new(src, &mut dst).map_err(|e| sqlx(&e, "初始化在线备份"))?;
    backup
        .run_to_completion(16, std::time::Duration::from_millis(250), None)
        .map_err(|e| sqlx(&e, "在线备份"))?;
    drop(backup);
    dst.close().map_err(|(_, e)| sqlx(&e, "关闭备份目标"))?;
    Ok(())
}

/// 验证一个备份文件（quick_check + FK 检查 + 版本不超前）
pub fn verify_backup_file(path: &Path) -> HostResult<()> {
    let conn = Connection::open(path)
        .map_err(|e| sqlx(&e, "打开备份"))?;
    if !schema::quick_check_ok(&conn)? {
        return Err(HostError::new(DB_CORRUPT, "备份完整性检查未通过").with_path(display_path(path)));
    }
    if !schema::foreign_key_check_clean(&conn)? {
        return Err(HostError::new(DB_CORRUPT, "备份外键检查未通过").with_path(display_path(path)));
    }
    let v = super::migrate::read_user_version(&conn)?;
    if v > super::migrate::APP_SCHEMA_VERSION {
        return Err(HostError::new(
            DB_CORRUPT,
            format!("备份 schema v{v} 高于本版支持"),
        )
        .with_path(display_path(path)));
    }
    Ok(())
}

/// 做一份验证过的备份（tmp → 验证 → 原子改名），返回最终路径
pub fn create_verified_backup(src: &Connection, dir: &Path) -> HostResult<PathBuf> {
    std::fs::create_dir_all(dir)
        .map_err(|e| HostError::new(IO_ERROR, format!("创建备份目录失败：{e}")))?;
    let mut probe = now_ms();
    let final_path = loop {
        let candidate = dir.join(backup_file_name(probe));
        if !candidate.exists() {
            break candidate;
        }
        probe += 1; // 同名撞车（极小概率）：退让 1ms
    };
    let tmp_path = dir.join(format!("{}.tmp", backup_file_name(probe)));
    online_backup_to(src, &tmp_path)?;
    if let Err(e) = verify_backup_file(&tmp_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    std::fs::rename(&tmp_path, &final_path)
        .map_err(|e| HostError::new(DISK_FULL, format!("备份改名失败：{e}")))?;
    Ok(final_path)
}

/// 轮换：仅保留最近 keep 份 .sqlite（tmp 残留一并清理）；按名字降序
pub fn rotate_backups(dir: &Path, keep: usize) -> HostResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| HostError::new(IO_ERROR, format!("读取备份目录失败：{e}")))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "sqlite").unwrap_or(false))
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    names.sort();
    let excess = names.len().saturating_sub(keep);
    for name in &names[..excess] {
        let _ = std::fs::remove_file(dir.join(name));
    }
    // 清理残留 tmp
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            if e.path().extension().map(|x| x == "tmp" || x == "sqlite-tmp").unwrap_or(false) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(())
}

/// 每日首备（本地日）：Settings 记 marker；失败非致命（记 warning）
pub fn daily_backup_if_due(conn: &Connection, backups_root: &Path) -> HostResult<bool> {
    let today = local_today();
    let marker = super::query::settings_get(conn, "backup.daily.day")?;
    if marker.as_deref() == Some(today.as_str()) {
        return Ok(false);
    }
    let dir = backups_root.join(BACKUP_DB_DIR);
    let path = create_verified_backup(conn, &dir)?;
    rotate_backups(&dir, KEEP_DAILY)?;
    super::query::settings_set_string(conn, "backup.daily.day", &today, now_ms())?;
    let _ = path;
    Ok(true)
}

/// 迁移前备份（migrate.rs 回调）
pub fn premigration_backup(conn: &Connection, backups_root: &Path) -> HostResult<()> {
    let dir = backups_root.join(BACKUP_PREMIGRATION_DIR);
    create_verified_backup(conn, &dir)?;
    rotate_backups(&dir, KEEP_PREMIGRATION)?;
    Ok(())
}

/// 列出日备（新→旧）
pub fn list_daily_backups(backups_root: &Path) -> HostResult<Vec<DbBackupEntry>> {
    let dir = backups_root.join(BACKUP_DB_DIR);
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("sqlite") {
                continue;
            }
            let meta = match e.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            out.push(DbBackupEntry {
                file_name: e.file_name().to_string_lossy().into_owned(),
                byte_size: meta.len(),
                created_at_ms: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
            });
        }
    }
    out.sort_by(|a, b| b.file_name.cmp(&a.file_name));
    Ok(out)
}

// ---------------------------------------------------------------------------
// 完整 Workspace 备份（§14.2.4–5）
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullBackupResult {
    pub backup_dir: String,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifestFile {
    path: String,
    sha256: String,
    byte_size: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    format_version: u32,
    workspace_id: String,
    created_at_ms: i64,
    schema_version: u32,
    files: Vec<BackupManifestFile>,
    db: BackupManifestFile,
}

fn copy_verified(src: &Path, dst: &Path) -> HostResult<BackupManifestFile> {
    let bytes = std::fs::read(src)
        .map_err(|e| HostError::new(IO_ERROR, format!("读取失败：{e}")).with_path(display_path(src)))?;
    let before = sha256_hex(&bytes);
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| HostError::new(IO_ERROR, format!("创建目录失败：{e}")))?;
    }
    std::fs::write(dst, &bytes)
        .map_err(|e| HostError::new(IO_ERROR, format!("写入失败：{e}")).with_path(display_path(dst)))?;
    let written = std::fs::read(dst)
        .map_err(|e| HostError::new(IO_ERROR, format!("回读失败：{e}")).with_path(display_path(dst)))?;
    let after = sha256_hex(&written);
    if before != after {
        return Err(HostError::new(
            VERIFY_FAILED,
            "备份复制前后哈希不一致（外部程序修改？）",
        )
        .with_path(display_path(src)));
    }
    Ok(BackupManifestFile {
        path: String::new(),
        sha256: after,
        byte_size: bytes.len() as u64,
    })
}

/// 完整备份：正文/资源 + manifest + 一致性 SQLite 备份 + 未解决恢复/操作材料。
/// 排除 backups/、workspace.lock、SQLite sidecar；manifest.json 最后原子写入才算成功。
/// 不覆写既有目标（create-new 语义，§14.2 L959）。
pub fn backup_full(
    conn: &Connection,
    root_canon: &Path,
    workspace_id: &str,
    target_dir: &Path,
) -> HostResult<FullBackupResult> {
    let now = now_ms();
    let name = format!(
        "RecallMD-backup-{}-{}",
        &workspace_id.get(..8).unwrap_or(workspace_id),
        backup_file_name(now).trim_end_matches(".sqlite")
    );
    let backup_root = target_dir.join(name);
    if backup_root.exists() {
        return Err(HostError::new(
            FILE_CONFLICT,
            "同名备份已存在，不无提示覆写",
        )
        .with_path(display_path(&backup_root)));
    }
    let files_dir = backup_root.join("files");
    let recallmd_dir = root_canon.join(super::super::paths::RECALLMD_DIR);

    let mut files: Vec<BackupManifestFile> = Vec::new();
    let mut total_bytes = 0u64;

    // 1. 正文与资源（根下除 .recallmd 外全部物理文件）
    walk_files(root_canon, &mut |abs| {
        if abs.starts_with(&recallmd_dir) {
            return Ok(());
        }
        let rel = abs.strip_prefix(root_canon).unwrap_or(abs);
        let dst = files_dir.join(rel);
        let entry = copy_verified(abs, &dst)?;
        let mut e = entry;
        e.path = rel.to_string_lossy().replace('\\', "/");
        total_bytes += e.byte_size;
        files.push(e);
        Ok(())
    })?;

    // 2. manifest 与未解决材料
    let mut meta_files = 0usize;
    let recallmd_backup = backup_root.join("recallmd");
    for sub in ["workspace.json", "recovery", "operations", "trash"] {
        let src = recallmd_dir.join(sub);
        if !src.exists() {
            continue;
        }
        let dst = recallmd_backup.join(sub);
        if src.is_dir() {
            walk_files(&src, &mut |abs| {
                let rel = abs.strip_prefix(&src).unwrap_or(abs);
                copy_verified(abs, &dst.join(rel))?;
                meta_files += 1;
                Ok(())
            })?;
        } else {
            copy_verified(&src, &dst)?;
            meta_files += 1;
        }
    }

    // 3. 一致性 SQLite 备份（Backup API）
    let db_dst = backup_root.join("db").join(super::METADATA_DB);
    std::fs::create_dir_all(db_dst.parent().unwrap())
        .map_err(|e| HostError::new(IO_ERROR, format!("创建目录失败：{e}")))?;
    online_backup_to(conn, &db_dst)?;
    verify_backup_file(&db_dst)?;
    let db_bytes = std::fs::read(&db_dst)
        .map_err(|e| HostError::new(IO_ERROR, format!("读取备份库失败：{e}")))?;
    let db_entry = BackupManifestFile {
        path: "db/metadata.sqlite".into(),
        sha256: sha256_hex(&db_bytes),
        byte_size: db_bytes.len() as u64,
    };

    // 4. manifest 原子收尾——存在即成功（§14.2.5）
    let db_bytes_len = db_entry.byte_size;
    let manifest = BackupManifest {
        format_version: 1,
        workspace_id: workspace_id.to_string(),
        created_at_ms: now,
        schema_version: super::migrate::APP_SCHEMA_VERSION,
        files,
        db: db_entry,
    };
    let file_count = manifest_files_count(&manifest);
    let json = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| HostError::new(IO_ERROR, format!("备份清单序列化失败：{e}")))?;
    write_file_atomic(&backup_root.join("manifest.json"), &json)?;

    Ok(FullBackupResult {
        backup_dir: display_path(&backup_root),
        file_count: file_count + meta_files,
        total_bytes: total_bytes + db_bytes_len,
    })
}

fn manifest_files_count(m: &BackupManifest) -> usize {
    m.files.len() + 1
}

fn walk_files(dir: &Path, f: &mut dyn FnMut(&Path) -> HostResult<()>) -> HostResult<()> {
    let rd = std::fs::read_dir(dir)
        .map_err(|e| HostError::new(IO_ERROR, format!("枚举失败 {dir:?}：{e}")))?;
    for entry in rd.filter_map(|e| e.ok()) {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        // 排除运行锁/临时 SQLite sidecar/备份目录（防递归备份自己）
        if name == "workspace.lock"
            || name == "metadata.sqlite-wal"
            || name == "metadata.sqlite-shm"
            || name.ends_with(".recallmd-tmp")
        {
            continue;
        }
        let meta = match std::fs::symlink_metadata(&p) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_symlink() {
            continue; // 不跟随 reparse point
        }
        if meta.is_dir() {
            if name == "backups" && p.ends_with(format!(
                "{}{}backups",
                super::super::paths::RECALLMD_DIR,
                std::path::MAIN_SEPARATOR
            )) {
                continue;
            }
            walk_files(&p, f)?;
        } else {
            f(&p)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 完整恢复（verify-first）
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullRestoreResult {
    pub target_root: String,
    pub file_count: usize,
}

/// 从完整备份恢复到全新目标目录：先验全部清单哈希与 DB，再复制；绝不覆写非空目标
pub fn backup_full_restore(backup_dir: &Path, target_root: &Path) -> HostResult<FullRestoreResult> {
    let manifest_path = backup_dir.join("manifest.json");
    if !manifest_path.exists() {
        return Err(HostError::new(
            FILE_CONFLICT,
            "目标不是有效完整备份（缺 manifest.json）",
        )
        .with_path(display_path(backup_dir)));
    }
    if target_root.exists() && std::fs::read_dir(target_root).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(HostError::new(
            FILE_CONFLICT,
            "恢复目标目录须为空或不存在（不覆写）",
        )
        .with_path(display_path(target_root)));
    }
    let raw = std::fs::read(&manifest_path)
        .map_err(|e| HostError::new(IO_ERROR, format!("读取清单失败：{e}")))?;
    let manifest: serde_json::Value = serde_json::from_slice(&raw)
        .map_err(|e| HostError::new(DB_CORRUPT, format!("清单损坏：{e}")))?;

    // verify-first：全部文件哈希 + DB 检查
    let file_list = manifest["files"].as_array().cloned().unwrap_or_default();
    let mut count = 0usize;
    for item in &file_list {
        let rel = item["path"].as_str().unwrap_or_default();
        let expect = item["sha256"].as_str().unwrap_or_default();
        if rel.is_empty() || rel.contains("..") || rel.starts_with('/') {
            return Err(HostError::new(VERIFY_FAILED, format!("清单路径非法：{rel}")));
        }
        let src = backup_dir.join("files").join(rel.replace('\\', "/"));
        let bytes = std::fs::read(&src)
            .map_err(|e| HostError::new(IO_ERROR, format!("读取备份文件失败：{e}")).with_path(rel))?;
        if sha256_hex(&bytes) != expect {
            return Err(HostError::new(
                VERIFY_FAILED,
                "备份文件哈希与清单不符（备份被改动？）",
            )
            .with_path(rel));
        }
        count += 1;
    }
    let db_src = backup_dir.join("db").join(super::METADATA_DB);
    verify_backup_file(&db_src)?;

    // 复制
    for item in &file_list {
        let rel = item["path"].as_str().unwrap_or_default();
        let src = backup_dir.join("files").join(rel.replace('\\', "/"));
        let dst = target_root.join(rel.replace('\\', "/"));
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| HostError::new(IO_ERROR, format!("创建目录失败：{e}")))?;
        }
        std::fs::copy(&src, &dst)
            .map_err(|e| HostError::new(IO_ERROR, format!("复制失败：{e}")).with_path(rel))?;
    }
    // .recallmd 材料（manifest/trash/recovery/operations）原样还原 + DB
    let src_recallmd = backup_dir.join("recallmd");
    if src_recallmd.exists() {
        walk_files(&src_recallmd, &mut |abs| {
            let rel = abs.strip_prefix(&src_recallmd).unwrap_or(abs);
            let dst = target_root.join(super::super::paths::RECALLMD_DIR).join(rel);
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| HostError::new(IO_ERROR, format!("创建目录失败：{e}")))?;
            }
            std::fs::copy(abs, &dst)
                .map_err(|e| HostError::new(IO_ERROR, format!("复制失败：{e}")))?;
            Ok(())
        })?;
    }
    let db_dst = target_root.join(super::super::paths::RECALLMD_DIR).join(super::METADATA_DB);
    std::fs::create_dir_all(db_dst.parent().unwrap())
        .map_err(|e| HostError::new(IO_ERROR, format!("创建目录失败：{e}")))?;
    std::fs::copy(&db_src, &db_dst)
        .map_err(|e| HostError::new(IO_ERROR, format!("复制数据库失败：{e}")))?;

    Ok(FullRestoreResult {
        target_root: display_path(target_root),
        file_count: count,
    })
}
