// SaveCoordinator：保存/草稿/冲突状态机（设计 §13.1/§13.4 的 M1 实现，M3 增锚点插入步骤）。
//
// 不变量：
// - 同一文档同时最多一个保存在途；在途期间新请求只置 pending
// - 快照 s 保存成功只更新 base，不把保存后的新输入标 clean
// - 冲突状态暂停自动保存，但草稿继续写（崩溃兜底）
// - IME 组合输入期间不发起保存/草稿落盘，也不插入锚点
// - 锚点插入失败/跳过不阻断保存：按原 buffer 落盘，无新 ID、无风险（§13.1 L812 降级）

import { HASH_ABSENT, ipc, type HostErrorShape, type SaveDocumentDto } from "./ipc";
import type { SystemEdit } from "./EditorController";

/** 保存前的锚点插入计划（§9.2 L312：插入只发生于正常保存或明确纳入操作）。 */
export interface AnchorPlan {
  edits: SystemEdit[];
}

export interface AnchorBridge {
  /** 返回 null = 本轮跳过（未纳入/无新块/有冲突诊断等门控由 bridge 决定）。 */
  planForSave(text: string, trigger: "manual" | "auto"): Promise<AnchorPlan | null>;
  /** 绑定 EditorController.applySystemEdits；false = 不可安全应用。 */
  applyEdits(edits: SystemEdit[]): boolean;
  onSkipped?(reason: "unsafe" | "composing"): void;
}

export type SaveStatus =
  | "idle" // 尚未打开文件
  | "clean" // 已保存，buffer == base
  | "dirty" // 有未保存修改
  | "saving" // 保存进行中
  | "conflict" // 磁盘版本与 base 不一致，等待用户决策
  | "error"; // 上次保存/草稿失败（可重试）

export interface CoordinatorState {
  status: SaveStatus;
  lastError: HostErrorShape | null;
  lastSavedAtMs: number | null;
  conflictRemoteHash: string | null;
}

const AUTOSAVE_IDLE_MS = 1000;
const AUTOSAVE_MAX_WAIT_MS = 10_000;

type Listener = (s: CoordinatorState) => void;

export class SaveCoordinator {
  private root: string | null = null;
  private relativePath: string | null = null;
  private baseText = "";
  private baseHash: string | null = null; // 磁盘原始字节哈希；ABSENT 表示新目标
  private eol: "LF" | "CRLF" | "MIXED" = "LF";
  private hasBom = false;

  private saveInFlight: Promise<SaveDocumentDto> | null = null;
  private pendingSave = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private composing = false;

  private state: CoordinatorState = {
    status: "idle",
    lastError: null,
    lastSavedAtMs: null,
    conflictRemoteHash: null,
  };
  private listeners = new Set<Listener>();

  /** 由 EditorController 提供：取当前 buffer 全文（只在保存边界调用，§15.2） */
  private getText: () => string = () => "";
  /** M3：保存流锚点插入桥（UI 装配时注入；未注入时保存行为与 M2 完全一致）。 */
  private anchorBridge: AnchorBridge | null = null;

  attachAnchor(bridge: AnchorBridge) {
    this.anchorBridge = bridge;
  }

  onStateChange(l: Listener): () => void {
    this.listeners.add(l);
    l(this.state);
    return () => this.listeners.delete(l);
  }

  getState(): CoordinatorState {
    return this.state;
  }

  get openFile(): { root: string; relative: string } | null {
    return this.root && this.relativePath
      ? { root: this.root, relative: this.relativePath }
      : null;
  }

  getBaseHash(): string | null {
    return this.baseHash;
  }

  isDirty(): boolean {
    return (
      this.state.status === "dirty" ||
      this.state.status === "error" ||
      this.state.status === "conflict" && this.getText() !== this.baseText
    );
  }

