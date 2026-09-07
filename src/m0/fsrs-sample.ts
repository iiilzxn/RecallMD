// M0 验证：ts-fsrs 四 Rating 预览/next 一致性 + JSON 序列化往返（含 Date 复原，设计 §11.3 的关键约束）
import {
  fsrs,
  generatorParameters,
  createEmptyCard,
  Rating,
  State,
  FSRSVersion,
  type Card,
} from "ts-fsrs";

export type FsrsRow = {
  grade: string;
  state: string;
  dueInMin: number;
  intervalDays: number | null;
  stability: number;
  difficulty: number;
  previewMatchesNext: boolean;
};

export type FsrsReport = {
  fsrsVersion: string;
  rows: FsrsRow[];
  roundtripOk: boolean;
  roundtripDetail: string;
};

const T0 = new Date("2026-09-07T10:00:00Z");
const T1 = new Date("2026-09-07T10:01:00Z");

function reviveCard(plain: Record<string, unknown>): Card {
  // 设计文档 §11.3：Date 序列化为 UTC 毫秒/ISO 字符串，反序列化必须显式还原，
  // 不能把字符串直接传给库
  return {
    ...(plain as unknown as Card),
    due: new Date(plain.due as string),
    last_review: plain.last_review ? new Date(plain.last_review as string) : undefined,
  };
}

export function runFsrsSample(): FsrsReport {
  const params = generatorParameters({
    request_retention: 0.9,
    maximum_interval: 3650,
    enable_fuzz: false,
    enable_short_term: true,
    learning_steps: ["1m", "10m"],
    relearning_steps: ["10m"],
  });
  const f = fsrs(params);
  const card = createEmptyCard(T0);
  const preview = f.repeat(card, T0);

  const rows: FsrsRow[] = ([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const).map((g) => {
    const item = f.next(card, T0, g);
    const viaPreview = preview[g];
    const dueMs = item.card.due.getTime() - T0.getTime();
    return {
      grade: Rating[g],
      state: State[item.card.state],
      dueInMin: Math.round((dueMs / 60000) * 100) / 100,
      intervalDays: item.log.scheduled_days ?? null,
      stability: item.card.stability,
      difficulty: item.card.difficulty,
      previewMatchesNext:
        item.card.due.getTime() === viaPreview.card.due.getTime() &&
        item.card.state === viaPreview.card.state &&
        item.card.reps === viaPreview.card.reps,
    };
  });

  // Good 评分 → 10 分钟学习步骤 → JSON 往返 → 复原后再评 Easy，应与不经过往返的结果一致
  const afterGood = f.next(card, T0, Rating.Good).card;
  const revived = reviveCard(JSON.parse(JSON.stringify(afterGood)) as Record<string, unknown>);
  const direct = f.next(afterGood, T1, Rating.Easy).card;
  const fromRevived = f.next(revived, T1, Rating.Easy).card;
  const roundtripOk =
    direct.due.getTime() === fromRevived.due.getTime() &&
    direct.stability === fromRevived.stability &&
    direct.difficulty === fromRevived.difficulty &&
    direct.state === fromRevived.state;

  return {
    fsrsVersion: FSRSVersion,
    rows,
    roundtripOk,
    roundtripDetail: `after-Good card → JSON → revive(Date) → Easy@+1min: due ${fromRevived.due.toISOString()} / state ${State[fromRevived.state]} / S=${fromRevived.stability.toFixed(2)} / D=${fromRevived.difficulty.toFixed(2)}`,
  };
}
