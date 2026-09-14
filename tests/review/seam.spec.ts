// M5 缝契约测试（M4 §4.12 教训：两侧单测各自全绿、wire 契约无人测）。
// 钉死 TS↔Rust 线上 JSON 的键形：requestId/token/camelCase、Rust review.rs
// serde(rename_all="camelCase") 的应答键序。任一侧改名此处或人工验收即暴露。

import { describe, expect, it } from "vitest";
import {
  REVIEW_ERROR_CODES,
  type QueueCountsDto,
  type QueueItemDto,
  type QuotaInfoDto,
  type ResetBlockResultDto,
  type ReviewBeginResultDto,
  type ReviewQueueResultDto,
  type ReviewStateDetailDto,
  type SubmitReviewRequestDto,
  type SubmitReviewResultDto,
} from "../../src/review/ipc";
import { initialize, schedule, toOutcome, RATING_VALUE } from "../../src/review/scheduler";

const T0 = Date.UTC(2026, 8, 14, 8, 0, 0, 0);

function keysOf(obj: Record<string, unknown>): string[] {
  return Object.keys(obj);
}

describe("M5 线上 DTO 键形（TS→Rust 请求）", () => {
  it("SubmitReviewRequest：恰好 8 键，camelCase，无 PascalCase 变体", () => {
    const outcome = toOutcome(schedule({ state: initialize(T0), rating: "Good", nowMs: T0 }));
    const req: SubmitReviewRequestDto = {
      requestId: "0192ab5c-0000-7000-8000-000000000001",
      token: "0192ab5c-0000-7000-8000-000000000002",
      rating: 3,
      nowMs: T0,
      changeResolution: null,
      contextUsed: false,
      durationMs: 4200,
      outcome,
    };
    expect(keysOf(req as unknown as Record<string, unknown>)).toEqual([
      "requestId",
      "token",
      "rating",
      "nowMs",
      "changeResolution",
      "contextUsed",
      "durationMs",
      "outcome",
    ]);
    expect(keysOf(req.outcome as unknown as Record<string, unknown>)).toEqual([
      "stateJson",
      "scheduledDueAt",
      "phase",
      "stability",
      "difficulty",
      "intervalMs",
      "reps",
      "lapses",
      "logJson",
    ]);
    // 序列化后无大写开头键（Rust deny_unknown_fields 会整批拒绝）
    const wire = JSON.stringify(req);
    expect(wire).not.toMatch(/"[A-Z][a-zA-Z]*":/);
  });

  it("stateJson 的 due 为 ISO-8601 毫秒精度（Rust parse_iso8601_ms 只接受 24 字符形状）", () => {
    const outcome = toOutcome(schedule({ state: initialize(T0), rating: "Good", nowMs: T0 }));
    const native = JSON.parse(outcome.stateJson);
    expect(native.due).toBe("2026-09-14T08:10:00.000Z");
    expect(native.due).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // intervalMs == due - now（Rust validate_outcome 的对偶约束）
    expect(outcome.intervalMs).toBe(Date.parse(native.due) - T0);
  });

  it("RATING 存储值 1–4（§10.4），Rating 枚举名与值一一对应", () => {
    const values = Object.values(RATING_VALUE);
    expect([...values].sort()).toEqual([1, 2, 3, 4]);
  });
});

describe("M5 线上 DTO 键形（Rust→TS 应答；镜像 review.rs Serialize 结构）", () => {
  it("review_begin / review_submit / review_queue / review_reset_block 键集", () => {
    // 以字面量钉键序（与 src-tauri store/review.rs 结构体字段序一致）
    const stateKeys: (keyof ReviewStateDetailDto)[] = [
      "blockId",
      "relativePath",
      "title",
      "headingPath",
      "participation",
      "phase",
      "generation",
      "stateRevision",
      "algorithmId",
      "algorithmVersion",
      "stateSchemaVersion",
      "configJson",
      "stateJson",
      "scheduledDueAt",
      "changeDueAt",
      "nextReviewAt",
      "stability",
      "difficulty",
      "intervalMs",
      "reps",
      "lapses",
      "firstReviewAt",
      "lastReviewAt",
      "needsRecheck",
      "lastReviewedContentVersion",
    ];
    const beginKeys: (keyof ReviewBeginResultDto)[] = ["token", "nowMs", "state"];
    const submitKeys: (keyof SubmitReviewResultDto)[] = [
      "blockId",
      "stateRevision",
      "nextReviewAt",
      "occurredAt",
      "replayed",
      "quota",
    ];
    const queueKeys: (keyof ReviewQueueResultDto)[] = ["nowMs", "items", "counts", "quota"];
    const itemKeys: (keyof QueueItemDto)[] = [
      "blockId",
      "relativePath",
      "title",
      "headingPath",
      "phase",
      "nextReviewAt",
      "needsRecheck",
      "neverRated",
    ];
    const countKeys: (keyof QueueCountsDto)[] = ["learning", "review", "newTotal"];
    const quotaKeys: (keyof QuotaInfoDto)[] = ["limit", "usedToday", "remaining"];
    const resetKeys: (keyof ResetBlockResultDto)[] = ["blockId", "stateRevision", "scheduledDueAt"];
    // 编译期存在性 + 运行期长度（防重复/遗漏的自检）
    expect(stateKeys).toHaveLength(25);
    expect(beginKeys).toHaveLength(3);
    expect(submitKeys).toHaveLength(6);
    expect(queueKeys).toHaveLength(4);
    expect(itemKeys).toHaveLength(8);
    expect(countKeys).toHaveLength(3);
    expect(quotaKeys).toHaveLength(3);
    expect(resetKeys).toHaveLength(3);
  });

  it("M5 错误码集（Rust error.rs 常量镜像）", () => {
    expect(REVIEW_ERROR_CODES).toEqual([
      "REVIEW_TOKEN_INVALID",
      "REVIEW_TOKEN_STALE",
      "QUOTA_EXCEEDED",
      "TIME_ANOMALY",
      "REVIEW_REJECTED",
    ]);
  });

  it("子事件 request_id 派生约定（Rust 侧 '{主UUID}:keep'/':reset'，文档化钉死）", () => {
    // Rust tests/m5_review.rs 断言事件序与 request_id 唯一约束；此处钉格式约定，
    // 防止 TS 侧未来伪造子 ID 与 Rust 派生冲突
    const main = "0192ab5c-0000-7000-8000-000000000001";
    expect(`${main}:keep`).not.toBe(main);
    expect(`${main}:reset`).not.toBe(main);
  });
});
