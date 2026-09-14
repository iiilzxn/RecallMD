// M4 索引/注册表/备份命令客户端（沿 editor/workspace ipc 模式；设计 §6.2）。

import { ipcCall } from "../editor/ipc";

// --- DTO（与 Rust store::dto 对齐，camelCase） ---

export interface DiagnosticDto {
  code: string;
  blockId: string | null;
  startOffset: number;
  endOffset: number;
}

export interface DocumentHeaderDto {
  relativePath: string;
  expectedIndexRevision: number;
  observedHash: string;
  parserVersion: string;
  byteSize: number;
  mtimeMs: number;
  lineEnding: string;
  hasBom: boolean;
  diagnostics: DiagnosticDto[];
  /** M7：文件身份（外部移动采纳，§13.5） */
  fileIdentity: string | null;
}

// --- M7 定期核对（§13.3 L885） ---

export interface AuditStatDto {
  rel: string;
  byteSize: number;
  mtimeMs: number;
  fileIdentity: string | null;
}

export interface AuditHashWindowDto {
  total: number;
  offset: number;
  files: { rel: string; hash: string | null; byteSize: number; mtimeMs: number }[];
}

export interface OccurrenceDto {
  relativePath: string;
  ordinal: number | null;
  commentStart: number;
  commentEnd: number;
  placement: string;
  inQualifiedBlock: boolean;
}

export interface BlockNextDto {
  blockId: string | null;
  kind: string;
  title: string | null;
  headingLevel: number;
  headingPath: string[];
  ordinal: number;
  startOffset: number;
  bodyStartOffset: number;
  endOffset: number;
  sourceHash: string;
  bodyHash: string;
  oversized: boolean;
  relativePath: string;
  contentVersion: number;
  needsRecheck: boolean;
}

export interface BlockProposalDto {
  blockId: string;
  action: string;
  status: string;
  relativePath: string | null;
  next: BlockNextDto | null;
  changeClass: string | null;
  contentVersionDelta: number;
  needsRecheck: boolean;
  prev: { relativePath: string; status: string } | null;
  reason: string;
  occurrences: OccurrenceDto[];
}

export interface CommitIndexBatchRequest {
  documents: DocumentHeaderDto[];
  blockResults: BlockProposalDto[];
  snapshotPaths: string[];
}

export interface DocumentCommitOutcome {
  documentId: string;
  relativePath: string;
  indexRevision: number;
}

export interface BlockCommitOutcome {
  blockId: string;
  action: string;
  applied: boolean;
  contentVersion: number;
  needsRecheck: boolean;
  status: string;
}

export interface CommitIndexBatchResult {
  documents: DocumentCommitOutcome[];
  blocks: BlockCommitOutcome[];
}

export interface DocumentRegistryDto {
  documentId: string;
  relativePath: string;
  status: string;
  indexStatus: string;
  indexRevision: number;
  observedHash: string | null;
  contentHash: string | null;
  parserVersion: string | null;
  byteSize: number | null;
  diskMtimeAt: number | null;
  lineEnding: string;
  hasBom: boolean;
  lastSeenAt: number | null;
}

export interface RegisteredBlockDto {
  blockId: string;
  documentId: string;
  relativePath: string;
  kind: string;
  headingLevel: number;
  title: string | null;
  headingPath: string[];
  ordinal: number;
  startOffset: number;
  bodyStartOffset: number;
  endOffset: number;
  sourceHash: string;
  bodyHash: string;
  contentVersion: number;
  status: string;
  statusReason: string | null;
  participation: string;
  needsRecheck: boolean;
  hasRating: boolean;
  missingSince: number | null;
  lastSeenAt: number;
}

export interface RegistrySnapshot {
  documents: DocumentRegistryDto[];
  blocks: RegisteredBlockDto[];
  recoveryMode: string | null;
}

