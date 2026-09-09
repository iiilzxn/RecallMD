// 版本变更分类（设计 §10.3 L405–411 五行表）：
// - body_hash 变才视为正文变化（content_version +1）；位置/路径/标题变只更新索引
// - source_hash 不参与分类（不用于自动认领，§8.2 L261）
// - 调度行为（needs_recheck 的后续处置）属 M5；M3 只产出分类事实

import type { BlockFacts, ContentChangeClass, Participation } from "./types";
export interface ClassifyFlags {
  hasRating: boolean;
  participation: Participation;
}

export function classifyBlockChange(prev: BlockFacts, next: BlockFacts, flags: ClassifyFlags): ContentChangeClass {
  if (prev.bodyHash !== next.bodyHash) {
    if (flags.participation !== "ENABLED") return "CONTENT_PAUSED";
    return flags.hasRating ? "CONTENT_REVIEWED" : "CONTENT_NEW";
  }
  const metaChanged =
    prev.relativePath !== next.relativePath ||
    prev.startOffset !== next.startOffset ||
    prev.bodyStartOffset !== next.bodyStartOffset ||
    prev.endOffset !== next.endOffset ||
    prev.ordinal !== next.ordinal ||
    prev.headingPath.join("\u0000") !== next.headingPath.join("\u0000") ||
    (prev.title ?? "") !== (next.title ?? "");
  return metaChanged ? "META_ONLY" : "AST_IDENTICAL";
}
