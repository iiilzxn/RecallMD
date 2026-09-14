// M4：buildCommitBatch 映射（ReconcileReport + read_document + 注册表 →
// commit_index_batch 请求）。纯函数单测，不涉 Tauri。

import { describe, expect, it } from "vitest";
import { analyzeDocument } from "../../src/engine/analyze";
import { reconcileSnapshots } from "../../src/engine/reconcile";
import { buildCommitBatch } from "../../src/index/commitBatch";
import type { RegistrySnapshot } from "../../src/index/ipc";
import type { ReadDocumentDto } from "../../src/editor/ipc";

const UUID = "87654321-4321-4321-8321-cba987654321";
const DOC = `# T

<!-- recall:block:${UUID} -->

正文。
`;

function fakeRead(hash: string): ReadDocumentDto {
  return {
    text: DOC,
    rawByteHash: hash,
    byteSize: 64,
    hasBom: false,
    lineEnding: "LF",
    mtimeMs: 1_700_000_000_000,
    fileIdentity: null,
  };
}

function fakeRegistry(indexRevision: number): RegistrySnapshot {
  return {
    documents: [
      {
        documentId: "doc-1",
        relativePath: "a.md",
        status: "PRESENT",
        indexStatus: "READY",
        indexRevision,
        observedHash: "old",
        contentHash: "old",
        parserVersion: "p1",
        byteSize: 60,
        diskMtimeAt: 1,
        lineEnding: "LF",
        hasBom: false,
        lastSeenAt: 1,
      },
    ],
    blocks: [],
    recoveryMode: null,
  };
}

describe("M4 buildCommitBatch", () => {
  it("文档头拼装 read+report+registry，提案逐字段映射", async () => {
    const read = fakeRead("ab".repeat(32));
    const report = await analyzeDocument({
      relativePath: "a.md",
      text: DOC,
      rawByteHash: read.rawByteHash,
    });
    const reconcile = await reconcileSnapshots({
      snapshots: [{ relativePath: "a.md", text: DOC }],
      registry: [],
    });

    const req = buildCommitBatch(
      [{ relativePath: "a.md", read, report }],
      reconcile,
      fakeRegistry(7),
    );
    expect(req.documents).toHaveLength(1);
    const h = req.documents[0];
    expect(h.relativePath).toBe("a.md");
    expect(h.expectedIndexRevision).toBe(7); // 来自注册表
    expect(h.observedHash).toBe(read.rawByteHash);
    expect(h.parserVersion).toBe(report.parserVersion);
    expect(h.byteSize).toBe(64);
    expect(h.mtimeMs).toBe(1_700_000_000_000);
    expect(h.lineEnding).toBe("LF");
    expect(h.hasBom).toBe(false);
    expect(h.diagnostics).toEqual(report.diagnostics.map((d) => ({
      code: d.code,
      blockId: d.blockId ?? null,
      startOffset: d.startOffset,
      endOffset: d.endOffset,
    })));

    // 未登记 ID 恰一处 → CREATE 提案携带 next
    const created = req.blockResults.find((r) => r.action === "CREATE" && r.blockId === UUID);
    expect(created).toBeDefined();
    expect(created?.status).toBe("ACTIVE");
    expect(created?.next?.relativePath).toBe("a.md");
    expect(created?.next?.contentVersion).toBe(1);
    expect(req.snapshotPaths).toEqual(["a.md"]);
  });

  it("未登记路径 expectedIndexRevision=0", async () => {
    const read = fakeRead("cd".repeat(32));
    const report = await analyzeDocument({
      relativePath: "new.md",
      text: DOC,
      rawByteHash: read.rawByteHash,
    });
    const reconcile = await reconcileSnapshots({
      snapshots: [{ relativePath: "new.md", text: DOC }],
      registry: [],
    });
    const req = buildCommitBatch(
      [{ relativePath: "new.md", read, report }],
      reconcile,
      fakeRegistry(3), // 注册表里没有 new.md
    );
    expect(req.documents[0].expectedIndexRevision).toBe(0);
  });
});
