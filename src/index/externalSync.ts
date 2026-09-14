// M7 外部变化编排（§13.3 L885"Watcher 只是线索"的四层核对）：
// ① fs-changed 事件 → 防抖合并 → runIndexSync（自写命中且索引已提交则跳过）；
// ② 60s quick：全量 stat（存在性/mtime/size）vs registry → 可疑/消失路径重扫；
// ③ 10min rolling：滚动内容 hash 窗口（捕获同 mtime/size 的修改）；
// ④ fs-overflow → hash 全量核对（分窗推进，不整轮阻塞）。
// 打开中的文件先交 onOpenFileChanged（§13.4 编辑器路径：重载/冲突/挡评）。

import type { EngineClient } from "../engine/workerClient";
import { runIndexSync } from "./sync";
import { indexIpc, type RegistrySnapshot } from "./ipc";

/** Rust watcher 发来的单路径事件（lib.rs emit 的 FsChangedPath） */
export interface FsChangedPathPayload {
  rel: string;
  hash: string | null;
  size: number | null;
  mtimeMs: number | null;
  own: boolean;
  dir: boolean;
}

export interface ExternalSyncDeps {
  engine: () => EngineClient | null;
  /** 打开中的文件外部变化（§13.4：干净重载 / dirty 冲突；返回 false = 本轮跳过该文件） */
  onOpenFileChanged: (rel: string) => Promise<boolean>;
  /** 每轮重扫完成后（M2App 刷新树/角标/修复面板缓存） */
  onSynced: () => void;
  onError?: (msg: string) => void;
}

const FLUSH_DEBOUNCE_MS = 800;
const QUICK_INTERVAL_MS = 60_000;
const ROLLING_INTERVAL_MS = 10 * 60_000;
const ROLLING_WINDOW = 200;

export class ExternalSync {
  private pending = new Map<
    string,
    { hash: string | null; own: boolean; dir: boolean }
  >();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private rerunAfterSync = false;
  private quickTimer: ReturnType<typeof setInterval> | null = null;
  private rollingTimer: ReturnType<typeof setInterval> | null = null;
  private rollingOffset = 0;
  private lastQuickAt = 0;

  constructor(private readonly deps: ExternalSyncDeps) {}

  // --- ① watcher 事件 ---

  handleFsChanged(p: FsChangedPathPayload): void {
    this.pending.set(p.rel, { hash: p.hash, own: p.own, dir: p.dir });
    if (this.flushTimer != null) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    if (this.syncing) {
      this.rerunAfterSync = true;
      return;
    }
    this.syncing = true;
    try {
      const batch = [...this.pending.entries()];
      this.pending.clear();
      let dirPoke = false;
      const targets: string[] = [];
      let registry: RegistrySnapshot | null = null;
      for (const [rel, info] of batch) {
        if (info.dir) {
          dirPoke = true;
          continue;
        }
        // 自写复核（§13.3 L883）：hash 相等且索引已提交 → 跳过
        if (info.own && info.hash) {
          registry ??= await indexIpc.registryRead();
          const doc = registry.documents.find(
            (d) => d.relativePath.toLowerCase() === rel.toLowerCase(),
          );
          if (doc && doc.contentHash === info.hash) continue;
        }
        // 打开中的文件先走 §13.4（重载/冲突）；返回 false 表示本轮不重扫它
        const proceed = await this.deps.onOpenFileChanged(rel);
        if (proceed) targets.push(rel);
      }
      if (dirPoke) await this.quick(true);
      if (targets.length > 0) {
        const engine = this.deps.engine();
        if (engine && !engine.dead) {
          await runIndexSync(engine, targets);
          this.deps.onSynced();
        }
      }
    } catch (e) {
      this.deps.onError?.(`外部变更同步失败：${(e as { message?: string }).message ?? e}`);
    } finally {
      this.syncing = false;
      if (this.rerunAfterSync) {
        this.rerunAfterSync = false;
        void this.flush();
      }
    }
  }

  // --- ② 60s quick：stat 级核对 ---

