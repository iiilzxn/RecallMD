// 性能样例（§15.2 L1008–1015 常规预算）：100KiB 代码块与 500 块文档常跑正确性 + 宽松耗时；
// 50k 行 / 500 块 reconcile 大样例仅在 pnpm test:perf（RUN_PERF=1）下执行。

import { describe, expect, it } from "vitest";
import { analyzeDocument } from "../../src/engine/analyze";
import { applyInsertions } from "../../src/engine/insertion";
import { applyProposals, reconcileSnapshots, type FileSnapshot } from "../../src/engine/reconcile";
import type { RegisteredBlock } from "../../src/engine/types";
import { readFixture } from "../fixtures/load";

const RUN_PERF = !!process.env.RUN_PERF;

describe("性能样例（常规）", () => {
  it("100KiB 代码块：<5s 解析且块信息正确", async () => {
    const text = readFixture("perf/code-block-100k.md");
    const t0 = Date.now();
    const rep = await analyzeDocument({ relativePath: "doc.md", text, rawByteHash: "" });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(rep.blocks).toHaveLength(1);
    expect(rep.blocks[0].oversized).toBe(true);
  });

  it("500 块文档：块数正确、offset 单调", async () => {
    const text = readFixture("perf/many-blocks-500.md");
    const t0 = Date.now();
    const rep = await analyzeDocument({ relativePath: "doc.md", text, rawByteHash: "" });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(rep.blocks).toHaveLength(500);
    for (let i = 1; i < rep.blocks.length; i++) {
      expect(rep.blocks[i].startOffset).toBeGreaterThanOrEqual(rep.blocks[i - 1].endOffset);
    }
  });
});

describe("性能样例（RUN_PERF 大样例）", () => {
  it.skipIf(!RUN_PERF)("50k 行文档：30s 内完成（对照 M7 预算缩放）", async () => {
    const line = "这是性能样例行，模拟真实笔记正文，长度中等。";
    const parts: string[] = [];
    for (let i = 0; i < 6500; i++) {
      parts.push(`## 节 ${i}\n\n${line}\n${line}\n${line}\n${line}\n${line}\n`);
    }
    const text = parts.join("\n");
    expect(text.split("\n").length).toBeGreaterThan(50_000);
    const t0 = Date.now();
    const rep = await analyzeDocument({ relativePath: "doc.md", text, rawByteHash: "" });
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(rep.blocks).toHaveLength(6500);
  });

  it.skipIf(!RUN_PERF)("500 块插入锚点 + 全量 reconcile + 幂等重跑", async () => {
    const text0 = readFixture("perf/many-blocks-500.md");
    // fixture 无锚：先走插入计划（确定性 ID），得到已锚定文本再全量核对
    const seeded: string[] = [];
    for (let i = 0; i < 500; i++) seeded.push(`dddddddd-dddd-4ddd-8ddd-ddddddd${String(i).padStart(5, "0")}`);
    const planned = await analyzeDocument(
      { relativePath: "doc.md", text: text0, rawByteHash: "" },
      { insertionPolicy: "missing", generateIds: () => seeded.shift()! },
    );
    expect(planned.insertionPlan).toHaveLength(500);
    const text = applyInsertions(text0, planned.insertionPlan).text;

    const rep = await analyzeDocument({ relativePath: "doc.md", text, rawByteHash: "" });
    expect(rep.blocks.every((b) => b.blockId)).toBe(true);
    const registry: RegisteredBlock[] = rep.blocks.map((b) => ({
      relativePath: "doc.md",
      bodyHash: b.bodyHash,
      sourceHash: b.sourceHash,
      startOffset: b.startOffset,
      bodyStartOffset: b.bodyStartOffset,
      endOffset: b.endOffset,
      ordinal: b.ordinal,
      headingPath: b.headingPath,
      title: b.title,
      blockId: b.blockId!,
      kind: b.kind,
      headingLevel: b.headingLevel,
      contentVersion: 1,
      status: "ACTIVE",
      hasRating: false,
      participation: "ENABLED",
    }));
    const snapshots: FileSnapshot[] = [{ relativePath: "doc.md", text }];
    const t0 = Date.now();
    const r1 = await reconcileSnapshots({ snapshots, registry });
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(r1.blockResults.every((r) => r.action === "NOOP")).toBe(true);
    expect(applyProposals(registry, r1)).toEqual(registry);
  });
});
