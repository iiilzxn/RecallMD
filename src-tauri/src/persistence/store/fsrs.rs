//! 冻结的算法身份与初始状态模板（设计 §11.2/ADR-006、§10.2 L394）。
//!
//! 锁定 `ts-fsrs@5.4.2 (FSRS-6.0)`。`config_json` 是 §11.2 全部值的展开
//! （对已装库 generatorParameters 实测核对：默认 maximum_interval=36500 须覆写为 3650，
//! w 为 21 值 FSRS-6 默认——"保存实际数值而非字符串 default"）。
//! `state_json` 与库 `createEmptyCard().toJSON()` 输出逐键一致：
//! 无 last_review 键（未评分卡序列化时该键不存在）；due 为 ISO-8601 毫秒精度。
//! M5 adapter 必须能往返该形状（vitest 契约测试钉住）；改此模板须升 state_schema_version。

use std::fmt::Write as _;

use crate::persistence::error::{HostError, HostResult, INDEX_FAILED};

pub const ALGORITHM_ID: &str = "fsrs";
pub const ALGORITHM_VERSION: &str = "ts-fsrs@5.4.2+FSRS-6.0";
pub const STATE_SCHEMA_VERSION: i64 = 1;

/// 首次提醒提前量：登记后 24h（§10.2 L394 产品策略，非 FSRS 推导值）
pub const FIRST_DUE_OFFSET_MS: i64 = 24 * 60 * 60 * 1000;

/// §11.2 第一版调度配置（键序对齐 ts-fsrs generatorParameters 输出）
pub const CONFIG_JSON: &str = "{\"request_retention\":0.9,\"maximum_interval\":3650,\
\"w\":[0.212,1.2931,2.3065,8.2956,6.4133,0.8334,3.0194,0.001,1.8722,0.1666,0.796,1.4835,\
0.0614,0.2629,1.6483,0.6014,1.8729,0.5425,0.0912,0.0658,0.1542],\"enable_fuzz\":false,\
\"enable_short_term\":true,\"learning_steps\":[\"1m\",\"10m\"],\"relearning_steps\":[\"10m\"]}";

/// 新登记 Block 的空算法状态（due = scheduled_due_at，§10.2 L394）。
/// 逐键对齐 ts-fsrs createEmptyCard 输出：state 0 = New。
pub fn empty_card_state_json(due_ms: i64) -> HostResult<String> {
    let iso = iso8601_ms(due_ms)?;
    Ok(format!(
        "{{\"due\":\"{iso}\",\"stability\":0,\"difficulty\":0,\"elapsed_days\":0,\
          \"scheduled_days\":0,\"reps\":0,\"lapses\":0,\"learning_steps\":0,\"state\":0}}"
    ))
}

/// epoch 毫秒 → `YYYY-MM-DDTHH:MM:SS.mmmZ`（无时区依赖，UTC 固定格式；
/// ts-fsrs 用 Date.toJSON 输出同款格式）
pub fn iso8601_ms(ms: i64) -> HostResult<String> {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    let mut out = String::with_capacity(24);
    let _ = write!(
        out,
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    );
    Ok(out)
}

/// 天数 → 公历日期（Howard Hinnant civil_from_days，1970-03-01 起算的循环不变式）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// ISO 字符串 → epoch 毫秒（M5 读取状态时使用；对称实现）
pub fn parse_iso8601_ms(s: &str) -> HostResult<i64> {
    let err = || {
        HostError::new(
            INDEX_FAILED,
            format!("算法状态 due 不是合法 ISO-8601：{s}"),
        )
    };
    let bytes = s.as_bytes();
    if bytes.len() != 24 || bytes[10] != b'T' || bytes[19] != b'.' || bytes[23] != b'Z' {
        return Err(err());
    }
    let num = |from: usize, to: usize| -> HostResult<i64> {
        s[from..to]
            .parse::<i64>()
            .map_err(|_| err())
    };
    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let minute = num(14, 16)?;
    let second = num(17, 19)?;
    let millis = num(20, 23)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(err());
    }
    let days = days_from_civil(year, month as u32, day as u32);
    Ok(days * 86_400_000 + (hour * 3_600 + minute * 60 + second) * 1000 + millis)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_roundtrip_matches_known_values() {
        assert_eq!(iso8601_ms(1_700_000_000_000).unwrap(), "2023-11-14T22:13:20.000Z");
        assert_eq!(iso8601_ms(0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(parse_iso8601_ms("2023-11-14T22:13:20.000Z").unwrap(), 1_700_000_000_000);
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00.000Z").unwrap(), 0);
    }

    #[test]
    fn empty_card_matches_library_shape() {
        let json = empty_card_state_json(1_700_000_000_000).unwrap();
        // 与 ts-fsrs createEmptyCard().toJSON() 逐键一致（无 last_review 键）
        assert_eq!(
            json,
            "{\"due\":\"2023-11-14T22:13:20.000Z\",\"stability\":0,\"difficulty\":0,\
             \"elapsed_days\":0,\"scheduled_days\":0,\"reps\":0,\"lapses\":0,\
             \"learning_steps\":0,\"state\":0}"
        );
        // 合法 JSON（SQLite json_valid 通过）
        assert!(serde_json::from_str::<serde_json::Value>(&json).is_ok());
    }
}
