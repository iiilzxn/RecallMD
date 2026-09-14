// M5 FSRS 调度适配器（设计 §11.3 独立接口）：ts-fsrs@5.4.2 冻结版的唯一生产封装。
// 纪律：本模块及其调用链禁止 Date.now()/performance.now()——nowMs 一律注入；
// Date 序列化为 ISO-8601 毫秒、反序列化显式还原（不能把字符串直接传给库）。
// 算法身份三元组与 config 必须与 Rust fsrs.rs 模板逐字一致（fsrsContract.spec 钉死）。

import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  type Card,
  type FSRS,
  type Grade,
} from "ts-fsrs";

export const ALGORITHM_ID = "fsrs";
export const ALGORITHM_VERSION = "ts-fsrs@5.4.2+FSRS-6.0";
export const STATE_SCHEMA_VERSION = 1;

/** §10.4 四级反馈（存储值 1–4） */
export type RatingName = "Again" | "Hard" | "Good" | "Easy";
export const RATING_VALUE: Readonly<Record<RatingName, 1 | 2 | 3 | 4>> = {
  Again: 1,
  Hard: 2,
  Good: 3,
  Easy: 4,
};
export const RATING_NAMES: readonly RatingName[] = ["Again", "Hard", "Good", "Easy"];

/** §10.1 phase：与 ts-fsrs State 枚举一一对应（0/1/2/3） */
export type Phase = "NEW" | "LEARNING" | "REVIEW" | "RELEARNING";
const PHASE_BY_STATE: readonly Phase[] = ["NEW", "LEARNING", "REVIEW", "RELEARNING"];

export function phaseOfState(stateNum: number): Phase {
  const phase = PHASE_BY_STATE[stateNum];
  if (!phase) {
    throw new Error(`未知算法 state：${stateNum}`);
  }
  return phase;
}

/** ts-fsrs Card 的无损 JSON 形状（toJSON；last_review 未评分时键不存在） */
export interface NativeCardJson {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  learning_steps: number;
  state: number;
  last_review?: string;
}

/** §11.3 SchedulerEnvelope：算法状态权威快照 */
export interface SchedulerEnvelope {
  algorithmId: string;
  algorithmVersion: string;
  stateSchemaVersion: number;
  config: Record<string, unknown>;
  nativeState: NativeCardJson;
}

/** §11.2 展开的冻结配置（与 Rust fsrs.rs CONFIG_JSON 逐键一致） */
export function frozenConfig(): Record<string, unknown> {
  return generatorParameters({
    request_retention: 0.9,
    maximum_interval: 3650,
    enable_fuzz: false,
    enable_short_term: true,
    learning_steps: ["1m", "10m"],
    relearning_steps: ["10m"],
  }) as unknown as Record<string, unknown>;
}

let scheduler: FSRS | null = null;

function frozenScheduler(): FSRS {
  if (!scheduler) {
    scheduler = fsrs(frozenConfig() as Parameters<typeof fsrs>[0]);
  }
  return scheduler;
}

/** envelope 身份校验：算法漂移即抛错（§11.2 不静默换参数），不降级运行 */
export function assertEnvelopeIdentity(envelope: SchedulerEnvelope): void {
  if (
    envelope.algorithmId !== ALGORITHM_ID ||
    envelope.algorithmVersion !== ALGORITHM_VERSION ||
    envelope.stateSchemaVersion !== STATE_SCHEMA_VERSION
  ) {
    throw new Error(
      `算法身份漂移：${envelope.algorithmId}@${envelope.algorithmVersion}` +
        ` v${envelope.stateSchemaVersion}，本适配器为 ${ALGORITHM_ID}@${ALGORITHM_VERSION}` +
        ` v${STATE_SCHEMA_VERSION}（须走 §11.4 迁移流程）`,
    );
  }
  const frozen = frozenConfig();
  const keys = new Set([...Object.keys(frozen), ...Object.keys(envelope.config)]);
  for (const k of keys) {
    if (JSON.stringify(frozen[k]) !== JSON.stringify(envelope.config[k])) {
      throw new Error(`算法配置键 ${k} 与冻结值不一致（${JSON.stringify(envelope.config[k])}）`);
    }
  }
}

/** JSON → Card：due/last_review 显式还原为 Date（§11.3 L499） */
export function reviveCard(json: NativeCardJson): Card {
  const card = createEmptyCard(new Date(json.due));
  card.stability = json.stability;
  card.difficulty = json.difficulty;
  card.elapsed_days = json.elapsed_days;
  card.scheduled_days = json.scheduled_days;
  card.reps = json.reps;
  card.lapses = json.lapses;
  card.learning_steps = json.learning_steps;
  card.state = json.state as Card["state"];
  if (json.last_review !== undefined) {
    card.last_review = new Date(json.last_review);
  } else {
    card.last_review = undefined;
  }
  return card;
}

/** Card → 无损 JSON（Date 经 toJSON 成 ISO-8601 毫秒；undefined 键自然丢弃） */
export function cardToJson(card: Card): NativeCardJson {
  return JSON.parse(JSON.stringify(card)) as NativeCardJson;
}

