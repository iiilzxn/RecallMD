// M5 golden fixtures 对照（§11.4 L507）：固定时钟下真实 scheduler 模块必须逐值
// 复现锁定版 ts-fsrs 的输出（due/S/D/reps/lapses/phase/log）。升级依赖后此处
// 变红 = 调度行为变化，须人工审阅并走 §11.4 迁移流程，不许静默接受快照更新。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALGORITHM_ID,
  ALGORITHM_VERSION,
  STATE_SCHEMA_VERSION,
  frozenConfig,
  schedule,
  type NativeCardJson,
  type RatingName,
  type SchedulerEnvelope,
} from "../../src/review/scheduler";

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/fsrs-golden");

interface GoldenEntry {
  now: string;
  rating: RatingName;
  before: NativeCardJson;
  after: NativeCardJson;
  projections: {
    phase: string;
    dueMs: number;
    intervalMs: number;
    stability: number | null;
    difficulty: number | null;
    reps: number;
    lapses: number;
  };
  log: Record<string, unknown>;
  note?: string;
}

function load(name: string): GoldenEntry[] {
  return JSON.parse(readFileSync(join(goldenDir, `${name}.json`), "utf8")) as GoldenEntry[];
}

function envOf(native: NativeCardJson): SchedulerEnvelope {
  return {
    algorithmId: ALGORITHM_ID,
    algorithmVersion: ALGORITHM_VERSION,
    stateSchemaVersion: STATE_SCHEMA_VERSION,
    config: frozenConfig(),
    nativeState: native,
  };
}

function replay(name: string) {
  for (const [i, entry] of load(name).entries()) {
    const result = schedule({
      state: envOf(entry.before),
      rating: entry.rating,
      nowMs: Date.parse(entry.now),
    });
    expect(result.envelope.nativeState, `${name}[${i}] nativeState`).toEqual(entry.after);
    expect(result.envelope.config, `${name}[${i}] config`).toEqual(frozenConfig());
    expect(result.phase, `${name}[${i}] phase`).toBe(entry.projections.phase);
    expect(result.scheduledDueAt, `${name}[${i}] due`).toBe(entry.projections.dueMs);
    expect(result.intervalMs, `${name}[${i}] interval`).toBe(entry.projections.intervalMs);
    expect(result.stability, `${name}[${i}] S`).toBe(entry.projections.stability);
    expect(result.difficulty, `${name}[${i}] D`).toBe(entry.projections.difficulty);
    expect(result.reps, `${name}[${i}] reps`).toBe(entry.projections.reps);
    expect(result.lapses, `${name}[${i}] lapses`).toBe(entry.projections.lapses);
    expect(result.log, `${name}[${i}] log`).toEqual(entry.log);
  }
}

describe("M5 golden fixtures（锁定版 ts-fsrs 输出）", () => {
  it("首评四 Rating：Again 1m / Hard 6m / Good 10m / Easy 毕业长间隔", () => {
    const entries = load("first-rating");
    expect(entries.map((e) => e.projections.intervalMs)).toEqual([
      60_000,
      6 * 60_000,
      10 * 60_000,
      8 * 86_400_000,
    ]);
    replay("first-rating");
  });

  it("学习→毕业→长期复习→遗忘重学→再毕业全链路", () => {
    const entries = load("learning-path");
    expect(entries.map((e) => e.projections.phase)).toEqual([
      "LEARNING",
      "REVIEW",
      "REVIEW",
      "REVIEW",
      "RELEARNING",
      "REVIEW",
      "REVIEW",
    ]);
    replay("learning-path");
  });

  it("逾期 300 天：elapsed 按真实流逝处理，无负间隔/无崩溃", () => {
    const entries = load("overdue");
    for (const e of entries) {
      expect(e.projections.intervalMs).toBeGreaterThanOrEqual(0);
    }
    expect(entries[0].projections.phase).toBe("RELEARNING"); // 遗忘
    replay("overdue");
  });

  it("重置后首评 = 空卡首评（无历史泄漏到新 generation）", () => {
    const reset = load("reset-after-history")[0];
    const firstGood = load("first-rating").find((e) => e.rating === "Good")!;
    // 除时间平移外逐值一致：S/D/reps/lapses/相对 due
    expect(reset.projections.stability).toBe(firstGood.projections.stability);
    expect(reset.projections.difficulty).toBe(firstGood.projections.difficulty);
    expect(reset.projections.intervalMs).toBe(firstGood.projections.intervalMs);
    replay("reset-after-history");
  });

  it("日界线：分钟/天间隔按绝对 due 持久化，不吸附次日零点", () => {
    const entries = load("day-boundary");
    for (const e of entries) {
      const due = new Date(e.projections.dueMs);
      const now = new Date(Date.parse(e.now));
      // due 保持评分时刻的分针位置（不被吸附到零点）；间隔为整分钟粒度
      expect(due.getUTCHours() * 60 + due.getUTCMinutes()).toBe(
        now.getUTCHours() * 60 + now.getUTCMinutes(),
      );
      expect(e.projections.dueMs % 60_000).toBe(0);
    }
    replay("day-boundary");
  });
});
