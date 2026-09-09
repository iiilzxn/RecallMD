// 锚点扫描边界（§9.2 L308–310）：合法锚位 / 错位 / 额外 / 畸形 / 代码内不生效。

import { describe, expect, it } from "vitest";
import { analyzeDocument } from "../../src/engine/analyze";
import { readFixture } from "../fixtures/load";

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";

async function run(file: string) {
  return analyzeDocument(
    { relativePath: "doc.md", text: readFixture(`boundaries/${file}`), rawByteHash: "h0" },
    { insertionPolicy: "none" },
  );
}

describe("锚点扫描", () => {
  it("21：三个合法锚点各就各位", async () => {
    const rep = await run("21-design-example.md");
    expect(rep.anchorOccurrences).toHaveLength(3);
    expect(rep.anchorOccurrences.every((o) => o.placement === "LEGAL_ANCHOR")).toBe(true);
    expect(rep.anchorOccurrences.map((o) => o.blockId)).toEqual([ID_A, ID_B, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
    expect(rep.diagnostics).toEqual([]);
  });

  it("23：正文中间的协议注释是 MISPLACED + ID_MISPLACED", async () => {
    const rep = await run("23-comment-mid-body.md");
    expect(rep.anchorOccurrences).toHaveLength(1);
    expect(rep.anchorOccurrences[0].placement).toBe("MISPLACED");
    expect(rep.blocks[0].blockId).toBeNull();
    expect(rep.diagnostics.map((d) => d.code)).toEqual(["ID_MISPLACED"]);
  });

  it("24：同候选第二枚 → MISPLACED + ID_EXTRA，首枚仍是合法锚", async () => {
    const rep = await run("24-two-ids-one-candidate.md");
    expect(rep.anchorOccurrences).toHaveLength(2);
    const [first, second] = rep.anchorOccurrences;
    expect(first.placement).toBe("LEGAL_ANCHOR");
    expect(first.blockId).toBe(ID_A);
    expect(second.placement).toBe("MISPLACED");
    expect(second.blockId).toBe(ID_B);
    expect(rep.blocks[0].blockId).toBe(ID_A);
    expect(rep.diagnostics.map((d) => d.code)).toEqual(["ID_EXTRA"]);
  });

  it("25：形似协议但 UUID 非法 → malformed，不给块身份", async () => {
    const rep = await run("25-malformed-uuid.md");
    expect(rep.anchorOccurrences).toHaveLength(1);
    expect(rep.anchorOccurrences[0].malformed).toBe(true);
    expect(rep.anchorOccurrences[0].blockId).toBeNull();
    expect(rep.blocks[0].blockId).toBeNull();
    expect(rep.diagnostics.map((d) => d.code)).toEqual(["ID_MALFORMED"]);
  });

  it("22：围栏代码内的示例注释完全不进入扫描", async () => {
    const rep = await run("22-comment-in-code.md");
    expect(rep.anchorOccurrences).toEqual([]);
    expect(rep.diagnostics).toEqual([]);
  });

  it("10：破坏 Setext 的注释落在正文里 → MISPLACED，无标题成 PREAMBLE", async () => {
    const rep = await run("10-setext-comment-gap.md");
    expect(rep.blocks).toHaveLength(1);
    expect(rep.blocks[0].kind).toBe("PREAMBLE");
    expect(rep.blocks[0].blockId).toBeNull();
    expect(rep.diagnostics.map((d) => d.code)).toEqual(["ID_MISPLACED"]);
  });
});
