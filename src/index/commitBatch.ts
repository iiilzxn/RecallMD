// buildCommitBatch：把引擎 reconcile 报告拼装成 Rust `commit_index_batch` 请求
// （设计 §12.5/§13.1 L830——ReconcileReport 本身不含文档头，头来自 read_document
// 与注册表的 indexRevision）。

import type { ReadDocumentDto } from "../editor/ipc";
import type { ReconcileReport, SingleFileReport } from "../engine/types";
import type { BlockProposalDto, CommitIndexBatchRequest, DocumentHeaderDto, RegistrySnapshot } from "./ipc";

export interface CommitFileInput {
  relativePath: string;
  read: ReadDocumentDto;
  report: SingleFileReport;
}

export function buildCommitBatch(
  files: CommitFileInput[],
  report: ReconcileReport,
  registry: RegistrySnapshot,
): CommitIndexBatchRequest {
  const revisionByPath = new Map(
    registry.documents.map((d) => [d.relativePath.toLowerCase(), d.indexRevision]),
  );
  const documents: DocumentHeaderDto[] = files.map((f) => ({
    relativePath: f.relativePath,
    expectedIndexRevision: revisionByPath.get(f.relativePath.toLowerCase()) ?? 0,
    observedHash: f.read.rawByteHash,
    parserVersion: f.report.parserVersion,
    byteSize: f.read.byteSize,
    mtimeMs: f.read.mtimeMs,
    lineEnding: f.read.lineEnding,
    hasBom: f.read.hasBom,
    fileIdentity: f.read.fileIdentity,
    diagnostics: f.report.diagnostics.map((d) => ({
      code: d.code,
      blockId: d.blockId ?? null,
      startOffset: d.startOffset,
      endOffset: d.endOffset,
    })),
  }));
  return {
    documents,
    blockResults: report.blockResults.map(toProposal),
    snapshotPaths: report.snapshotPaths,
  };
}

function toProposal(r: ReconcileReport["blockResults"][number]): BlockProposalDto {
  return {
    blockId: r.blockId,
    action: r.action,
    status: r.status,
    relativePath: r.relativePath,
    next: r.next
      ? {
          blockId: r.next.blockId,
          kind: r.next.kind,
          title: r.next.title,
          headingLevel: r.next.headingLevel,
          headingPath: r.next.headingPath,
          ordinal: r.next.ordinal,
          startOffset: r.next.startOffset,
          bodyStartOffset: r.next.bodyStartOffset,
          endOffset: r.next.endOffset,
          sourceHash: r.next.sourceHash,
          bodyHash: r.next.bodyHash,
          oversized: r.next.oversized,
          relativePath: r.next.relativePath,
          contentVersion: r.next.contentVersion,
          needsRecheck: r.next.needsRecheck,
        }
      : null,
    changeClass: r.changeClass,
    contentVersionDelta: r.contentVersionDelta,
    needsRecheck: r.needsRecheck,
    prev: r.prev,
    reason: r.reason,
    occurrences: r.occurrences.map((o) => ({
      relativePath: o.relativePath,
      ordinal: o.ordinal,
      commentStart: o.commentStart,
      commentEnd: o.commentEnd,
      placement: o.placement,
      inQualifiedBlock: o.inQualifiedBlock,
    })),
  };
}
