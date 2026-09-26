import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcCall } from "../../src/editor/ipc";
import { reviewIpc } from "../../src/review/ipc";
import { createFakeClock } from "../../src/review/clock";
import { ReviewService } from "../../src/review/service";
import { initialize, schedule } from "../../src/review/scheduler";

vi.mock("../../src/editor/ipc", () => ({ ipcCall: vi.fn().mockResolvedValue({}) }));

describe("立即学习接缝", () => {
  const now = Date.UTC(2026, 8, 20, 8);
  const service = new ReviewService({ ipc: reviewIpc, clock: createFakeClock(now) });
  beforeEach(() => vi.mocked(ipcCall).mockClear());

  it("显式学习使用独立命令，普通复习仍然只请求到期队列", async () => {
    await service.queue();
    await service.queue(12, true);
    await service.begin("normal");
    await service.begin("new", true);
    expect(vi.mocked(ipcCall).mock.calls).toEqual([
      ["review_queue", { pageSize: null }],
      ["learning_queue", { pageSize: 12 }],
      ["review_begin", { blockId: "normal" }],
      ["learning_begin", { blockId: "new" }],
    ]);
  });

  it("首次评分以实际学习时刻调度，不把原来的次日到期时间当学习经历", () => {
    const registered = initialize(now + 86_400_000);
    for (const rating of ["Again", "Hard", "Good", "Easy"] as const) {
      const early = schedule({ state: registered, rating, nowMs: now });
      const fresh = schedule({ state: initialize(now), rating, nowMs: now });
      expect(early.envelope.nativeState).toEqual(fresh.envelope.nativeState);
      expect(early.scheduledDueAt).toBe(fresh.scheduledDueAt);
      expect(early.reps).toBe(1);
    }
    expect(registered.nativeState.reps).toBe(0);
    expect(registered.nativeState.due).toBe(new Date(now + 86_400_000).toISOString());
  });
});
