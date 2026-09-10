// 接缝契约回归（2026-09-10 人工验收发现的三个 TS↔Rust 契约违规，此处钉死）：
// 1. AST_IDENTICAL 的 NOOP 不得携带 next（Rust dto.rs requires_next(NOOP)=false）
// 2. 单处出现不进 MARK_CONFLICT（Rust 要求 ≥2 处出现证据）
// 3. 旧持有方已落库 MISSING 时，跨文件单独保存的剪贴粘贴应判 RESTORE 收敛单一状态

import { describe, it, expect } from "vitest";
import { reconcileSnapshots } from "../../src/engine/reconcile";
import type { RegisteredBlock } from "../../src/engine/types";

const A_ID = "872d76a0-38db-494f-92f1-50248da28585";
const B_ID = "aac2afb4-10c2-43f4-b34a-b8fc4d6a93f2";

const docA = `# 标题甲

<!-- recall:block:${A_ID} -->

甲的正文。

## 小节

<!-- recall:block:${B_ID} -->

乙的正文。
`;

function reg(blockId: string, overrides: Partial<RegisteredBlock> = {}): RegisteredBlock {
  return {
    blockId,
    documentId: "doc-1",
    relativePath: "a.md",
    kind: "SECTION",
    headingLevel: 2,
    title: "小节",
    ordinal: 1,
    startOffset: 0,
    bodyStartOffset: 0,
    endOffset: 100,
    sourceHash: "s",
    bodyHash: "b",
    headingPath: ["标题甲", "小节"],
    contentVersion: 1,
    status: "ACTIVE",
    statusReason: null,
    hasRating: false,
    participation: "ENABLED",
    needsRecheck: false,
    ...overrides,
  } as RegisteredBlock;
}

describe("NOOP 不携带 next（AST_IDENTICAL）", () => {
  it("未变化块重发 → NOOP 且 next=null", async () => {
    // 先跑一轮拿"已登记"形态（next 携带引擎计算的全部事实），再原样重跑应产 NOOP
    const first = await reconcileSnapshots({ snapshots: [{ relativePath: "a.md", text: docA }], registry: [] });
    const created = first.blockResults.filter((r) => r.action === "CREATE" && r.next);
    expect(created.length).toBe(2);
    const registry = created.map((r) =>
      reg(r.blockId, { ...r.next!, status: "ACTIVE", statusReason: null, hasRating: false, participation: "ENABLED" }),
    );
    const second = await reconcileSnapshots({
      snapshots: [{ relativePath: "a.md", text: docA }],
      registry,
    });
    const noops = second.blockResults.filter((r) => r.action === "NOOP");
    expect(noops.length).toBeGreaterThan(0);
    for (const n of noops) expect(n.next).toBeNull();
  });
});

describe("合并簇/多余锚的冲突语义", () => {
  it("他块领地里的多余锚（ID_EXTRA）单处出现 → MARK_CONFLICT（无赢家；Rust 接受非空证据）", async () => {
    // B 的合法锚移除，其锚以错位形态落进 A 块正文之后（单处出现）
    const text = docA
      .replace(`<!-- recall:block:${B_ID} -->\n\n乙的正文。`, "乙的正文。")
      .replace("甲的正文。", `甲的正文。\n<!-- recall:block:${B_ID} -->`);
    const r = await reconcileSnapshots({ snapshots: [{ relativePath: "a.md", text }], registry: [reg(B_ID)] });
    const mc = r.blockResults.filter((x) => x.action === "MARK_CONFLICT");
    expect(mc.length).toBeGreaterThan(0);
    for (const m of mc) expect(m.occurrences.length).toBeGreaterThanOrEqual(1);
  });
});

describe("跨文件剪贴粘贴（分批保存）收敛", () => {
  it("旧持有方 MISSING + 新文件合法出现 → RESTORE 到新文件", async () => {
    const docB = `# 标题乙\n\n<!-- recall:block:${B_ID} -->\n\n乙的正文。\n`;
    const r = await reconcileSnapshots({
      snapshots: [{ relativePath: "b.md", text: docB }],
      registry: [reg(B_ID, { status: "MISSING", relativePath: "a.md" })],
    });
    const row = r.blockResults.find((x) => x.blockId === B_ID);
    expect(row?.action).toBe("RESTORE");
    expect(row?.next?.relativePath).toBe("b.md");
    expect(row?.status).toBe("ACTIVE");
  });

  it("旧持有方仍 ACTIVE 且不在批内 → 保持 DEFER（防复制误判，L316）", async () => {
    const docB = `# 标题乙\n\n<!-- recall:block:${B_ID} -->\n\n乙的正文。\n`;
    const r = await reconcileSnapshots({
      snapshots: [{ relativePath: "b.md", text: docB }],
      registry: [reg(B_ID, { status: "ACTIVE", relativePath: "a.md" })],
    });
    const row = r.blockResults.find((x) => x.blockId === B_ID);
    expect(row?.action).toBe("DEFER_VERIFY_OLD_FILE");
  });
});