export interface RecoveryStatusDto {
  recoveryMode: string | null;
  quarantinedTo: string | null;
  rebuilt: boolean;
  migrated: boolean;
  backupTaken: boolean;
  staleDocuments: string[];
  warnings: string[];
}

export type AnchorRepairOp =
  | { kind: "duplicateRekey"; relativePath: string; blockId: string; expectedHash: string }
  | { kind: "missingReinsert"; relativePath: string; blockId: string; lineIndex: number; expectedHash: string }
  | { kind: "misplacedRemove"; relativePath: string; blockId: string; expectedHash: string };

export interface AnchorRepairPreviewDto {
  lineIndex: number;
  before: string | null;
  after: string | null;
  newBlockId: string | null;
}

export interface DbBackupEntryDto {
  fileName: string;
  byteSize: number;
  createdAtMs: number;
}

export interface DbRestoreResultDto {
  restoredFrom: string;
  quarantinedTo: string | null;
  documentsPending: number;
}

export interface FullBackupResultDto {
  backupDir: string;
  fileCount: number;
  totalBytes: number;
}

export interface FullRestoreResultDto {
  targetRoot: string;
  fileCount: number;
}

export interface SaveResultDto {
  committedHash: string;
  byteSize: number;
  operationId: string;
}

// --- 客户端 ---

export const indexIpc = {
  commitIndexBatch(request: CommitIndexBatchRequest): Promise<CommitIndexBatchResult> {
    return ipcCall<CommitIndexBatchResult>("commit_index_batch", { request });
  },
  registryRead(): Promise<RegistrySnapshot> {
    return ipcCall<RegistrySnapshot>("registry_read", {});
  },
  indexComplete(operationId: string): Promise<void> {
    return ipcCall<void>("index_complete", { operationId });
  },
  recoveryStatus(): Promise<RecoveryStatusDto> {
    return ipcCall<RecoveryStatusDto>("recovery_status", {});
  },
  enumerateMd(): Promise<string[]> {
    return ipcCall<string[]>("enumerate_md", {});
  },
  enableRecoveredBlocks(): Promise<number> {
    return ipcCall<number>("enable_recovered_blocks", {});
  },
  anchorRepairPreview(op: AnchorRepairOp): Promise<AnchorRepairPreviewDto> {
    return ipcCall<AnchorRepairPreviewDto>("anchor_repair_preview", { op });
  },
  anchorRepairApply(op: AnchorRepairOp, confirmedNewId?: string): Promise<SaveResultDto> {
    return ipcCall<SaveResultDto>("anchor_repair_apply", {
      op,
      confirmedNewId: confirmedNewId ?? null,
    });
  },
  backupDbNow(): Promise<DbBackupEntryDto> {
    return ipcCall<DbBackupEntryDto>("backup_db_now", {});
  },
  backupDbList(): Promise<DbBackupEntryDto[]> {
    return ipcCall<DbBackupEntryDto[]>("backup_db_list", {});
  },
  backupDbRestore(fileName: string): Promise<DbRestoreResultDto> {
    return ipcCall<DbRestoreResultDto>("backup_db_restore", { fileName });
  },
  backupFull(targetDir: string): Promise<FullBackupResultDto> {
    return ipcCall<FullBackupResultDto>("backup_full", { targetDir });
  },
  backupFullRestore(backupDir: string, targetRoot: string): Promise<FullRestoreResultDto> {
    return ipcCall<FullRestoreResultDto>("backup_full_restore", { backupDir, targetRoot });
  },
  auditQuick(): Promise<AuditStatDto[]> {
    return ipcCall<AuditStatDto[]>("audit_quick", {});
  },
  auditHashBatch(offset: number, limit: number): Promise<AuditHashWindowDto> {
    return ipcCall<AuditHashWindowDto>("audit_hash_batch", { offset, limit });
  },
  markDocStatus(relative: string, status: "CONFLICT" | "PENDING"): Promise<number> {
    return ipcCall<number>("mark_doc_status", { relative, status });
  },
};
