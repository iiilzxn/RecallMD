// analyzeDocument 端到端：确定性、输入不可变、防御性拒绝、DTO 约定。

import { describe, expect, it } from "vitest";
import { analyzeDocument, PARSER_VERSION } from "../../src/engine/analyze";
import { readFixture } from "../fixtures/load";

const input = () => ({
  relativePath: "notes/redis.md",
  text: readFixture("boundaries/21-design-example.md"),
  rawByteHash: "abc123",
});

describe("analyzeDocument", () => {
  it("确定性：同输入两次运行结果 deepEqual（幂等前提，§12.5 L766）", async () => {
    const [r1, r2] = await Promise.all([analyzeDocument(input()), analyzeDocument(input())]);
    expect(r1).toEqual(r2);
  });

  it("输入不可变（纯函数）", async () => {
    const i = input();
    const snapshot = JSON.parse(JSON.stringify(i));
    Object.freeze(i);
    Object.freeze(i.text);
    await analyzeDocument(i);
    expect(JSON.parse(JSON.stringify(i))).toEqual(snapshot);
  });

  it("revision === rawByteHash（过时结果丢弃依据，§15.2）", async () => {
    const rep = await analyzeDocument(input());
    expect(rep.revision).toBe("abc123");
    expect(rep.parserVersion).toBe(PARSER_VERSION);
    expect(rep.parserVersion).toMatch(/\/fingerprint-v1$/);
  });

  it("哈希形状：64 位小写 hex", async () => {
    const rep = await analyzeDocument(input());
    for (const b of rep.blocks) {
      expect(b.sourceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(b.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("防御性拒绝：CR 输入抛 NON_LF_INPUT，BOM 输入抛 BOM_INPUT", async () => {
    await expect(
      analyzeDocument({ relativePath: "x.md", text: "# A\r\n正文", rawByteHash: "" }),
    ).rejects.toMatchObject({ code: "NON_LF_INPUT" });
    await expect(
      analyzeDocument({ relativePath: "x.md", text: "﻿# A\n正文", rawByteHash: "" }),
    ).rejects.toMatchObject({ code: "BOM_INPUT" });
  });

  it("26：行数超限的块标 oversized 并给提示级诊断", async () => {
    const rep = await analyzeDocument({
      relativePath: "doc.md",
      text: readFixture("boundaries/26-oversized-block.md"),
      rawByteHash: "",
    });
    expect(rep.blocks).toHaveLength(1);
    expect(rep.blocks[0].oversized).toBe(true);
    expect(rep.diagnostics.map((d) => d.code)).toContain("BLOCK_OVERSIZED");
  });
});