  async quick(force = false): Promise<void> {
    if (this.syncing && !force) return;
    const now = Date.now();
    if (!force && now - this.lastQuickAt < 30_000) return; // 前台节流（§13.3）
    this.lastQuickAt = now;
    try {
      const [stats, registry] = await Promise.all([
        indexIpc.auditQuick(),
        indexIpc.registryRead(),
      ]);
      const statKeys = new Set(stats.map((s) => s.rel.toLowerCase()));
      const docByPath = new Map(
        registry.documents.map((d) => [d.relativePath.toLowerCase(), d] as const),
      );
      const suspicious: string[] = [];
      for (const s of stats) {
        const doc = docByPath.get(s.rel.toLowerCase());
        if (!doc || doc.status === "DELETED" || doc.indexStatus !== "READY") {
          suspicious.push(s.rel); // 新文件/待同步文件
          continue;
        }
        if (doc.byteSize !== s.byteSize || doc.diskMtimeAt !== s.mtimeMs) {
          suspicious.push(s.rel);
        }
      }
      // 消失：registry 活文档不在磁盘枚举中（→ read 失败 → MARK_MISSING，§13.5）
      const vanished = registry.documents
        .filter((d) => d.status === "PRESENT" && !statKeys.has(d.relativePath.toLowerCase()))
        .map((d) => d.relativePath);
      const targets = [...new Set([...suspicious, ...vanished])];
      if (targets.length > 0) {
        const engine = this.deps.engine();
        if (engine && !engine.dead) {
          await runIndexSync(engine, targets.slice(0, 200));
          this.deps.onSynced();
        }
      }
    } catch {
      // 根不可达/权限等：本轮放弃，绝不据此判定任何缺失（§13.5 L909）
    }
  }

  // --- ③/④ rolling hash 窗口（overflow 时分窗推完一整圈） ---

  async rollingTick(): Promise<void> {
    await this.rollingWindow();
    // 窗口推进在 rollingWindow 内回绕
  }

  private async rollingWindow(): Promise<boolean> {
    const w = await indexIpc.auditHashBatch(this.rollingOffset, ROLLING_WINDOW);
    if (w.files.length === 0) {
      this.rollingOffset = 0;
      return false;
    }
    this.rollingOffset += w.files.length;
    if (this.rollingOffset >= w.total) this.rollingOffset = 0;
    const registry = await indexIpc.registryRead();
    const docByPath = new Map(
      registry.documents.map((d) => [d.relativePath.toLowerCase(), d] as const),
    );
    const changed = w.files.filter((f) => {
      const doc = docByPath.get(f.rel.toLowerCase());
      return doc && doc.status !== "DELETED" && doc.contentHash !== f.hash;
    });
    if (changed.length > 0) {
      const engine = this.deps.engine();
      if (engine && !engine.dead) {
        await runIndexSync(
          engine,
          changed.map((f) => f.rel),
        );
        this.deps.onSynced();
      }
      return true;
    }
    return false;
  }

  /** overflow → 全量 hash 核对（分窗推进整圈；§13.3 L885 收到事件丢失即完整重扫） */
  async fullVerify(): Promise<void> {
    this.rollingOffset = 0;
    let total = 0;
    try {
      const first = await indexIpc.auditHashBatch(0, 1);
      total = first.total;
    } catch {
      return;
    }
    const windows = Math.ceil(total / ROLLING_WINDOW);
    for (let i = 0; i < windows; i++) {
      // eslint-disable-next-line no-await-in-loop -- 分窗正是为了不整轮阻塞
      await this.rollingWindow();
    }
  }

  // --- 定时器（工作区打开期间常驻；M2App 挂载/卸载） ---

  startTimers(): void {
    this.stopTimers();
    this.quickTimer = setInterval(() => void this.quick(), QUICK_INTERVAL_MS);
    this.rollingTimer = setInterval(() => void this.rollingTick(), ROLLING_INTERVAL_MS);
  }

  stopTimers(): void {
    if (this.quickTimer != null) clearInterval(this.quickTimer);
    if (this.rollingTimer != null) clearInterval(this.rollingTimer);
    if (this.flushTimer != null) clearTimeout(this.flushTimer);
    this.quickTimer = null;
    this.rollingTimer = null;
    this.flushTimer = null;
    this.pending.clear();
  }

  /** 前台聚焦节流核对（M2App onFocusChanged 调用） */
  focusPoke(): void {
    void this.quick();
  }
}
