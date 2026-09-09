// 边界样例（设计 §8.3 表 + §8.1/§9.2 正文样例 + §15.2 性能形状）：
// 全部 26 个 fixture 参数化跑单文件分析，对照 .expect.json 子集断言。

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeDocument } from "../../src/engine/analyze";
import { FIXTURE_ROOT, readFixture, readJson, subsetMismatch } from "../fixtures/load";

const dir = join(FIXTURE_ROOT, "boundaries");
const cases = readdirSync(dir)
  .filter((f) => f.endsWith(".md"))
  .sort();

interface BoundaryExpect {
  blocks?: unknown[];
  unqualified?: unknown[];
  diagnosticCodes?: string[];
  indexable?: boolean;
}

describe("边界样例（§8.3/§8.1/§9.2/§15.2）", () => {
  for (const file of cases) {
    const name = file.replace(/\.md$/, "");
    it(name, async () => {
      const text = readFixture(`boundaries/${file}`);
      const exp = readJson<BoundaryExpect>(`boundaries/${name}.expect.json`);
      const rep = await analyzeDocument(
        { relativePath: "doc.md", text, rawByteHash: "h0" },
        { insertionPolicy: "none" },
      );

      // 无写副作用：policy "none" 恒产空计划（验收标准 L1133）
      expect(rep.insertionPlan).toEqual([]);

      // 非重叠 + ordinal 连续（§8.1/ADR-003：每个 fixture 都钉）
      rep.blocks.forEach((b, i) => {
        expect(b.ordinal).toBe(i);
        if (i > 0) {
          expect(b.startOffset).toBeGreaterThanOrEqual(rep.blocks[i - 1].endOffset);
        }
      });

      if (exp.blocks) {
        expect(rep.blocks.length).toBe(exp.blocks.length);
        exp.blocks.forEach((e, i) => {
          const m = subsetMismatch(rep.blocks[i], e);
          if (m) throw new Error(m);
        });
      }
      if (exp.unqualified) {
        expect(rep.unqualifiedHeadings.length).toBe(exp.unqualified.length);
        exp.unqualified.forEach((e, i) => {
          const m = subsetMismatch(rep.unqualifiedHeadings[i], e);
          if (m) throw new Error(m);
        });
      }
      if (exp.diagnosticCodes) {
        const actual = rep.diagnostics.map((d) => d.code).sort().join(",");
        expect(actual).toBe([...exp.diagnosticCodes].sort().join(","));
      }
      if (exp.indexable !== undefined) {
        expect(rep.indexable).toBe(exp.indexable);
      }
    });
  }
});
