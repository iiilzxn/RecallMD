// M5 时钟与服务编排测试：wall 回退检测、RESET 从空状态评新正文、
// 重试复用同一 request_id（幂等契约的 TS 侧配合）、时钟异常本地拦截。

import { describe, expect, it } from "vitest";
import { ClockAnomaly, createFakeClock } from "../../src/review/clock";
import {
  initialize,
  schedule,
  toOutcome,
  frozenConfig,
  ALGORITHM_ID,
  ALGORITHM_VERSION,
  STATE_SCHEMA_VERSION,
} from "../../src/review/scheduler";
import { ReviewService, type SubmitAction } from "../../src/review/service";
import type {
  ReviewBeginResultDto,
  ReviewStateDetailDto,
  SubmitReviewRequestDto,
} from "../../src/review/ipc";

const T0 = Date.UTC(2026, 8, 14, 8, 0, 0, 0);

function beginResult(): ReviewBeginResultDto {
  // M4 登记后的真实形状：NEW + 空算法状态（config/state 为 JSON 字符串）
  const state: ReviewStateDetailDto = {
    blockId: "b-0001",
    relativePath: "a.md",
    title: "小节",
    headingPath: ["父", "小节"],
    participation: "ENABLED",
    phase: "NEW",
    generation: 0,
    stateRevision: 0,
    algorithmId: ALGORITHM_ID,
    algorithmVersion: ALGORITHM_VERSION,
    stateSchemaVersion: STATE_SCHEMA_VERSION,
    configJson: JSON.stringify(frozenConfig()),
    stateJson: JSON.stringify(initialize(T0 - 86_400_000).nativeState), // 登记 24h 前
    scheduledDueAt: T0 - 86_400_000,
    changeDueAt: null,
    nextReviewAt: T0 - 86_400_000,
    stability: null,
    difficulty: null,
    intervalMs: 0,
    reps: 0,
    lapses: 0,
    firstReviewAt: null,
    lastReviewAt: null,
    needsRecheck: false,
    lastReviewedContentVersion: null,
  };
  return { token: "tok-1", nowMs: T0, state };
}

function makeService(submits: Array<{ reject?: unknown }>) {
  const calls: SubmitReviewRequestDto[] = [];
  let call = 0;
  const ipc = {
    reviewBegin: async () => beginResult(),
    reviewSubmit: async (req: SubmitReviewRequestDto) => {
      calls.push(JSON.parse(JSON.stringify(req)));
      const script = submits[Math.min(call, submits.length - 1)];
      call++;
      if (script && "reject" in script && script.reject) {
        throw script.reject;
      }
      return {
        blockId: req.token === "tok-1" ? "b-0001" : "",
        stateRevision: 1,
        nextReviewAt: req.outcome.scheduledDueAt,
        occurredAt: req.nowMs,
        replayed: false,
        quota: { limit: 20, usedToday: 1, remaining: 19 },
      };
    },
    reviewQueue: async () => {
      throw new Error("unused");
    },
    reviewSetParticipation: async () => 1,
    reviewResetBlock: async () => ({ blockId: "b", stateRevision: 1, scheduledDueAt: T0 }),
  };
  const clock = createFakeClock(T0);
  const service = new ReviewService({
    ipc: ipc as never,
    clock,
    newRequestId: () => "req-uuid-1",
  });
  return { service, calls, clock };
}

describe("M5 时钟", () => {
  it("wall 回退超过 5s 判异常；小抖动放行", () => {
    const c = createFakeClock(T0);
    c.advance(60_000);
    expect(c.check().ok).toBe(true);
    c.set(T0 + 60_000 - 6_000); // 回拨 6s
    expect(c.check().ok).toBe(false);
    expect(c.check().regressionMs).toBeGreaterThanOrEqual(6_000);
    const c2 = createFakeClock(T0);
    c2.advance(10_000);
    c2.set(T0 + 10_000 - 500); // 500ms 抖动
    expect(c2.check().ok).toBe(true);
  });
});

