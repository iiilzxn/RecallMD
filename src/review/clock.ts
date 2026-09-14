// M5 双轨时钟（设计 §11.4）：wall 与 monotonic 并行观测；wall 回退超过阈值
// 判为异常——评分前本地拦截（Rust 侧另有 ±10s 容差与 5 分钟偏离守卫兜底）。
// 禁止在 scheduler/业务模块直接取系统时间；一律经 Clock 注入（测试可替换）。

export interface ClockSanity {
  ok: boolean;
  /** wall 相对已见最高值的回退量（毫秒；正常 ≤0 波动） */
  regressionMs: number;
}

export interface Clock {
  nowMs(): number;
  /** 观测一次并返回时钟健全性（wall 回退检测） */
  check(): ClockSanity;
}

/** wall 回退容忍（同毫秒/微抖动与 NTP 微调不算异常） */
const WALL_REGRESSION_TOLERANCE_MS = 5_000;

export function createSystemClock(): Clock {
  let maxWall = Date.now();
  return {
    nowMs: () => {
      const now = Date.now();
      if (now > maxWall) {
        maxWall = now;
      }
      return now;
    },
    check: () => {
      const now = Date.now();
      if (now > maxWall) {
        maxWall = now;
      }
      // wall 落后于进程内已见最高值即回拨证据（wall/monotonic 交叉核验在 Rust 侧）
      const regressionMs = maxWall - now;
      return {
        ok: regressionMs <= WALL_REGRESSION_TOLERANCE_MS,
        regressionMs,
      };
    },
  };
}

/** 测试用可控时钟（固定或手动拨动；模拟时间流逝/回拨） */
export function createFakeClock(startMs: number): Clock & {
  set(ms: number): void;
  advance(ms: number): void;
} {
  let current = startMs;
  let maxWall = startMs;
  return {
    nowMs: () => {
      if (current > maxWall) maxWall = current;
      return current;
    },
    check: () => {
      if (current > maxWall) maxWall = current;
      const regressionMs = maxWall - current;
      return { ok: regressionMs <= WALL_REGRESSION_TOLERANCE_MS, regressionMs };
    },
    set: (ms: number) => {
      current = ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** 时钟异常错误（与 Rust TIME_ANOMALY 同码；本地拦截不上线） */
export class ClockAnomaly extends Error {
  readonly code = "TIME_ANOMALY";
  constructor(regressionMs: number) {
    super(`系统时钟回拨 ${regressionMs}ms，评分已暂停，请检查系统时间后重试`);
  }
}
