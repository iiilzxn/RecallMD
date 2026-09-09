// 索引同步编排（设计 §13.1 L823、§14.3 步 5、§15.2 批 ≤50 文档）：
// registry_read → 读文件 → 引擎 reconcile → commit_index_batch；
// STALE_INDEX（注册表过期）自动重试一轮；INDEX_FAILED 上抛交 UI 提示
// （正文已保存、索引待修复，阅读编辑不受阻，§14.1/ADR-008）。

import { ipc, type ReadDocumentDto } from "../editor/ipc";
import type { EngineClient } from "../engine/workerClient";
import type { BlockKind, BlockStatus, Participation, RegisteredBlock } from "../engine/types";
import { buildCommitBatch, type CommitFileInput } from "./commitBatch";
import { indexIpc, type CommitIndexBatchResult, type RegistrySnapshot } from "./ipc";

/** §15.2：常规每批最多 50 文档 */
export const SYNC_BATCH_LIMIT = 50;

export interface SyncSummary {
  active: number;
  missing: number;
  conflict: number;
  pendingDocs: number;
}

export interface SyncResult {
  outcome: CommitIndexBatchResult | null;
  registry: RegistrySnapshot;
}

export function summarize(registry: RegistrySnapshot): SyncSummary {
  return {
    active: registry.blocks.filter((b) => b.status === "ACTIVE").length,
    missing: registry.blocks.filter((b) => b.status === "MISSING").length,
    conflict: registry.blocks.filter((b) => b.status === "ID_CONFLICT").length,
    pendingDocs: registry.documents.filter((d) => d.indexStatus !== "READY").length,
  };
}

/** Rust RegisteredBlockDto → 引擎 RegisteredBlock（枚举对齐 DB CHECK 值） */
export function toRegistryBlocks(snap: RegistrySnapshot): RegisteredBlock[] {
  return snap.blocks.map((b) => ({
    blockId: b.blockId,
    documentId: b.documentId,
    relativePath: b.relativePath,
    kind: b.kind as BlockKind,
    headingLevel: b.headingLevel,
    title: b.title,
    ordinal: b.ordinal,
    startOffset: b.startOffset,
    bodyStartOffset: b.bodyStartOffset,
    endOffset: b.endOffset,
    sourceHash: b.sourceHash,
    bodyHash: b.bodyHash,
    headingPath: b.headingPath,
    contentVersion: b.contentVersion,
    status: b.status as BlockStatus,
    statusReason: b.statusReason,
    hasRating: b.hasRating,
    participation: b.participation as Participation,
    needsRecheck: b.needsRecheck,
  })) as RegisteredBlock[];
}

/**
 * 对给定文件集合做一轮同步。缺失文件（已核实不存在）以 text=null 参与核对，
 * 让其块正确走向 MARK_MISSING。STALE 自动重试一轮。
 */
export async function runIndexSync(
  engine: EngineClient,
  files: string[],
): Promise<SyncResult> {
  if (files.length === 0) return { outcome: null, registry: await indexIpc.registryRead() };
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const registry = await indexIpc.registryRead();
    const inputs: CommitFileInput[] = [];
    const snapshots: { relativePath: string; text: string | null }[] = [];
    for (const rel of files) {
      let read: ReadDocumentDto;
      try {
        read = await ipc.readDocument(rel);
      } catch {
        // FILE_NOT_FOUND：显式核实的缺失快照（§13.5 首次缺失设 MISSING）
        snapshots.push({ relativePath: rel, text: null });
        continue;
      }
      const report = await engine.analyze({
        relativePath: rel,
        text: read.text,
        rawByteHash: read.rawByteHash,
      });
      inputs.push({ relativePath: rel, read, report });
      snapshots.push({ relativePath: rel, text: read.text });
    }
    const reconcile = await engine.reconcile({
      snapshots,
      registry: toRegistryBlocks(registry),
    });
    const request = buildCommitBatch(inputs, reconcile, registry);
    try {
      const outcome = await indexIpc.commitIndexBatch(request);
      return { outcome, registry: await indexIpc.registryRead() };
    } catch (e) {
      const err = e as { code?: string };
      if (err.code === "STALE_INDEX") {
        lastError = e;
        continue; // 注册表过期：重读重算
      }
      throw e;
    }
  }
  throw lastError ?? new Error("索引同步失败");
}

/**
 * 启动收敛（§14.3 步 5）：stale/未登记文件 + 全量枚举，跳过未变化的已登记文件
 * （hash 与 parserVersion 相同 → 引擎必然 NOOP，不值得重解析）。
 */
export async function runStartupSync(
  engine: EngineClient,
): Promise<{ summary: SyncSummary; recoveryMode: string | null; syncedFiles: number }> {
  const [status, allFiles] = await Promise.all([
    indexIpc.recoveryStatus(),
    indexIpc.enumerateMd(),
  ]);
  const registry = await indexIpc.registryRead();
  const regByPath = new Map(
    registry.documents.map((d) => [d.relativePath.toLowerCase(), d]),
  );
  // 候选：启动标记 stale 的文档 + 未登记文件
  const staleLower = new Set(status.staleDocuments.map((p) => p.toLowerCase()));
  const candidates: string[] = [];
  for (const rel of allFiles) {
    const doc = regByPath.get(rel.toLowerCase());
    if (!doc || staleLower.has(rel.toLowerCase()) || doc.indexStatus !== "READY") {
      candidates.push(rel);
    }
  }
  for (const p of status.staleDocuments) {
    if (!candidates.some((c) => c.toLowerCase() === p.toLowerCase())) candidates.push(p);
  }
  // 分批同步（§15.2 ≤50/批）
  for (let i = 0; i < candidates.length; i += SYNC_BATCH_LIMIT) {
    await runIndexSync(engine, candidates.slice(i, i + SYNC_BATCH_LIMIT));
  }
  const finalRegistry = await indexIpc.registryRead();
  return {
    summary: summarize(finalRegistry),
    recoveryMode: finalRegistry.recoveryMode,
    syncedFiles: candidates.length,
  };
}
