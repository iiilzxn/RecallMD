// M5 ReviewService：复习编排（队列/揭示/预览/提交/参与/重置）。
// UI（M6）只与本类和 DTO 打交道；算法细节封在 scheduler，事务与令牌在 Rust。
//
// 提交纪律（§10.4）：requestId 一次生成、重试复用（幂等由 Rust request_id 查重
// 兜底）；正式点击时用新的 now 重新计算（预览不是持久承诺）；时钟异常本地拦截。

import { Clock, ClockAnomaly } from "./clock";
import {
  envelopeFromRow,
  initialize,
  preview,
  RATING_VALUE,
  schedule,
  toOutcome,
  type PreviewItem,
  type RatingName,
} from "./scheduler";
import {
  reviewIpc,
  type AppConfigDto,
  type AppConfigKey,
  type ParticipationAction,
  type ReviewBeginResultDto,
  type ReviewQueueResultDto,
  type ReviewStatsResultDto,
  type ResetBlockResultDto,
  type SubmitReviewRequestDto,
  type SubmitReviewResultDto,
} from "./ipc";

export interface ReviewServiceDeps {
  ipc: typeof reviewIpc;
  clock: Clock;
  /** 测试注入确定性 UUID；生产用 crypto.randomUUID */
  newRequestId?: () => string;
}

export interface SubmitAction {
  /** review_begin 的应答（会话快照 + 令牌） */
  begin: ReviewBeginResultDto;
  rating: RatingName;
  /** needsRecheck=1 时必填：KEEP=沿用进度 / RESET=重新学习（§10.3） */
  changeResolution?: "KEEP" | "RESET";
  contextUsed?: boolean;
  /** 揭示→点击的答题时长（毫秒；调用方用同一 Clock 计时） */
  durationMs?: number | null;
  /**
   * 结果未明（超时/中断）后的重试须复用同一 requestId（§10.4 L430）；
   * 传入即复用。新动作不传，内部生成。
   */
  requestId?: string;
}

/** DB_BUSY 等可重试错误重试一次（§14.1 有界重试） */
function isRetryable(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "retryable" in e &&
    (e as { retryable?: unknown }).retryable === true
  );
}

function defaultNewRequestId(): string {
  return crypto.randomUUID();
}

export class ReviewService {
  constructor(private readonly deps: ReviewServiceDeps) {}

  /** 统一时钟读数（UI 计时/展示用它，不直接 Date.now） */
  now(): number {
    return this.deps.clock.nowMs();
  }

  queue(pageSize?: number, learnNow = false): Promise<ReviewQueueResultDto> {
    if (learnNow) return this.deps.ipc.learningQueue(pageSize);
    return this.deps.ipc.reviewQueue(pageSize);
  }

  begin(blockId: string, learnNow = false): Promise<ReviewBeginResultDto> {
    if (learnNow) return this.deps.ipc.learningBegin(blockId);
    return this.deps.ipc.reviewBegin(blockId);
  }

  stats(): Promise<ReviewStatsResultDto> {
    return this.deps.ipc.reviewStats();
  }

  appConfig(): Promise<AppConfigDto> {
    return this.deps.ipc.appConfigRead();
  }

  setAppConfig(key: AppConfigKey, value: string): Promise<void> {
    return this.deps.ipc.appConfigSet(key, value);
  }


  /** 四间隔预览（§10.4：仅展示；提交时另取新 now 重算） */
  previewIntervals(begin: ReviewBeginResultDto, nowMs?: number): PreviewItem[] {
    return preview(envelopeFromRow(begin.state), nowMs ?? begin.nowMs);
  }

  async submit(action: SubmitAction): Promise<SubmitReviewResultDto> {
    const sanity = this.deps.clock.check();
    if (!sanity.ok) {
      throw new ClockAnomaly(sanity.regressionMs);
    }
    const nowMs = this.deps.clock.nowMs();
    const requestId = action.requestId ?? (this.deps.newRequestId ?? defaultNewRequestId)();
    // §10.3：重学从空状态评新正文；沿用原算法状态评当前正文
    const envelope =
      action.changeResolution === "RESET"
        ? initialize(nowMs)
        : envelopeFromRow(action.begin.state);
    const result = schedule({ state: envelope, rating: action.rating, nowMs });
    const request: SubmitReviewRequestDto = {
      requestId,
      token: action.begin.token,
      rating: RATING_VALUE[action.rating],
      nowMs,
      changeResolution: action.changeResolution ?? null,
      contextUsed: action.contextUsed ?? false,
      durationMs: action.durationMs ?? null,
      outcome: toOutcome(result),
    };
    // 超时重试复用同一请求（含同一 nowMs——重放到已保存结果即幂等返回）
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.deps.ipc.reviewSubmit(request);
      } catch (e) {
        lastError = e;
        if (!isRetryable(e)) {
          throw e;
        }
      }
    }
    throw lastError;
  }

  setParticipation(blockIds: string[], action: ParticipationAction): Promise<number> {
    return this.deps.ipc.reviewSetParticipation(blockIds, action);
  }

  resetBlock(blockId: string): Promise<ResetBlockResultDto> {
    return this.deps.ipc.reviewResetBlock(blockId);
  }
}
