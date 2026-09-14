// M5 复习命令客户端（与 Rust store::review DTO 对齐，camelCase；
// 键形由 tests/review/seam.spec.ts 钉死——M4 §4.12 接缝教训）。

import { ipcCall } from "../editor/ipc";
import type { Phase, RatingName, SchedulerOutcome } from "./scheduler";

// --- DTO（镜像 review.rs 的 Serialize/Deserialize 形状） ---

export interface ReviewStateDetailDto {
  blockId: string;
  relativePath: string;
  title: string | null;
  headingPath: string[];
  participation: "ENABLED" | "PAUSED" | "EXCLUDED";
  phase: Phase;
  generation: number;
  stateRevision: number;
  algorithmId: string;
  algorithmVersion: string;
  stateSchemaVersion: number;
  configJson: string;
  stateJson: string;
  scheduledDueAt: number;
  changeDueAt: number | null;
  nextReviewAt: number;
  stability: number | null;
  difficulty: number | null;
  intervalMs: number;
  reps: number;
  lapses: number;
  firstReviewAt: number | null;
  lastReviewAt: number | null;
  needsRecheck: boolean;
  lastReviewedContentVersion: number | null;
}

export interface ReviewBeginResultDto {
  token: string;
  nowMs: number;
  state: ReviewStateDetailDto;
}

export interface SubmitReviewRequestDto {
  requestId: string;
  token: string;
  rating: 1 | 2 | 3 | 4;
  nowMs: number;
  changeResolution: "KEEP" | "RESET" | null;
  contextUsed: boolean;
  durationMs: number | null;
  outcome: SchedulerOutcome;
}

export interface QuotaInfoDto {
  limit: number;
  usedToday: number;
  remaining: number;
}

export interface SubmitReviewResultDto {
  blockId: string;
  stateRevision: number;
  nextReviewAt: number;
  occurredAt: number;
  replayed: boolean;
  quota: QuotaInfoDto;
}

export interface QueueItemDto {
  blockId: string;
  relativePath: string;
  title: string | null;
  headingPath: string[];
  phase: Phase;
  nextReviewAt: number;
  needsRecheck: boolean;
  neverRated: boolean;
}

export interface QueueCountsDto {
  learning: number;
  review: number;
  newTotal: number;
}

export interface ReviewQueueResultDto {
  nowMs: number;
  items: QueueItemDto[];
  counts: QueueCountsDto;
  quota: QuotaInfoDto;
}

export interface ResetBlockResultDto {
  blockId: string;
  stateRevision: number;
  scheduledDueAt: number;
}

export type ParticipationAction = "PAUSE" | "RESUME" | "EXCLUDE" | "INCLUDE";

// --- 客户端 ---

export const reviewIpc = {
  reviewBegin(blockId: string): Promise<ReviewBeginResultDto> {
    return ipcCall<ReviewBeginResultDto>("review_begin", { blockId });
  },
  reviewSubmit(request: SubmitReviewRequestDto): Promise<SubmitReviewResultDto> {
    return ipcCall<SubmitReviewResultDto>("review_submit", { request });
  },
  reviewQueue(pageSize?: number): Promise<ReviewQueueResultDto> {
    return ipcCall<ReviewQueueResultDto>("review_queue", { pageSize: pageSize ?? null });
  },
  reviewSetParticipation(blockIds: string[], action: ParticipationAction): Promise<number> {
    return ipcCall<number>("review_set_participation", { blockIds, action });
  },
  reviewResetBlock(blockId: string): Promise<ResetBlockResultDto> {
    return ipcCall<ResetBlockResultDto>("review_reset_block", { blockId });
  },
};

/** Rust §14.1 错误码（M5 新增；UI 分支依据，勿凭字符串猜） */
export const REVIEW_ERROR_CODES = [
  "REVIEW_TOKEN_INVALID",
  "REVIEW_TOKEN_STALE",
  "QUOTA_EXCEEDED",
  "TIME_ANOMALY",
  "REVIEW_REJECTED",
] as const;

export type ReviewErrorCode = (typeof REVIEW_ERROR_CODES)[number];

/** Rating 名称 ↔ 存储值（§10.4） */
export const RATING_BY_VALUE: Readonly<Record<number, RatingName>> = {
  1: "Again",
  2: "Hard",
  3: "Good",
  4: "Easy",
};
