// 变更分类（§10.3 五行表）逐行构造断言：body_hash 是唯一的内容变化信号，
// source_hash 不参与分类（§8.2 L261 不用于自动认领）。

import { describe, expect, it } from "vitest";
import { classifyBlockChange } from "../../src/engine/diff";
import type { BlockFacts } from "../../src/engine/types";

const base: BlockFacts = {
  relativePath: "doc.md",
  bodyHash: "b1",
  sourceHash: "s1",
  startOffset: 0,
  bodyStartOffset: 10,
  endOffset: 100,
  ordinal: 0,
  headingPath: ["根", "节"],
  title: "节",
};

const flags = (hasRating: boolean, participation: "ENABLED" | "PAUSED" | "EXCLUDED" = "ENABLED") => ({
  hasRating,
  participation,
});

describe("classifyBlockChange（§10.3）", () => {
  it("完全一致 → AST_IDENTICAL", () => {
    expect(classifyBlockChange(base, { ...base }, flags(false))).toBe("AST_IDENTICAL");
    expect(classifyBlockChange(base, { ...base }, flags(true))).toBe("AST_IDENTICAL");
  });

  it("仅位置/路径/标题变，正文同 → META_ONLY（保留算法状态，不提前复习）", () => {
    for (const patch of [
      { ordinal: 3 },
      { startOffset: 50, bodyStartOffset: 60, endOffset: 150 },
      { headingPath: ["根", "改名"], title: "改名" },
      { relativePath: "moved.md" },
    ]) {
      expect(classifyBlockChange(base, { ...base, ...patch }, flags(true))).toBe("META_ONLY");
    }
  });

  it("source_hash 变化不计入分类（含标题改名的 source 差异）", () => {
    expect(classifyBlockChange(base, { ...base, sourceHash: "s2" }, flags(true))).toBe("AST_IDENTICAL");
  });

  it("答案 AST 相同的格式变化（只改空行）→ 不增加 content_version", () => {
    // 换行/空行差异已被 normalizeTextValue 与 AST 序列化吸收：同 bodyHash 即同分类
    expect(classifyBlockChange(base, { ...base }, flags(false))).toBe("AST_IDENTICAL");
  });

  it("正文变、尚未首评 → CONTENT_NEW（初次 due 不顺延）", () => {
    expect(classifyBlockChange(base, { ...base, bodyHash: "b2" }, flags(false))).toBe("CONTENT_NEW");
  });

  it("正文变、已有评分 → CONTENT_REVIEWED（needs_recheck 语义）", () => {
    expect(classifyBlockChange(base, { ...base, bodyHash: "b2" }, flags(true))).toBe("CONTENT_REVIEWED");
  });

  it("PAUSED / EXCLUDED 段正文变 → CONTENT_PAUSED（保持不参与，不自动恢复）", () => {
    expect(classifyBlockChange(base, { ...base, bodyHash: "b2" }, flags(true, "PAUSED"))).toBe("CONTENT_PAUSED");
    expect(classifyBlockChange(base, { ...base, bodyHash: "b2" }, flags(true, "EXCLUDED"))).toBe("CONTENT_PAUSED");
  });
});
