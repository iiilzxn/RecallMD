/// <reference lib="webworker" />
// M3 引擎 Worker 壳：nonce 关联的 analyze/reconcile 消息协议（复用 M0 ast.worker 模式）。
// 核心引擎是纯函数，本文件只做编排在 Worker 线程执行；boot 自检 WebCrypto——
// tauri://localhost 与 dev localhost 均为安全上下文，缺失时首请求回 ENGINE_BOOT
// 而不是静默失败（M0 踩坑：Worker 加载失败是裸 Event，最难排查）。

import { analyzeDocument, type AnalyzeOptions, type EngineFileInput } from "./analyze";
import { reconcileSnapshots, type ReconcileInput } from "./reconcile";
import { EngineError, type ReconcileReport, type SingleFileReport } from "./types";

export type EngineWorkerRequest =
  | { nonce: number; kind: "analyze"; input: EngineFileInput; options?: AnalyzeOptions }
  | { nonce: number; kind: "reconcile"; input: ReconcileInput };

export type EngineWorkerResponse =
  | { nonce: number; ok: true; result: SingleFileReport | ReconcileReport }
  | { nonce: number; ok: false; error: { code: string; message: string } };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const bootOk =
  typeof crypto !== "undefined" &&
  typeof crypto.randomUUID === "function" &&
  typeof crypto.subtle?.digest === "function";

ctx.onmessage = async (e: MessageEvent<EngineWorkerRequest>) => {
  const { nonce, kind } = e.data;
  if (!bootOk) {
    ctx.postMessage({
      nonce,
      ok: false,
      error: { code: "ENGINE_BOOT", message: "Worker 缺少 WebCrypto（非安全上下文）" },
    } satisfies EngineWorkerResponse);
    return;
  }
  try {
    const result: SingleFileReport | ReconcileReport =
      kind === "analyze"
        ? await analyzeDocument(e.data.input, e.data.options ?? {})
        : await reconcileSnapshots(e.data.input);
    ctx.postMessage({ nonce, ok: true, result } satisfies EngineWorkerResponse);
  } catch (err) {
    ctx.postMessage({
      nonce,
      ok: false,
      error:
        err instanceof EngineError
          ? { code: err.code, message: err.message }
          : { code: "ENGINE_INTERNAL", message: String(err) },
    } satisfies EngineWorkerResponse);
  }
};
