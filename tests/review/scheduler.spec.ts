// M5 scheduler 行为测试：envelope 往返、身份/配置漂移防护、预览、
// 初始化与 M4 Rust 模板逐字一致（重置语义）。数值级输出由 golden.spec 钉死。

import { describe, expect, it } from "vitest";
import {
  ALGORITHM_ID,
  ALGORITHM_VERSION,
  STATE_SCHEMA_VERSION,
  frozenConfig,
  initialize,
  preview,
  reviveCard,
  cardToJson,
  schedule,
  RATING_VALUE,
  RATING_NAMES,
  type SchedulerEnvelope,
} from "../../src/review/scheduler";

const T0 = Date.UTC(2026, 8, 14, 8, 0, 0, 0);

describe("M5 scheduler 适配器", () => {
  it("initialize 与 M4 Rust 空卡模板逐字一致（重置语义 due=now）", () => {
    const env = initialize(T0);
    expect(env.algorithmId).toBe("fsrs");
    expect(env.algorithmVersion).toBe("ts-fsrs@5.4.2+FSRS-6.0");
    expect(env.stateSchemaVersion).toBe(1);
    expect(JSON.stringify(env.nativeState)).toBe(
      '{"due":"2026-09-14T08:00:00.000Z","stability":0,"difficulty":0,' +
        '"elapsed_days":0,"scheduled_days":0,"reps":0,"lapses":0,' +
        '"learning_steps":0,"state":0}',
    );
  });

  it("envelope JSON 往返后调度结果逐值一致（Date 显式还原，§11.3 L499）", () => {
    const once = schedule({ state: initialize(T0), rating: "Good", nowMs: T0 });
    // 权威快照经 JSON 字符串（= Rust state_json）再回来
    const roundTripped: SchedulerEnvelope = {
      algorithmId: once.envelope.algorithmId,
      algorithmVersion: once.envelope.algorithmVersion,
      stateSchemaVersion: once.envelope.stateSchemaVersion,
      config: JSON.parse(JSON.stringify(once.envelope.config)),
      nativeState: JSON.parse(JSON.stringify(once.envelope.nativeState)),
    };
    const next1 = schedule({ state: once.envelope, rating: "Easy", nowMs: T0 + 60_000 });
    const next2 = schedule({ state: roundTripped, rating: "Easy", nowMs: T0 + 60_000 });
    expect(next2.envelope.nativeState).toEqual(next1.envelope.nativeState);
    expect(next2.log).toEqual(next1.log);
    expect(next2.scheduledDueAt).toBe(next1.scheduledDueAt);
    // reviveCard 的 Date 还原可逆
    const card = reviveCard(roundTripped.nativeState);
    expect(cardToJson(card)).toEqual(roundTripped.nativeState);
  });

  it("算法身份/配置漂移即抛错，不降级运行（§11.2）", () => {
    const bad = { ...initialize(T0), algorithmVersion: "ts-fsrs@9.9.9+FSRS-7" };
    expect(() => schedule({ state: bad, rating: "Good", nowMs: T0 })).toThrow(/算法身份漂移/);
    const drifted = initialize(T0);
    drifted.config = { ...drifted.config, request_retention: 0.85 };
    expect(() => schedule({ state: drifted, rating: "Good", nowMs: T0 })).toThrow(/request_retention/);
    expect(() => preview(drifted, T0)).toThrow(/request_retention/);
  });

  it("预览四条目与评分同源（repeat==next；§10.4 仅展示不承诺）", () => {
    const items = preview(initialize(T0), T0);
    expect(items.map((i) => i.rating)).toEqual([...RATING_NAMES]);
    for (const item of items) {
      const real = schedule({ state: initialize(T0), rating: item.rating, nowMs: T0 });
      expect(item.scheduledDueAt).toBe(real.scheduledDueAt);
      expect(item.phase).toBe(real.phase);
      expect(item.intervalMs).toBe(real.intervalMs);
    }
  });

  it("评分后 envelope 自洽：state>0 时投影非空、due 为 ISO 毫秒", () => {
    const r = schedule({ state: initialize(T0), rating: "Good", nowMs: T0 });
    expect(r.stability).toBeGreaterThan(0);
    expect(r.difficulty).toBeGreaterThan(0);
    expect(r.envelope.nativeState.due).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(r.envelope.nativeState.last_review).toBe("2026-09-14T08:00:00.000Z");
    expect(r.intervalMs).toBe(r.scheduledDueAt - T0);
  });

  it("RATING_VALUE 与 §10.4 存储值一致", () => {
    expect(RATING_VALUE).toEqual({ Again: 1, Hard: 2, Good: 3, Easy: 4 });
  });

  it("frozenConfig 与 M4 Rust CONFIG_JSON 键值一致（fsrsContract 之外的二次钉）", () => {
    const c = frozenConfig();
    expect(c).toEqual({
      request_retention: 0.9,
      maximum_interval: 3650,
      w: [
        0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
        1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
      ],
      enable_fuzz: false,
      enable_short_term: true,
      learning_steps: ["1m", "10m"],
      relearning_steps: ["10m"],
    });
    expect(ALGORITHM_ID + "@" + ALGORITHM_VERSION + "#" + STATE_SCHEMA_VERSION).toBe(
      "fsrs@ts-fsrs@5.4.2+FSRS-6.0#1",
    );
  });
});
