// 插入计划（§9.2 L312、§13.1）：只新增注释行、不重排（apply 后 strip 必须精确还原）；
// 有协议痕迹/Git 冲突的文件不自动插入。

import { describe, expect, it } from "vitest";
import { analyzeDocument } from "../../src/engine/analyze";
import { applyInsertions, stripInsertions } from "../../src/engine/insertion";
import { readFixture } from "../fixtures/load";

const FIXED_ID = "11111111-1111-4111-8111-111111111111";

async function planFor(rel: string, policy: "none" | "missing") {
  const text = readFixture(rel);
  const rep = await analyzeDocument(
    { relativePath: "doc.md", text, rawByteHash: "" },
    { insertionPolicy: policy, generateIds: () => FIXED_ID },
  );
  return { text, rep };
}

const cases = [
  { file: "insert-basic.md", note: "标题后插入" },
  { file: "insert-preamble.md", note: "无 frontmatter 前言：锚点独占首行" },
  { file: "insert-after-setext.md", note: "Setext：插在下划线之后而非标题与下划线之间" },
  { file: "insert-no-blank-line.md", note: "标题紧贴正文：插入后注释独占一行" },
];

describe("插入计划", () => {
  for (const c of cases) {
    const name = c.file.replace(/\.md$/, "");
    it(`${c.note}（${c.file}）`, async () => {
      const { text, rep } = await planFor(`insertion/${c.file}`, "missing");
      expect(rep.insertionPlan).toHaveLength(1);
      expect(rep.insertionPlan[0].blockId).toBe(FIXED_ID);
      const { text: out } = applyInsertions(text, rep.insertionPlan);
      expect(out).toBe(readFixture(`insertion/${name}.expected.md`));
      // 不重排的双重断言：strip 精确还原原文
      expect(stripInsertions(out, rep.insertionPlan)).toBe(text);
    });
  }

  it("policy none：无写副作用（恒空计划）", async () => {
    const { rep } = await planFor("insertion/insert-basic.md", "none");
    expect(rep.insertionPlan).toEqual([]);
  });

  it("候选已有任何协议痕迹：不自动插入，留给显式修复", async () => {
    for (const f of ["23-comment-mid-body.md", "24-two-ids-one-candidate.md", "25-malformed-uuid.md"]) {
      const { rep } = await planFor(`boundaries/${f}`, "missing");
      expect(rep.insertionPlan).toEqual([]);
    }
  });

  it("Git 冲突文档：indexable=false，即使 policy missing 也不插入", async () => {
    const { rep } = await planFor("boundaries/20-git-conflict-markers.md", "missing");
    expect(rep.indexable).toBe(false);
    expect(rep.insertionPlan).toEqual([]);
  });
});
