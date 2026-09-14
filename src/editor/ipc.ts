// 类型化的原生命令客户端（设计 §6.1/§14.1）。
// 所有命令失败时 reject HostError 形状的对象，不抛裸字符串。
// M2 起：文档命令不再传 root，根由 Rust 激活 Workspace 解析（§6.3）。

import { invoke } from "@tauri-apps/api/core";

export interface HostErrorShape {
  code: string;
  message: string;
  /** §14.1：可否安全重试（Rust HostError 序列化携带；M4 起有意义） */
  retryable?: boolean;
  operationId?: string;
  path?: string;
}

export interface ReadDocumentDto {
  text: string;
  rawByteHash: string;
  byteSize: number;
  hasBom: boolean;
  lineEnding: "LF" | "CRLF" | "MIXED";
  mtimeMs: number;
  /** M7：卷序列号+文件索引（外部移动采纳，§13.5；可空） */
  fileIdentity: string | null;
}

export interface StatDocumentDto {
  exists: boolean;
  rawByteHash: string | null;
  byteSize: number | null;
  mtimeMs: number | null;
}

export interface SaveDocumentDto {
  committedHash: string;
  byteSize: number;
  operationId: string;
}

export interface DraftDto {
  exists: boolean;
  savedAtMs: number | null;
  sourceHash: string | null;
  text: string | null;
}

export interface SaveParams {
  text: string;
  eol: "LF" | "CRLF";
  addBom: boolean;
  expectedHash: string;
}

export const HASH_ABSENT = "ABSENT";

function toHostError(e: unknown): HostErrorShape {
  if (typeof e === "object" && e !== null && "code" in e && "message" in e) {
    return e as HostErrorShape;
  }
  return { code: "IPC_ERROR", message: String(e) };
}

/** workspace/ipc.ts 共用的 invoke 包装：统一 HostError 形状 */
export async function ipcCall<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toHostError(e);
  }
}

export const ipc = {
  readDocument: (relativePath: string) =>
    ipcCall<ReadDocumentDto>("read_document", { relativePath }),

  saveDocument: (relativePath: string, params: SaveParams) =>
    ipcCall<SaveDocumentDto>("save_document", { relativePath, params }),

  statDocument: (relativePath: string) =>
    ipcCall<StatDocumentDto>("stat_document", { relativePath }),

  draftRead: (relativePath: string) => ipcCall<DraftDto>("draft_read", { relativePath }),

  draftWrite: (
    relativePath: string,
    text: string,
    eol: "LF" | "CRLF",
    addBom: boolean,
    sourceHash: string,
  ) => ipcCall<number>("draft_write", { relativePath, text, eol, addBom, sourceHash }),

  draftDiscard: (relativePath: string) => ipcCall<void>("draft_discard", { relativePath }),
};