describe("M5 ReviewService.submit", () => {
  const action = (): SubmitAction => ({ begin: beginResult(), rating: "Good" });

  it("请求形状：requestId 注入、nowMs 取自时钟、outcome 为调度结果", async () => {
    const { service, calls } = makeService([{}]);
    await service.submit(action());
    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.requestId).toBe("req-uuid-1");
    expect(req.token).toBe("tok-1");
    expect(req.rating).toBe(3);
    expect(req.nowMs).toBe(T0);
    expect(req.changeResolution).toBeNull();
    // begin.state 的算法状态是"登记时的空卡"（due 在 24h 前），对其在 now 评分
    expect(req.outcome).toEqual(
      toOutcome(schedule({ state: initialize(T0 - 86_400_000), rating: "Good", nowMs: T0 })),
    );
  });

  it("RESET：从空状态评新正文（等价 initialize(now) + rate）", async () => {
    const { service, calls } = makeService([{}]);
    await service.submit({ ...action(), changeResolution: "RESET" });
    const req = calls[0];
    expect(req.changeResolution).toBe("RESET");
    const fromEmpty = toOutcome(schedule({ state: initialize(T0), rating: "Good", nowMs: T0 }));
    expect(req.outcome).toEqual(fromEmpty);
  });

  it("时钟异常本地拦截：不发起任何 IPC", async () => {
    const { service, calls, clock } = makeService([{}]);
    clock.advance(120_000);
    expect(clock.nowMs()).toBe(T0 + 120_000); // 观测到墙钟高点
    clock.set(T0 + 60_000); // 回拨 60s
    await expect(service.submit(action())).rejects.toBeInstanceOf(ClockAnomaly);
    expect(calls).toHaveLength(0);
  });

  it("可重试错误复用同一请求（requestId/nowMs/outcome 逐字节相同）后成功", async () => {
    const { service, calls } = makeService([
      { reject: { code: "DB_BUSY", message: "忙", retryable: true } },
      {},
    ]);
    const r = await service.submit(action());
    expect(r.replayed).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
  });

  it("不可重试错误立即上抛（仅一次调用）", async () => {
    const { service, calls } = makeService([
      { reject: { code: "REVIEW_TOKEN_STALE", message: "过期", retryable: false } },
    ]);
    await expect(service.submit(action())).rejects.toMatchObject({
      code: "REVIEW_TOKEN_STALE",
    });
    expect(calls).toHaveLength(1);
  });

  it("连续两次可重试失败后上抛最后一次错误", async () => {
    const { service, calls } = makeService([
      { reject: { code: "DB_BUSY", message: "忙1", retryable: true } },
      { reject: { code: "DB_BUSY", message: "忙2", retryable: true } },
    ]);
    await expect(service.submit(action())).rejects.toMatchObject({ message: "忙2" });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
  });

  it("外部传入 requestId 时复用（结果未明的重试场景，§10.4）", async () => {
    const { service, calls } = makeService([{}]);
    await service.submit({ ...action(), requestId: "reuse-me" });
    expect(calls[0].requestId).toBe("reuse-me");
  });

  it("stats/appConfig 透传到 ipc", async () => {
    const seen: string[] = [];
    const ipc = {
      reviewBegin: async () => beginResult(),
      reviewSubmit: async () => {
        throw new Error("unused");
      },
      reviewQueue: async () => {
        throw new Error("unused");
      },
      reviewSetParticipation: async () => 1,
      reviewResetBlock: async () => ({ blockId: "b", stateRevision: 1, scheduledDueAt: T0 }),
      reviewStats: async () => {
        seen.push("stats");
        return {
          ratedToday: 0, rated7d: 0, rated30d: 0,
          distinctBlocks7d: 0, distinctBlocks30d: 0,
          ratings7d: [0, 0, 0, 0], ratings30d: [0, 0, 0, 0],
          due: { learning: 0, review: 0, newTotal: 0 },
          enabled: 0, paused: 0, excluded: 0,
        };
      },
      appConfigRead: async () => {
        seen.push("config-read");
        return { dailyNewLimit: 20, autosave: true };
      },
      appConfigSet: async (key: string, value: string) => {
        seen.push(`config-set:${key}=${value}`);
      },
    };
    const service = new ReviewService({ ipc: ipc as never, clock: createFakeClock(T0) });
    await service.stats();
    await service.appConfig();
    await service.setAppConfig("editor.autosave", "0");
    expect(seen).toEqual(["stats", "config-read", "config-set:editor.autosave=0"]);
    // now() 走注入时钟（UI 计时纪律）
    expect(service.now()).toBe(T0);
  });
});
