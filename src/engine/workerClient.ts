// EngineClient：主线程侧的引擎 Worker 客户端。
// nonce 关联请求/响应；onerror/onmessageerror 拒绝全部 pending 并置 dead（UI 降级显示，
// 不阻塞编辑保存）。过时结果由调用方按 report.revision（=rawByteHash/baseHash）丢弃（§15.2）。

import EngineWorker from "./engine.worker?worker";
import type { EngineWorkerRequest, EngineWorkerResponse } from "./engine.worker";
import type { AnalyzeOptions, EngineFileInput } from "./analyze";
import type { ReconcileInput } from "./reconcile";
import { EngineError, type ReconcileReport, type SingleFileReport } from "./types";

/** 分布式 Omit：联合类型逐成员剔除键（普通 Omit 会取键交集丢掉 options）。 */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class EngineClient {
  private worker: Worker;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private nextNonce = 1;
  private disposed = false;
  /** Worker 死亡标志：true 后所有调用立即拒绝，UI 应降级并提示。 */
  dead = false;

  constructor() {
    this.worker = new EngineWorker();
    this.worker.onmessage = (e: MessageEvent<EngineWorkerResponse>) => {
      const msg = e.data;
      const p = this.pending.get(msg.nonce);
      if (!p) return;
      this.pending.delete(msg.nonce);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new EngineError(msg.error.code, msg.error.message));
    };
    this.worker.onerror = () => this.failAll("ENGINE_WORKER_ERROR");
    this.worker.onmessageerror = () => this.failAll("ENGINE_WORKER_MESSAGE");
  }

  analyze(input: EngineFileInput, options?: AnalyzeOptions): Promise<SingleFileReport> {
    return this.request({ kind: "analyze", input, options }) as Promise<SingleFileReport>;
  }

  reconcile(input: ReconcileInput): Promise<ReconcileReport> {
    return this.request({ kind: "reconcile", input }) as Promise<ReconcileReport>;
  }

  dispose() {
    this.disposed = true;
    this.failAll("ENGINE_DISPOSED");
    this.worker.terminate();
  }

  private request(payload: DistOmit<EngineWorkerRequest, "nonce">): Promise<unknown> {
    if (this.disposed || this.dead) {
      return Promise.reject(new EngineError("ENGINE_DEAD", "引擎 Worker 已不可用"));
    }
    const nonce = this.nextNonce++;
    return new Promise((resolve, reject) => {
      this.pending.set(nonce, { resolve, reject });
      this.worker.postMessage({ ...payload, nonce } as EngineWorkerRequest);
    });
  }

  private failAll(code: string) {
    this.dead = true;
    for (const p of this.pending.values()) p.reject(new EngineError(code, "引擎 Worker 异常终止"));
    this.pending.clear();
  }
}
