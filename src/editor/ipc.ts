// 类型化的原生命令客户端（设计 §6.1/§14.1）。
// 所有命令失败时 reject HostError 形状的对象，不抛裸字符串。

import { invoke } from "@tauri-apps/api/core";

export interface HostErrorShape {
  code: string;
  message: string;
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

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toHostError(e);
  }
}

export const ipc = {
  readDocument: (root: string, relativePath: string) =>
    call<ReadDocumentDto>("m1_read_document", { root, relativePath }),

  saveDocument: (root: string, relativePath: string, params: SaveParams) =>
    call<SaveDocumentDto>("m1_save_document", { root, relativePath, params }),

  statDocument: (root: string, relativePath: string) =>
    call<StatDocumentDto>("m1_stat_document", { root, relativePath }),

  draftRead: (root: string, relativePath: string) =>
    call<DraftDto>("m1_draft_read", { root, relativePath }),

  draftWrite: (
    root: string,
    relativePath: string,
    text: string,
    eol: "LF" | "CRLF",
    addBom: boolean,
    sourceHash: string,
  ) => call<number>("m1_draft_write", { root, relativePath, text, eol, addBom, sourceHash }),

  draftDiscard: (root: string, relativePath: string) =>
    call<void>("m1_draft_discard", { root, relativePath }),
};