  private emit(patch: Partial<CoordinatorState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  // --- 文档生命周期 ---

  attach(getText: () => string) {
    this.getText = getText;
  }

  async open(
    root: string,
    relativePath: string,
    read: { text: string; rawByteHash: string; lineEnding: "LF" | "CRLF" | "MIXED"; hasBom: boolean },
  ): Promise<void> {
    this.resetTimers();
    this.root = root;
    this.relativePath = relativePath;
    this.baseText = read.text;
    this.baseHash = read.rawByteHash;
    // MIXED 原样保存会在 Rust 侧被拒（防御）；UI 必须先让用户选择规范化
    this.eol = read.lineEnding;
    this.hasBom = read.hasBom;
    this.saveInFlight = null;
    this.pendingSave = false;
    this.emit({ status: "clean", lastError: null, conflictRemoteHash: null });
  }

  close() {
    this.resetTimers();
    this.root = null;
    this.relativePath = null;
    this.baseText = "";
    this.baseHash = null;
    this.emit({ status: "idle", lastError: null, conflictRemoteHash: null });
  }

  /** MIXED 换行：用户明确选择规范化后调用（§7.2） */
  normalizeEol(eol: "LF" | "CRLF") {
    this.eol = eol;
  }

  // --- 输入与自动保存 ---

  /** EditorController 在文档变化时调用（composition 期间不调用） */
  notifyInput() {
    if (!this.openFile) return;
    this.emit({ status: "dirty" });
    this.scheduleAutosave();
  }

  notifyCompositionStart() {
    this.composing = true;
    this.clearIdleTimer();
  }

  notifyCompositionEnd() {
    this.composing = false;
    this.scheduleAutosave();
  }

  private scheduleAutosave() {
    if (this.composing || !this.openFile) return;
    if (this.state.status === "conflict") {
      // 冲突期间自动保存暂停，但草稿兜底持续
      this.scheduleDraftOnly();
      return;
    }
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => void this.autosaveTick(), AUTOSAVE_IDLE_MS);
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => void this.autosaveTick(), AUTOSAVE_MAX_WAIT_MS);
    }
  }

  private clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private resetTimers() {
    this.clearIdleTimer();
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
  }

  private draftTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleDraftOnly() {
    if (this.draftTimer || this.composing || !this.openFile) return;
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      void this.writeDraftQuietly();
    }, AUTOSAVE_IDLE_MS);
  }

  /** 立即把当前 buffer 写入恢复草稿（关闭守卫/冲突时 UI 可主动调用） */
  async writeDraft(): Promise<void> {
    const f = this.openFile;
    if (!f || this.baseHash == null || this.composing) return;
    try {
      // MIXED 时草稿按 LF 落盘（草稿只求内容不丢，不承担字节级还原）
      await ipc.draftWrite(
        f.relative,
        this.getText(),
        this.eol === "CRLF" ? "CRLF" : "LF",
        this.hasBom,
        this.baseHash,
      );
    } catch {
      // 草稿失败不打断编辑；下次 tick 重试
    }
  }

  private async writeDraftQuietly(): Promise<void> {
    await this.writeDraft();
  }

  /** 定时器触发：可保存则保存，否则写草稿 */
  private async autosaveTick(): Promise<void> {
    this.resetTimers();
    const f = this.openFile;
    if (!f || this.composing) return;
    if (this.state.status === "conflict") {
      await this.writeDraftQuietly();
      return;
    }
    if (this.isDirty() || this.pendingSave) {
      await this.saveNow("auto");
    }
  }

  // --- 保存核心 ---

  /** Ctrl+S / 自动保存入口。在途时排队，返回链式结果。 */
  async saveNow(trigger: "manual" | "auto"): Promise<SaveDocumentDto> {
    const f = this.openFile;
    if (!f) throw { code: "NO_FILE", message: "尚未打开文件" } satisfies HostErrorShape;
    if (this.state.status === "conflict" && trigger === "auto") {
      // 冲突未解决，不自动尝试
      await this.writeDraftQuietly();
      throw this.state.lastError ?? { code: "FILE_CONFLICT", message: "存在未处理冲突" };
    }
    if (this.saveInFlight) {
      this.pendingSave = true;
      return this.saveInFlight;
    }

    const expected = this.baseHash ?? HASH_ABSENT;
    const eol = this.eol;
    const addBom = this.hasBom;
    if (eol === "MIXED") {
      const err = {
        code: "MIXED_EOL",
        message: "文件混合使用 LF 与 CRLF，请先选择规范化风格再保存（§7.2）",
      } satisfies HostErrorShape;
      this.emit({ status: "error", lastError: err });
      throw err;
    }
    if (this.state.status !== "saving") {
      this.emit({ status: "saving", lastError: null });
    }

    const attempt = (async () => {
      try {
        // 锚点插入（§13.1 L821–823 时序：解析保存快照→最小插入→最终文本→save_document）。
        // 位于 attempt 内部：saveInFlight 已赋值，await 期间不会有第二轮插入计划。
        // bridge 自己负责在 await 分析之前 markBaseline（等待期输入经 ChangeSet 映射合并）。
        if (this.anchorBridge && !this.composing) {
          try {
            const plan = await this.anchorBridge.planForSave(this.getText(), trigger);
            if (plan && plan.edits.length > 0) {
              const applied = this.anchorBridge.applyEdits(plan.edits);
              if (!applied) {
                this.anchorBridge.onSkipped?.(this.composing ? "composing" : "unsafe");
              }
            }
          } catch {
            // 引擎/Worker 故障不阻断保存：按原 buffer 落盘（编辑优先于索引）
          }
        }
        const snapshotText = this.getText(); // 含注释 → 新 ID 随正文落盘（§9.2 L312）
        const result = await ipc.saveDocument(f.relative, {
          text: snapshotText,
          eol,
          addBom,
          expectedHash: expected,
        });
        // 成功：只把 base 推进到快照；保存期间的继续输入仍保持 dirty
        this.baseText = snapshotText;
        this.baseHash = result.committedHash;
        this.emit({
          status: this.getText() === snapshotText ? "clean" : "dirty",
          lastSavedAtMs: Date.now(),
          lastError: null,
          conflictRemoteHash: null,
        });
        return result;
      } catch (e) {
        const err = e as HostErrorShape;
        this.emit({
          status: err.code === "FILE_CONFLICT" ? "conflict" : "error",
          lastError: err,
          conflictRemoteHash: err.code === "FILE_CONFLICT" ? "REMOTE" : null,
        });
        throw err;
      } finally {
        this.saveInFlight = null;
        if (this.pendingSave) {
          this.pendingSave = false;
          // 保存期间用户继续输入：立刻补一轮
          void this.saveNow("manual").catch(() => {});
        }
      }
    })();

    this.saveInFlight = attempt;
    return attempt;
  }

  // --- 外部变更检测（§13.4） ---

  /**
   * 窗口聚焦等时机调用。返回需要 UI 处理的动作：
   * - "none"：无变化
   * - "reloaded"：干净缓冲区已重载磁盘版（调用方需刷新编辑器文本）
   * - "conflict"：磁盘已变且本地有修改 → 冲突状态
   * - "external-wins-clean"：磁盘变化但本地 clean（同 reloaded）
   */
  async checkExternal(onReload: (text: string, lineEnding: string, hasBom: boolean) => void): Promise<
    "none" | "reloaded" | "conflict" | "gone"
  > {
    const f = this.openFile;
    if (!f || this.saveInFlight) return "none";
    const st = await ipc.statDocument(f.relative);
    const diskHash = st.exists ? st.rawByteHash : null;
    if (diskHash === this.baseHash) return "none";

    if (!st.exists) {
      this.emit({
        status: "conflict",
        lastError: { code: "FILE_CONFLICT", message: "文件已被外部删除或移动" },
        conflictRemoteHash: null,
      });
      await this.writeDraftQuietly();
      return "gone";
    }

    if (!this.isDirty()) {
      // 干净缓冲区：重载磁盘版（§13.4 第一行；撤销栈由 EditorController 重建）
      const rd = await ipc.readDocument(f.relative);
      this.baseText = rd.text;
      this.baseHash = rd.rawByteHash;
      this.eol = rd.lineEnding;
      this.hasBom = rd.hasBom;
      this.emit({ status: "clean", lastError: null, conflictRemoteHash: null });
      onReload(rd.text, rd.lineEnding, rd.hasBom);
      return "reloaded";
    }

    this.emit({
      status: "conflict",
      lastError: { code: "FILE_CONFLICT", message: "磁盘文件有新变化，本地有未保存修改" },
      conflictRemoteHash: diskHash,
    });
    await this.writeDraftQuietly();
    return "conflict";
  }

  // --- 冲突决策（§13.4 M1 三选一） ---

  /** 使用磁盘版本：本地草稿先留底，再重载 */
  async resolveUseDisk(onReload: (text: string) => void): Promise<void> {
    const f = this.openFile;
    if (!f) return;
    await this.writeDraftQuietly();
    const rd = await ipc.readDocument(f.relative);
    this.baseText = rd.text;
    this.baseHash = rd.rawByteHash;
    this.eol = rd.lineEnding;
    this.hasBom = rd.hasBom;
    this.emit({ status: "clean", lastError: null, conflictRemoteHash: null });
    onReload(rd.text);
  }

  /** 以本地覆盖磁盘：expectedHash 切到远程哈希，协议自动备份磁盘版 */
  async resolveLocalWins(): Promise<SaveDocumentDto> {
    const remote = this.state.conflictRemoteHash;
    if (remote && remote !== "REMOTE") {
      this.baseHash = remote;
      this.emit({ status: "dirty", lastError: null, conflictRemoteHash: null });
    } else if (remote === "REMOTE") {
      // 文件被删/无法取哈希的场景：按新文件协议写入原路径
      this.baseHash = HASH_ABSENT;
      this.emit({ status: "dirty", lastError: null, conflictRemoteHash: null });
    }
    return this.saveNow("manual");
  }

  /** 另存为新文件：新名字必须位于同一根内；成功后切换当前文档 */
  async saveAsNewFile(newRelativePath: string, onSwitch: () => void): Promise<SaveDocumentDto> {
    const f = this.openFile;
    if (!f) throw { code: "NO_FILE", message: "尚未打开文件" } satisfies HostErrorShape;
    const eol = this.eol;
    const addBom = this.hasBom;
    if (eol === "MIXED") {
      throw {
        code: "MIXED_EOL",
        message: "请先选择换行规范化风格再另存",
      } satisfies HostErrorShape;
    }
    const result = await ipc.saveDocument(newRelativePath, {
      text: this.getText(),
      eol,
      addBom,
      expectedHash: HASH_ABSENT,
    });
    // 旧文档的草稿清理并切换
    await ipc.draftDiscard(f.relative).catch(() => {});
    this.relativePath = newRelativePath;
    this.baseText = this.getText();
    this.baseHash = result.committedHash;
    this.emit({ status: "clean", lastError: null, conflictRemoteHash: null, lastSavedAtMs: Date.now() });
    onSwitch();
    return result;
  }

  /**
   * 应用内移动/重命名成功后更新路径（M2 §13.6：文件字节未动，
   * base 哈希不变；调用前必须已确认 buffer 干净）。
   */
  repath(newRelativePath: string) {
    this.relativePath = newRelativePath;
  }
}