/**
 * 初始化空状态（§11.3 initialize）。重置语义：due=now（§10.2 L394）。
 * 首次登记的 24h 首提由 Rust M4 写入，不经本函数。
 */
export function initialize(nowMs: number): SchedulerEnvelope {
  assertIdentityOnly();
  const card = createEmptyCard(new Date(nowMs));
  return envelopeOf(card);
}

function assertIdentityOnly(): void {
  // frozenScheduler() 构造即验证配置可被库接受；身份断言见 assertEnvelopeIdentity
}

function envelopeOf(card: Card): SchedulerEnvelope {
  return {
    algorithmId: ALGORITHM_ID,
    algorithmVersion: ALGORITHM_VERSION,
    stateSchemaVersion: STATE_SCHEMA_VERSION,
    config: frozenConfig(),
    nativeState: cardToJson(card),
  };
}

/** §11.3 schedule：推进一次评分。history 参数不需要（在线 FSRS，状态自足）。 */
export interface ScheduleInput {
  state: SchedulerEnvelope;
  rating: RatingName;
  nowMs: number;
}

export interface ScheduleResult {
  envelope: SchedulerEnvelope;
  phase: Phase;
  scheduledDueAt: number;
  intervalMs: number;
  stability: number | null;
  difficulty: number | null;
  reps: number;
  lapses: number;
  /** 原生 ReviewLog 的无损 JSON（Date 同样 ISO 化） */
  log: Record<string, unknown>;
}

export function schedule(input: ScheduleInput): ScheduleResult {
  const { state, rating, nowMs } = input;
  assertEnvelopeIdentity(state);
  const card = reviveCard(state.nativeState);
  const next = frozenScheduler().next(card, new Date(nowMs), RATING_VALUE[rating] as Grade);
  const dueMs = next.card.due.getTime();
  const projected = projectCard(next.card);
  return {
    envelope: envelopeOf(next.card),
    phase: projected.phase,
    scheduledDueAt: dueMs,
    intervalMs: dueMs - nowMs,
    stability: projected.stability,
    difficulty: projected.difficulty,
    reps: next.card.reps,
    lapses: next.card.lapses,
    log: JSON.parse(JSON.stringify(next.log)) as Record<string, unknown>,
  };
}

/** §10.4 四间隔预览：揭示题面时展示；非持久承诺，正式点击用新 now 重算 */
export interface PreviewItem {
  rating: RatingName;
  phase: Phase;
  scheduledDueAt: number;
  intervalMs: number;
}

export function preview(state: SchedulerEnvelope, nowMs: number): PreviewItem[] {
  assertEnvelopeIdentity(state);
  const card = reviveCard(state.nativeState);
  const table = frozenScheduler().repeat(card, new Date(nowMs));
  return RATING_NAMES.map((rating) => {
    const item = table[RATING_VALUE[rating]];
    const dueMs = item.card.due.getTime();
    return {
      rating,
      phase: phaseOfState(item.card.state),
      scheduledDueAt: dueMs,
      intervalMs: dueMs - nowMs,
    };
  });
}

/** 空状态投影为 NULL、已估状态投影为实值（§11.2 L460；与 Rust validate_outcome 对称） */
function projectCard(card: Card): { phase: Phase; stability: number | null; difficulty: number | null } {
  const phase = phaseOfState(card.state);
  if (card.state === 0) {
    return { phase, stability: null, difficulty: null };
  }
  return { phase, stability: card.stability, difficulty: card.difficulty };
}

/**
 * 行数据（review_begin 应答）→ envelope。Rust 侧 config_json/state_json 是字符串。
 */
export function envelopeFromRow(row: {
  algorithmId: string;
  algorithmVersion: string;
  stateSchemaVersion: number;
  configJson: string;
  stateJson: string;
}): SchedulerEnvelope {
  return {
    algorithmId: row.algorithmId,
    algorithmVersion: row.algorithmVersion,
    stateSchemaVersion: row.stateSchemaVersion,
    config: JSON.parse(row.configJson) as Record<string, unknown>,
    nativeState: JSON.parse(row.stateJson) as NativeCardJson,
  };
}

/** 送回 Rust 的算法产出 DTO（wire 形状钉死于 seam.spec） */
export interface SchedulerOutcome {
  stateJson: string;
  scheduledDueAt: number;
  phase: Phase;
  stability: number | null;
  difficulty: number | null;
  intervalMs: number;
  reps: number;
  lapses: number;
  logJson: string | null;
}

export function toOutcome(result: ScheduleResult): SchedulerOutcome {
  return {
    stateJson: JSON.stringify(result.envelope.nativeState),
    scheduledDueAt: result.scheduledDueAt,
    phase: result.phase,
    stability: result.stability,
    difficulty: result.difficulty,
    intervalMs: result.intervalMs,
    reps: result.reps,
    lapses: result.lapses,
    logJson: JSON.stringify(result.log),
  };
}
