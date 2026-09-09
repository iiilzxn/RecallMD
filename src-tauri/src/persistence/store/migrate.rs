//! 有序 SQL 迁移（§12.1：`PRAGMA user_version`；迁移前备份，失败回滚）。
//! 规则（§14.3 L965）：高于程序支持版本 → 拒绝（Offline），禁止自动降级或建空库覆盖；
//! 迁移失败 → 回滚 + Offline（旧版本数据完好，不自动重建）。

use rusqlite::Connection;

use super::super::error::{HostError, HostResult, MIGRATION_FAILED};

/// 当前程序支持的 schema 版本
pub const APP_SCHEMA_VERSION: u32 = 1;

/// 有序迁移表：[(目标版本, 该版本的全部 DDL)]。只追加，不修改历史条目。
const MIGRATIONS: &[(u32, &str)] = &[(1, super::schema::DDL_V1)];

#[derive(Debug)]
pub struct MigrateOutcome {
    /// 本次实际应用的版本（空 = 已是最新）
    pub applied: Vec<u32>,
}

/// 迁移结果错误：均导致 Offline（调用方不得继续打开元数据写路径）
pub fn migration_failed(msg: impl Into<String>) -> HostError {
    HostError::new(MIGRATION_FAILED, msg.into())
}

/// sqlite_master 中是否存在用户表（区分“全新库”与“无版本号的旧库”）
fn has_user_tables(conn: &Connection) -> HostResult<bool> {
    let n: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' \
             AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| super::map_sqlite_error(&e, "sqlite_master"))?;
    Ok(n > 0)
}

pub fn read_user_version(conn: &Connection) -> HostResult<u32> {
    conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
        .map(|v| v.max(0) as u32)
        .map_err(|e| super::map_sqlite_error(&e, "user_version"))
}

/// 运行迁移。`pre_backup` 在每个将应用迁移的步骤前调用（仅当库非全新；
/// §14.2.3 迁移前备份），备份失败则该次迁移不执行。
pub fn run(
    conn: &mut Connection,
    pre_backup: &dyn Fn(&Connection) -> HostResult<()>,
) -> HostResult<MigrateOutcome> {
    let mut current = read_user_version(conn)?;
    if current > APP_SCHEMA_VERSION {
        return Err(migration_failed(format!(
            "知识库元数据由更新版本的 RecallMD 创建（schema v{current} > 本程序支持的 v{APP_SCHEMA_VERSION}），请先升级应用"
        )));
    }

    let fresh = !has_user_tables(conn)?;
    let mut applied = Vec::new();
    for (target, sql) in MIGRATIONS {
        let target = *target;
        if target <= current {
            continue;
        }
        if !fresh && applied.is_empty() {
            pre_backup(conn)?;
        }
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| super::map_sqlite_error(&e, "begin migration"))?;
        tx.execute_batch(sql)
            .map_err(|e| migration_failed(format!("迁移到 v{target} 失败（已回滚）：{e}")))?;
        tx.pragma_update(None, "user_version", target)
            .map_err(|e| migration_failed(format!("写入 schema 版本失败：{e}")))?;
        tx.commit()
            .map_err(|e| migration_failed(format!("提交迁移 v{target} 失败（已回滚）：{e}")))?;
        applied.push(target);
        current = target;
    }
    Ok(MigrateOutcome { applied })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn
    }

    #[test]
    fn fresh_install_applies_v1_once() {
        let mut conn = mem();
        let out = run(&mut conn, &|_| Ok(())).unwrap();
        assert_eq!(out.applied, vec![1]);
        assert_eq!(read_user_version(&conn).unwrap(), 1);
        // 重跑 = no-op
        let again = run(&mut conn, &|_| Ok(())).unwrap();
        assert!(again.applied.is_empty());
    }

    #[test]
    fn newer_version_is_rejected() {
        let mut conn = mem();
        run(&mut conn, &|_| Ok(())).unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
        let err = run(&mut conn, &|_| Ok(())).unwrap_err();
        assert_eq!(err.code, MIGRATION_FAILED);
    }
}
