// M4 引擎补缝（M3/M4 seam）：DELETED 状态的 reconcile 语义
// （§9.4 L352/L358：用户删除不降级 MISSING；删除块复现走 RESTORE）。

import { describe, expect, it } from "vitest";
import { analyzeDocument } from "../../src/engine/analyze";
import { reconcileSnapshots, type FileSnapshot } from "../../src/engine/reconcile";
import type { RegisteredBlock } from "../../src/engine/types";

const UUID = "12345678-1234-4123-8123-123456789abc";
const DOC = `# 标题

<!-- recall:block:${UUID} -->

答案正文。
`;

async function registryOf(status: RegisteredBlock["status"]): Promise<RegisteredBlock[]> {
  const rep = await analyzeDocument({ relativePath: "a.md", text: DOC, rawByteHash: "" });
  const b = rep.blocks.find((x) => x.blockId === UUID);
  if (!b) throw new Error("fixture 未产生目标块");
  return [
    {
      blockId: UUID,
      relativePath: "a.md",
      bodyHash: b.bodyHash,
      sourceHash: b.sourceHash,
      startOffset: b.startOffset,
      bodyStartOffset: b.bodyStartOffset,
      endOffset: b.endOffset,
      ordinal: b.ordinal,
      headingPath: b.headingPath,
      title: b.title,
      kind: "SECTION",
      headingLevel: 1,
      contentVersion: 1,
      status,
      hasRating: false,
      participation: "ENABLED",
    },
  ];
}

describe("M4：DELETED 语义", () => {
  it("已删除块未重现 → NOOP + 保持 DELETED（不降级 MISSING）", async () => {
    const report = await reconcileSnapshots({
      snapshots: [{ relativePath: "a.md", text: DOC.replace(`<!-- recall:block:${UUID} -->\n\n`, "") } as FileSnapshot],
      registry: await registryOf("DELETED"),
    });
    const r = report.blockResults.find((x) => x.blockId === UUID);
    expect(r?.action).toBe("NOOP");
    expect(r?.status).toBe("DELETED");
  });

  it("已删除块复现（正文同）→ RESTORE + ACTIVE + delta 0", async () => {
    const report = await reconcileSnapshots({
      snapshots: [{ relativePath: "a.md", text: DOC }],
      registry: await registryOf("DELETED"),
    });
    const r = report.blockResults.find((x) => x.blockId === UUID);
    expect(r?.action).toBe("RESTORE");
    expect(r?.status).toBe("ACTIVE");
    expect(r?.contentVersionDelta).toBe(0);
    expect(r?.next?.contentVersion).toBe(1);
  });

  it("已删除块复现且正文变 → RESTORE + delta 1", async () => {
    const report = await reconcileSnapshots({
      snapshots: [{ relativePath: "a.md", text: DOC.replace("答案正文。", "重写后的答案。") }],
      registry: await registryOf("DELETED"),
    });
    const r = report.blockResults.find((x) => x.blockId === UUID);
    expect(r?.action).toBe("RESTORE");
    expect(r?.contentVersionDelta).toBe(1);
    expect(r?.next?.contentVersion).toBe(2);
    // 未首评 ENABLED 段不设 recheck（§10.3 行3）
    expect(r?.needsRecheck).toBe(false);
  });

  it("DELETED 块卷入多处重现 → 保持 DELETED 交显式修复（不进冲突裁决）", async () => {
    const dup = DOC + `\n## 小节\n\n<!-- recall:block:${UUID} -->\n\n副本正文。\n`;
    const report = await reconcileSnapshots({
      snapshots: [{ relativePath: "a.md", text: dup }],
      registry: await registryOf("DELETED"),
    });
    const r = report.blockResults.find((x) => x.blockId === UUID);
    expect(r?.action).toBe("NOOP");
    expect(r?.status).toBe("DELETED");
    expect(report.diagnostics.some((d) => d.code === "ID_DUPLICATED")).toBe(true);
  });
});
