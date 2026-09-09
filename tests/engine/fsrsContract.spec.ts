// M4 契约测试：Rust fsrs.rs 写入的初始 state_json / config_json 必须与
// 锁定的 ts-fsrs@5.4.2 序列化逐键一致（M5 ReviewScheduler 的往返契约；改模板须升
// state_schema_version 并同步更新本测试与 Rust 模板）。

import { describe, expect, it } from "vitest";
import { createEmptyCard, fsrs, generatorParameters, State } from "ts-fsrs";

/** Rust empty_card_state_json(due) 的形状（fsrs.rs；无 last_review 键——库序列化省略 undefined） */
function rustEmptyCardStateJson(dueMs: number): string {
  const iso = new Date(dueMs).toISOString(); // 与 Rust iso8601_ms 同构：毫秒精度 UTC
  return `{"due":"${iso}","stability":0,"difficulty":0,"elapsed_days":0,"scheduled_days":0,"reps":0,"lapses":0,"learning_steps":0,"state":0}`;
}

/** Rust CONFIG_JSON（fsrs.rs，§11.2 展开值；对齐 generatorParameters 键序） */
const RUST_CONFIG = {
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
};

describe("M4 ts-fsrs 初始状态契约（Rust ↔ TS）", () => {
  it("空卡 JSON 与 createEmptyCard().toJSON() 逐键一致", () => {
    const due = Date.UTC(2026, 8, 10, 12, 0, 0, 0);
    const rust = JSON.parse(rustEmptyCardStateJson(due));
    const lib = JSON.parse(JSON.stringify(createEmptyCard(new Date(due))));
    expect(rust).toEqual(lib);
    expect(Object.keys(rust).sort()).toEqual(Object.keys(lib).sort());
    expect(lib.state).toBe(State.New);
    // 库序列化不写 last_review 键（undefined 被丢弃），Rust 模板同构
    expect("last_review" in lib).toBe(false);
  });

  it("Rust 模板可被库往返：反序列化 → 再序列化 → 值不变", () => {
    const due = Date.now() + 86_400_000;
    const parsed = JSON.parse(rustEmptyCardStateJson(due)) as {
      due: string;
      stability: number;
      difficulty: number;
      elapsed_days: number;
      scheduled_days: number;
      reps: number;
      lapses: number;
      learning_steps: number;
      state: number;
    };
    // M5 adapter 的读法：due 字符串 → Date；数值直接进 Card 字段
    const card = createEmptyCard(new Date(parsed.due));
    card.stability = parsed.stability;
    card.difficulty = parsed.difficulty;
    card.reps = parsed.reps;
    card.lapses = parsed.lapses;
    card.learning_steps = parsed.learning_steps;
    const roundTrip = JSON.parse(JSON.stringify(card));
    expect(roundTrip).toEqual(parsed);
  });

  it("config_json 与 §11.2 展开值一致（默认 maximum_interval=36500 已覆写为 3650）", () => {
    const libDefault = generatorParameters();
    expect(libDefault.maximum_interval).toBe(36500); // 库默认，必须覆写
    const ours = generatorParameters({
      request_retention: 0.9,
      maximum_interval: 3650,
      enable_fuzz: false,
      enable_short_term: true,
      learning_steps: ["1m", "10m"],
      relearning_steps: ["10m"],
    });
    expect(ours).toEqual(RUST_CONFIG);
    // 引擎可用它构建调度器（锁定版本健康检查）
    expect(() => fsrs(ours)).not.toThrow();
  });
});
