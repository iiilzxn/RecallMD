// 生成 M5 FSRS golden fixtures（升级检测用，设计 §11.4 L507）。
// 用法：node tests/fixtures/fsrs-golden/generate-golden.mjs
// 产物提交入库；vitest golden.spec.ts 用真实 scheduler 模块逐值对照。
// 若 ts-fsrs 升级后重跑产生差异，须人工审阅并按 §11.4 迁移流程处理，不许静默接受。

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyCard, fsrs, generatorParameters, Rating } from "ts-fsrs";

const here = dirname(fileURLToPath(import.meta.url));

// §11.2 冻结配置（与 src/review/scheduler.ts frozenConfig 一致）
const params = generatorParameters({
  request_retention: 0.9,
  maximum_interval: 3650,
  enable_fuzz: false,
  enable_short_term: true,
  learning_steps: ["1m", "10m"],
  relearning_steps: ["10m"],
});
const f = fsrs(params);

const T0 = Date.UTC(2026, 8, 14, 8, 0, 0, 0); // 2026-09-14T08:00:00.000Z
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function cardJson(card) {
  return JSON.parse(JSON.stringify(card));
}

function logJson(log) {
  return JSON.parse(JSON.stringify(log));
}

function snap(card, log, nowMs) {
  const dueMs = card.due.getTime();
  return {
    now: new Date(nowMs).toISOString(),
    rating: null, // 调用方填
    before: null, // 调用方填
    after: cardJson(card),
    projections: {
      phase: ["NEW", "LEARNING", "REVIEW", "RELEARNING"][card.state],
      dueMs,
      intervalMs: dueMs - nowMs,
      stability: card.state === 0 ? null : card.stability,
      difficulty: card.state === 0 ? null : card.difficulty,
      reps: card.reps,
      lapses: card.lapses,
    },
    log: logJson(log),
  };
}

function empty(nowMs) {
  return createEmptyCard(new Date(nowMs));
}

// --- 1. 首评四 Rating（空卡出发） ---
const first = [];
for (const r of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) {
  const item = f.next(empty(T0), new Date(T0), r);
  const s = snap(item.card, item.log, T0);
  s.rating = Rating[r];
  s.before = cardJson(empty(T0));
  first.push(s);
}
writeFileSync(join(here, "first-rating.json"), JSON.stringify(first, null, 2));

// --- 2. 学习→复习→遗忘→重学→毕业的长期序列 ---
const seq = [];
let card = empty(T0); // 登记后 24h 首提已过（此处直接以 T0 为评分时刻）
const steps = [
  [Rating.Good, T0, "首评 Good：进入学习步骤"],
  [Rating.Good, T0 + 10 * MIN, "10 分钟后第二步 Good：毕业进 REVIEW"],
  [Rating.Easy, T0 + 10 * MIN + 3 * DAY, "3 天后 Easy：长期复习"],
  [Rating.Hard, T0 + 10 * MIN + 3 * DAY + 12 * DAY, "12 天后 Hard"],
  [Rating.Again, T0 + 10 * MIN + 3 * DAY + 12 * DAY + 30 * DAY, "30 天后 Again：遗忘进 RELEARNING"],
  [Rating.Good, T0 + 10 * MIN + 3 * DAY + 12 * DAY + 30 * DAY + 10 * MIN, "10 分钟重学步 Good"],
  [Rating.Good, T0 + 10 * MIN + 3 * DAY + 12 * DAY + 30 * DAY + 10 * MIN + 2 * DAY, "2 天后 Good：再毕业"],
];
for (const [rating, nowMs] of steps) {
  const before = cardJson(card);
  const item = f.next(card, new Date(nowMs), rating);
  card = item.card;
  const s = snap(item.card, item.log, nowMs);
  s.rating = Rating[rating];
  s.before = before;
  seq.push(s);
}
writeFileSync(join(here, "learning-path.json"), JSON.stringify(seq, null, 2));

// --- 3. 逾期：REVIEW 卡逾期 300 天后评分（elapsed 处理） ---
const overdue = [];
{
  // 先造一张 REVIEW 卡（Easy 毕业路径）
  let c = empty(T0);
  c = f.next(c, new Date(T0), Rating.Good).card;
  c = f.next(c, new Date(T0 + 10 * MIN), Rating.Good).card; // REVIEW
  c = f.next(c, new Date(T0 + 10 * MIN + 30 * DAY), Rating.Good).card; // 30 天间隔
  const late = T0 + 10 * MIN + 30 * DAY + 300 * DAY; // 逾期 300 天
  const before = cardJson(c);
  for (const r of [Rating.Again, Rating.Good]) {
    const item = f.next(c, new Date(late), r);
    const s = snap(item.card, item.log, late);
    s.rating = Rating[r];
    s.before = before;
    overdue.push(s);
  }
}
writeFileSync(join(here, "overdue.json"), JSON.stringify(overdue, null, 2));

// --- 4. 重置后评新正文 = 空卡首评（无历史泄漏） ---
const resetCase = [];
{
  let c = empty(T0);
  c = f.next(c, new Date(T0), Rating.Good).card;
  c = f.next(c, new Date(T0 + 10 * MIN), Rating.Good).card; // REVIEW，有 S/D
  const resetAt = T0 + 5 * DAY;
  const fresh = empty(resetAt); // §10.3 重学：空状态 due=操作时间
  const item = f.next(fresh, new Date(resetAt), Rating.Good);
  const s = snap(item.card, item.log, resetAt);
  s.rating = "Good";
  s.before = cardJson(fresh);
  s.note = "重置后首评与 first-rating.json 的 Good 条目逐值一致（除时间平移）";
  resetCase.push(s);
}
writeFileSync(join(here, "reset-after-history.json"), JSON.stringify(resetCase, null, 2));

// --- 5. 日界线：23:50 评分，due 跨次日零点（分钟间隔不吸附零点） ---
const boundary = [];
{
  const lateEvening = Date.UTC(2026, 8, 14, 23, 50, 0, 0);
  let c = empty(Date.UTC(2026, 8, 13, 23, 50, 0, 0));
  c = f.next(c, new Date(lateEvening - 10 * MIN - DAY), Rating.Good).card; // 学习步1
  const item = f.next(c, new Date(lateEvening), Rating.Good); // 学习步2 → 跨零点
  const s = snap(item.card, item.log, lateEvening);
  s.rating = "Good";
  s.before = cardJson(c);
  boundary.push(s);
  // 毕业间隔同样检查跨日（3 天后 23:50 评，下一 due 不落在零点）
  let c2 = item.card;
  const t2 = c2.due.getTime();
  const item2 = f.next(c2, new Date(t2 + 2 * HOUR), Rating.Easy);
  const s2 = snap(item2.card, item2.log, t2 + 2 * HOUR);
  s2.rating = "Easy";
  s2.before = cardJson(c2);
  boundary.push(s2);
}
writeFileSync(join(here, "day-boundary.json"), JSON.stringify(boundary, null, 2));

mkdirSync(here, { recursive: true });
console.log("golden fixtures 写入", here);
