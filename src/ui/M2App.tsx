// M2 应用壳：Workspace 管理 + 目录树 + 文件操作 + 安全编辑器
// （设计 §5.1/§13.6/§16；M1 编辑协议原样复用）。
// M3：Block Engine 接线——保存流锚点插入桥、纳入复习动作、状态栏块计数、
// 500ms 防抖的已保存版本分析（§15.2）。

import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ipc, type DraftDto, type HostErrorShape } from "../editor/ipc";
import { indexIpc, type AnchorRepairOp, type RegistrySnapshot } from "../index/ipc";
import { runIndexSync, runStartupSync, summarize, type SyncSummary } from "../index/sync";
import { ExternalSync, type FsChangedPathPayload } from "../index/externalSync";
import { reviewService } from "../review/runtime";
import { ReviewPage } from "./ReviewPage";
import { StatsPage } from "./StatsPage";
import { SettingsPage } from "./SettingsPage";
import { SaveCoordinator, type CoordinatorState } from "../editor/SaveCoordinator";
import { EditorController, type CursorInfo, type SystemEdit } from "../editor/EditorController";
import { EngineClient } from "../engine/workerClient";
import {
  workspaceIpc,
  type DeletePreviewDto,
  type MovePreviewDto,
  type RecentEntryDto,
  type TrashEntryDto,
  type TreeEntryDto,
  type WorkspaceInfoDto,
} from "../workspace/ipc";
import { DirPickerTree, SidebarTree } from "./Tree";

type EolState = "LF" | "CRLF" | "MIXED";
type OpenBanner = { kind: "readonly" | "error"; message: string } | null;

/** 切换守卫的待执行动作：先处理 dirty 再放行 */
type PendingAction =
  | { kind: "open-file"; relative: string }
  | { kind: "to-start" } // 关闭当前库回到启动屏
  | { kind: "close-window" };

type NamePrompt =
  | { mode: "new-file"; dir: string }
  | { mode: "new-dir"; dir: string }
  | { mode: "rename"; entry: TreeEntryDto };

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function parentOf(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx < 0 ? "" : rel.slice(0, idx);
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

/** 占用冲突时的恢复路径建议（绝不覆盖，§13.6） */
function suggestRestorePath(rel: string, isFile: boolean): string {
  if (isFile && rel.toLowerCase().endsWith(".md")) {
    return `${rel.slice(0, -3)} (2).md`;
  }
  return `${rel} (2)`;
}

/** 修复面板：缺失旧 ID 的恢复行（行号输入 + 恢复按钮） */
function MissingIdRow({
  blockId,
  title,
  relativePath,
  disabled,
  onRestore,
}: {
  blockId: string;
  title: string | null;
  relativePath: string;
  disabled: boolean;
  onRestore: (lineIndex: number) => void;
}) {
  const [line, setLine] = useState("0");
  return (
    <li>
      <span className="mono">{blockId}</span>
      <span>
        {title ?? "（无标题）"} @ {relativePath}
      </span>
      <input
        type="number"
        min={0}
        value={line}
        onChange={(e) => setLine(e.target.value)}
        style={{ width: "5em" }}
      />
      <button disabled={disabled} onClick={() => onRestore(Number(line) || 0)}>
        恢复此 ID
      </button>
    </li>
  );
}

/** 状态栏的引擎扫描摘要（§15.2：仅对已保存版本分析）。 */
type EngineUi = { blocks: number; anchored: number; conflicts: number };

export function M2App() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorController | null>(null);
  const coordRef = useRef<SaveCoordinator | null>(null);

  // --- Workspace ---
  const [wsInfo, setWsInfo] = useState<WorkspaceInfoDto | null>(null);
  const [recents, setRecents] = useState<RecentEntryDto[]>([]);
  const [wsError, setWsError] = useState<HostErrorShape | null>(null);

  // --- 目录树 ---
  const [childrenMap, setChildrenMap] = useState<Record<string, TreeEntryDto[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedDir, setSelectedDir] = useState("");
  const [filterQuery, setFilterQuery] = useState("");
  const [filterHits, setFilterHits] = useState<string[] | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const lastTreeRefreshRef = useRef(0);

  // --- 当前文档与编辑器状态（沿用 M1） ---
  const [coordState, setCoordState] = useState<CoordinatorState | null>(null);
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, col: 1, lines: 1, chars: 0 });
  const [fileInfo, setFileInfo] = useState<{ root: string; relative: string } | null>(null);
  const [eolState, setEolState] = useState<EolState>("LF");
  const [hasBom, setHasBom] = useState(false);
  const [banner, setBanner] = useState<OpenBanner>(null);
  const [draftPrompt, setDraftPrompt] = useState<DraftDto | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState("");
  const [saveAsError, setSaveAsError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // --- M2 操作模态 ---
  const [namePrompt, setNamePrompt] = useState<NamePrompt | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [moveDialog, setMoveDialog] = useState<{ entry: TreeEntryDto } | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [moveName, setMoveName] = useState("");
  const [movePreview, setMovePreview] = useState<MovePreviewDto | null>(null);
  const [moveDst, setMoveDst] = useState("");
  const [moveError, setMoveError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    entry: TreeEntryDto;
    preview: DeletePreviewDto;
  } | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashEntries, setTrashEntries] = useState<TrashEntryDto[]>([]);
  const [restorePrompt, setRestorePrompt] = useState<{ entry: TrashEntryDto; target: string } | null>(
    null,
  );
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // --- 切换守卫 ---
  const [switchGuard, setSwitchGuard] = useState(false);
  const pendingActionRef = useRef<PendingAction | null>(null);

  // --- M3：Block Engine ---
  const [engineUi, setEngineUi] = useState<EngineUi | null>(null);
  const [engineDead, setEngineDead] = useState(false);
  const engineRef = useRef<EngineClient | null>(null);
  /** “纳入复习”一次性授权（§9.2 L312：明确纳入操作才给未纳入文件插锚）。 */
  const includeOnceRef = useRef(false);
  /** 最近一次保存流实际插入的锚点数（toast 展示后清零）。 */
  const lastInsertedRef = useRef(0);
  /** 保存流是否消费了 includeOnce（用于“无需插入”反馈）。 */
  const includeConsumedRef = useRef(false);
  const scanTimerRef = useRef<number | null>(null);

  // --- M4：索引同步、恢复模式、冲突修复 ---
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const [recoveryMode, setRecoveryMode] = useState<string | null>(null);
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  /** 最近一次保存的 operationId：索引事务确认（index_complete）后清空 */
  const lastOpRef = useRef<string | null>(null);
  /** 最近一次扫描的身份诊断（修复面板数据源，§9.4 L354–360） */
  const [idDiags, setIdDiags] = useState<
    { code: string; blockId: string | null; startOffset: number }[]
  >([]);
  /** 最近注册表快照（修复面板 MISSING 列表来源） */
  const lastRegistryRef = useRef<RegistrySnapshot | null>(null);

  const showToast = useCallback((msg: string) => setToast(msg), []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // --- 编辑器与协调器初始化（一次；宿主常驻挂载） ---
  useEffect(() => {
    const coord = new SaveCoordinator();
    const editor = new EditorController({
      onDocChanged: () => coord.notifyInput(),
      onCompositionStart: () => coord.notifyCompositionStart(),
      onCompositionEnd: () => coord.notifyCompositionEnd(),
      onCursor: setCursor,
      onSave: () => void handleSaveRef.current?.(),
    });
    editorRef.current = editor;
    coordRef.current = coord;
    if (hostRef.current) {
      editor.mount(hostRef.current);
      coord.attach(() => editor.getText());
    }

    // M3：引擎 Worker 与保存流锚点插入桥（§13.1 L821–823）
    const engine = new EngineClient();
    engineRef.current = engine;
    if (engine.dead) setEngineDead(true);
    coord.attachAnchor({
      planForSave: async (text, _trigger, info) => {
        const ed = editorRef.current;
        const f = coord.openFile;
        if (!ed || !f || engine.dead) return null;
        if (ed.isComposing()) return null; // IME 组合期不写注释（§13.1 L810）
        const includeOnce = includeOnceRef.current;
        includeOnceRef.current = false;
        // 门控 1：无内容改动的 Ctrl+S 不触发旧库纳入（§9.2 L312）
        if (!info.hadChanges && !includeOnce) return null;
        // ★ 基线必须在 await 之前建立：等待期输入经 ChangeSet 映射合并（M3 风险 #10）
        ed.markBaseline(text);
        let plan: { edits: SystemEdit[] } | null = null;
        try {
          const report = await engine.analyze(
            { relativePath: f.relative, text, rawByteHash: coord.getBaseHash() ?? "" },
            { insertionPolicy: "missing" },
          );
          // 门控 2：未纳入文件只在显式“纳入复习”时一次性插入
          const enrolled = report.blocks.some((b) => b.blockId);
          if (includeOnce || enrolled) {
            includeConsumedRef.current = includeOnce;
            // 门控 3：Git 冲突或身份诊断未解决时不插（§8.3 L285、§9.4 L360 人工修复）
            if (
              report.indexable &&
              !report.diagnostics.some((d) => d.code.startsWith("ID_")) &&
              report.insertionPlan.length > 0
            ) {
              lastInsertedRef.current = report.insertionPlan.length;
              plan = {
                edits: report.insertionPlan.map((e) => ({
                  from: e.insertOffset,
                  to: e.insertOffset,
                  insert: e.text,
                  contextBefore: e.contextBefore,
                  contextAfter: e.contextAfter,
                })),
              };
            }
          }
        } catch {
          plan = null; // 引擎/Worker 故障：本轮不插
        }
        // plan 为 null 的所有路径统一清基线；非 null 由 applySystemEdits/applyEdits 清理
        if (!plan) ed.clearBaseline();
        return plan;
      },
      applyEdits: (edits) => {
        const ed = editorRef.current;
        const ok = ed ? ed.applySystemEdits(edits) : false;
        if (!ok) ed?.clearBaseline();
        return ok;
      },
      onSkipped: (reason) => {
        showToast(
          reason === "composing"
            ? "输入法组合中，本次保存未插入锚点"
            : "缓冲区已变化，锚点插入被跳过（已按原样保存）",
        );
      },
    });

    const unsub = coord.onStateChange((s) => {
      setCoordState(s);
      if (s.status === "conflict") setConflictOpen(true);
    });
    return () => {
      unsub();
      if (scanTimerRef.current) window.clearTimeout(scanTimerRef.current);
      engine.dispose();
      editor.destroy();
      coord.close();
      editorRef.current = null;
      coordRef.current = null;
      engineRef.current = null;
    };
  }, []);

  // --- M6：页面视图与到期角标 ---
  const [view, setView] = useState<"editor" | "review" | "stats" | "settings">("editor");
  const [dueBadge, setDueBadge] = useState<{ count: number; upcoming: number | null } | null>(null);
  const refreshDue = useCallback(() => {
    reviewService()
      .queue(1)
      .then((q) =>
        setDueBadge({
          count: q.counts.learning + q.counts.review + q.counts.newTotal,
          upcoming: q.nextUpcomingAt,
        }),
      )
      .catch(() => setDueBadge(null));
  }, []);

  // --- 启动：查询已激活 workspace 与最近列表 ---
  useEffect(() => {
    void (async () => {
      const [info, recents] = await Promise.all([
        workspaceIpc.info().catch(() => null),
        workspaceIpc.recentList().catch(() => []),
      ]);
      setRecents(recents);
      if (info) {
        setWsInfo(info);
        void loadDirRef.current?.("");
      }
    })();
  }, []);

  // workspace 可用后：到期角标 + 自动保存配置（M6 设置）
  useEffect(() => {
    if (!wsInfo) return;
    refreshDue();
    reviewService()
      .appConfig()
      .then((c) => coordRef.current?.setAutosaveEnabled(c.autosave))
      .catch(() => undefined);
  }, [wsInfo, refreshDue]);

  // --- 目录树数据 ---
  const loadDir = useCallback(async (dir: string) => {
    try {
      const entries = await workspaceIpc.treeList(dir);
      setChildrenMap((m) => ({ ...m, [dir]: entries }));
    } catch (e) {
      // 目录消失（外部删除）：收起并清缓存
      setExpanded((s) => {
        const n = new Set(s);
        n.delete(dir);
        return n;
      });
      if (dir !== "") {
        setChildrenMap((m) => {
          const n = { ...m };
          delete n[dir];
          return n;
        });
      }
      if (dir === "") showToast(`目录读取失败：${(e as HostErrorShape).message}`);
    }
  }, [showToast]);
  const loadDirRef = useRef(loadDir);
  loadDirRef.current = loadDir;

  const refreshTree = useCallback(async () => {
    lastTreeRefreshRef.current = Date.now();
    const dirs = ["", ...expanded];
    await Promise.all(dirs.map((d) => loadDir(d)));
  }, [expanded, loadDir]);

  const toggleDir = useCallback(
    (rel: string) => {
      setExpanded((s) => {
        const n = new Set(s);
        if (n.has(rel)) n.delete(rel);
        else {
          n.add(rel);
          if (!childrenMap[rel]) void loadDir(rel);
        }
        return n;
      });
    },
    [childrenMap, loadDir],
  );

  // --- 文件名过滤（防抖；仅文件名，§3） ---
  useEffect(() => {
    const q = filterQuery.trim();
    if (!q) {
      setFilterHits(null);
      return;
    }
    const t = setTimeout(() => {
      workspaceIpc
        .treeFilter(q)
        .then(setFilterHits)
        .catch(() => setFilterHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [filterQuery]);

  // Ctrl+P 聚焦过滤框（§7.3 按文件名打开）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        filterInputRef.current?.focus();
        filterInputRef.current?.select();
      }
    };
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  }, []);

  // --- 打开 workspace ---
  const applyOpenWorkspace = useCallback(
    async (root: string) => {
      setWsError(null);
      try {
        const info = await workspaceIpc.open(root);
        setWsInfo(info);
        setChildrenMap({});
        setExpanded(new Set());
        setSelectedDir("");
        setFilterQuery("");
        setFilterHits(null);
        setFileInfo(null);
        setBanner(null);
        await loadDir("");
        setRecents(await workspaceIpc.recentList().catch(() => []));
      } catch (e) {
        const err = e as HostErrorShape;
        setWsError(err);
      }
    },
    [loadDir],
  );

  const pickWorkspace = useCallback(async () => {
    const picked = await openDialog({ multiple: false, directory: true });
    if (typeof picked !== "string") return;
    await applyOpenWorkspace(picked);
  }, [applyOpenWorkspace]);

  // --- 文档打开与切换守卫 ---
  const openFile = useCallback(
    (relative: string) => {
      const coord = coordRef.current;
      if (!coord || !wsInfo) return;
      if (fileInfo?.relative === relative) {
        editorRef.current?.focus();
        return;
      }
      const dirty =
        coord.isDirty() || coord.getState().status === "conflict" || coord.getState().status === "saving";
      if (fileInfo && dirty) {
        pendingActionRef.current = { kind: "open-file", relative };
        setSwitchGuard(true);
        return;
      }
      void loadFile(relative);
    },
    [fileInfo, wsInfo],
  );

  const loadFile = useCallback(
    async (relative: string) => {
      const coord = coordRef.current;
      const editor = editorRef.current;
      if (!coord || !editor || !wsInfo) return;
      try {
        const rd = await ipc.readDocument(relative);
        setBanner(null);
        setEolState(rd.lineEnding);
        setHasBom(rd.hasBom);
        await coord.open(wsInfo.root, relative, rd);
        editor.replaceDoc(rd.text);
        editor.focus();
        setFileInfo({ root: wsInfo.root, relative });
        const draft = await ipc.draftRead(relative);
        if (draft.exists && draft.text != null && draft.text !== rd.text) {
          setDraftPrompt(draft);
        }
      } catch (e) {
        const err = e as HostErrorShape;
        setBanner({
          kind:
            err.code === "FILE_TOO_LARGE" || err.code === "UNSUPPORTED_ENCODING"
              ? "readonly"
              : "error",
          message: `${err.message}（${err.code}）`,
        });
        coord.close();
        setFileInfo(null);
        void refreshTree();
      }
    },
    [wsInfo, refreshTree],
  );
  const loadFileRef = useRef(loadFile);
  loadFileRef.current = loadFile;

  const runPendingAction = useCallback(() => {
    const act = pendingActionRef.current;
    pendingActionRef.current = null;
    setSwitchGuard(false);
    if (!act) return;
    if (act.kind === "open-file") void loadFile(act.relative);
    else if (act.kind === "to-start") void closeToStart();
    else if (act.kind === "close-window") void getCurrentWindow().destroy();
  }, [loadFile]);

  const guardResolve = useCallback(
    async (mode: "save" | "discard" | "cancel") => {
      const coord = coordRef.current;
      if (mode === "cancel") {
        pendingActionRef.current = null;
        setSwitchGuard(false);
        return;
      }
      if (!coord) return runPendingAction();
      if (mode === "save") {
        try {
          await coord.saveNow("manual");
          runPendingAction();
        } catch {
          showToast("保存失败，已停留在当前文件（草稿已写入恢复区）");
        }
      } else {
        await coord.writeDraft();
        coord.close();
        setFileInfo(null);
        runPendingAction();
      }
    },
    [runPendingAction, showToast],
  );

  // --- 切库 / 关窗 ---
  const closeToStart = useCallback(async () => {
    coordRef.current?.close();
    setFileInfo(null);
    setBanner(null);
    setDraftPrompt(null);
    setConflictOpen(false);
    await workspaceIpc.close().catch(() => {});
    setWsInfo(null);
    setChildrenMap({});
    setExpanded(new Set());
    setSelectedDir("");
    setRecents(await workspaceIpc.recentList().catch(() => []));
  }, []);

  const requestSwitchWorkspace = useCallback(() => {
    const coord = coordRef.current;
    const dirty = coord && fileInfo && (coord.isDirty() || coord.getState().status === "conflict");
    if (dirty) {
      pendingActionRef.current = { kind: "to-start" };
      setSwitchGuard(true);
      return;
    }
    void closeToStart();
  }, [fileInfo, closeToStart]);

  useEffect(() => {
    const win = getCurrentWindow();
    const un = win.onCloseRequested(async (event) => {
      const coord = coordRef.current;
      if (!coord?.openFile || (!coord.isDirty() && coord.getState().status !== "conflict")) return;
      event.preventDefault();
      await coord.writeDraft();
      pendingActionRef.current = { kind: "close-window" };
      setSwitchGuard(true);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // --- 保存（沿用 M1；M3 增锚点插入反馈） ---
  const handleSave = useCallback(async () => {
    const coord = coordRef.current;
    if (!coord || !coord.openFile) return;
    try {
      const r = await coord.saveNow("manual");
      lastOpRef.current = r.operationId; // 索引事务确认后由扫描流消费（§13.2 L847）
      const inserted = lastInsertedRef.current;
      const includeUsed = includeConsumedRef.current;
      lastInsertedRef.current = 0;
      includeConsumedRef.current = false;
      if (inserted > 0) showToast(`已插入 ${inserted} 个锚点并保存 · ${r.byteSize.toLocaleString()} 字节`);
      else if (includeUsed) showToast("没有需要锚定的新块，已保存");
      else showToast(`已保存 · ${r.byteSize.toLocaleString()} 字节`);
    } catch (e) {
      const err = e as HostErrorShape;
      if (err.code !== "FILE_CONFLICT") showToast(`保存失败：${err.message}`);
    }
  }, [showToast]);
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  // --- M3：纳入复习（§9.2 L312 明确纳入操作） ---
  const handleInclude = useCallback(async () => {
    const coord = coordRef.current;
    if (!coord || !coord.openFile) return;
    if (coord.getState().status === "conflict") {
      showToast("存在未处理冲突，先解决后再纳入复习");
      return;
    }
    includeOnceRef.current = true;
    await handleSaveRef.current?.();
  }, [showToast]);

  // --- M3：已保存版本的防抖分析（§15.2：500ms、过时结果按 revision 丢弃） ---
  const scheduleEngineScan = useCallback(() => {
    if (scanTimerRef.current) window.clearTimeout(scanTimerRef.current);
    scanTimerRef.current = window.setTimeout(() => {
      scanTimerRef.current = null;
      const coord = coordRef.current;
      const ed = editorRef.current;
      const engine = engineRef.current;
      const f = coord?.openFile;
      if (!coord || !ed || !engine || !f || engine.dead) return;
      if (coord.getState().status !== "clean") return; // 只分析已保存版本
      const text = ed.getText();
      const revision = coord.getBaseHash() ?? "";
      engine
        .analyze({ relativePath: f.relative, text, rawByteHash: revision })
        .then((rep) => {
          if (rep.revision !== (coordRef.current?.getBaseHash() ?? "")) return; // 过时丢弃
          setEngineUi({
            blocks: rep.blocks.length,
            anchored: rep.blocks.filter((b) => b.blockId).length,
            conflicts: rep.diagnostics.filter((d) => d.code.startsWith("ID_")).length,
          });
          setIdDiags(
            rep.diagnostics
              .filter((d) => d.code.startsWith("ID_"))
              .map((d) => ({ code: d.code, blockId: d.blockId, startOffset: d.startOffset })),
          );
          // M4：reconcile → commit_index_batch（首个生产调用方，§13.1 L823）
          void (async () => {
            try {
              const res = await runIndexSync(engine, [f.relative]);
              lastRegistryRef.current = res.registry;
              setSyncSummary(summarize(res.registry));
              const op = lastOpRef.current;
              if (op) {
                lastOpRef.current = null;
                await indexIpc.indexComplete(op); // INDEX_COMMITTED 后清理操作日志
              }
            } catch (e) {
              const err = e as HostErrorShape;
              if (err.code === "WORKSPACE_OFFLINE" || err.code === "MIGRATION_FAILED") {
                setRecoveryMode("OFFLINE");
                return;
              }
              // INDEX_FAILED 语义：正文已保存，索引待修复；阅读编辑不受阻（§14.1）
              showToast(`正文已保存，复习索引待修复：${err.message}`);
            }
          })();
        })
        .catch(() => setEngineDead(true));
    }, 500);
  }, []);

  useEffect(() => {
    if (coordState?.status === "clean") scheduleEngineScan();
    if (coordState?.status === "idle" && scanTimerRef.current) {
      window.clearTimeout(scanTimerRef.current);
      scanTimerRef.current = null;
    }
  }, [coordState, scheduleEngineScan]);

  // 文件关闭/切换时清摘要
  useEffect(() => {
    if (!fileInfo) setEngineUi(null);
  }, [fileInfo]);

  // --- M4：启动收敛（§14.3 步 5：stale/未登记文件分批重索引） ---
  useEffect(() => {
    if (!wsInfo) return;
    const engine = engineRef.current;
    if (!engine || engine.dead) return;
    let cancelled = false;
    void runStartupSync(engine)
      .then((r) => {
        if (cancelled) return;
        setSyncSummary(r.summary);
        setRecoveryMode(r.recoveryMode);
        refreshDue();
      })
      .catch((e) => {
        if (cancelled) return;
        const err = e as HostErrorShape;
        if (err.code === "WORKSPACE_OFFLINE" || err.code === "MIGRATION_FAILED") {
          setRecoveryMode("OFFLINE");
        } else {
          showToast(`启动索引同步未完成：${err.message}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [wsInfo, showToast, refreshDue]);

  // --- M7：外部变化编排（§13.3 Watcher + 60s/10min 核对 + overflow 全量重扫） ---
  const extRef = useRef<ExternalSync | null>(null);
  /** 同步后待落的 CONFLICT 标记（sync 会把 index_status 覆写回 READY，故顺序在后） */
  const conflictMarkRef = useRef<string | null>(null);

  const handleOpenFileExternal = useCallback(
    async (rel: string): Promise<boolean> => {
      const coord = coordRef.current;
      if (!coord?.openFile || coord.openFile.relative.toLowerCase() !== rel.toLowerCase()) {
        return true; // 非当前文件：直接重扫
      }
      const result = await coord
        .checkExternal((text, lineEnding) => {
          editorRef.current?.replaceDoc(text);
          setEolState(lineEnding as EolState);
        })
        .catch(() => "none" as const);
      if (result === "reloaded") showToast("磁盘文件有更新，已重新加载");
      if (result === "conflict" || result === "gone") {
        conflictMarkRef.current = rel;
        setConflictOpen(true);
      }
      return true; // 磁盘版本照常重扫；CONFLICT 在 onSynced 之后落（挡评 §13.4 L901）
    },
    [showToast],
  );

  useEffect(() => {
    if (!wsInfo) return;
    const ext = new ExternalSync({
      engine: () => engineRef.current,
      onOpenFileChanged: handleOpenFileExternal,
      onSynced: () => {
        void refreshTree();
        refreshDue();
        void indexIpc
          .registryRead()
          .then((r) => {
            lastRegistryRef.current = r;
            setSyncSummary(summarize(r));
          })
          .catch(() => {});
        const mark = conflictMarkRef.current;
        if (mark) {
          conflictMarkRef.current = null;
          void indexIpc.markDocStatus(mark, "CONFLICT").catch(() => {});
        }
      },
      onError: (m) => showToast(m),
    });
    extRef.current = ext;
    ext.startTimers();
    // 启动枚举只扫候选（stale/未登记）文件——消失文档的核对交给首轮 quick
    // （§13.3 L885"启动全量枚举核对"；延迟避开启动同步高峰）
    const bootPoke = window.setTimeout(() => void ext.quick(true), 2_500);
    let un1: UnlistenFn | null = null;
    let un2: UnlistenFn | null = null;
    void listen<FsChangedPathPayload>("fs-changed", (e) => ext.handleFsChanged(e.payload)).then(
      (f) => {
        un1 = f;
      },
    );
    void listen("fs-overflow", () => void ext.fullVerify()).then((f) => {
      un2 = f;
    });
    return () => {
      window.clearTimeout(bootPoke);
      ext.stopTimers();
      un1?.();
      un2?.();
      extRef.current = null;
    };
  }, [wsInfo, handleOpenFileExternal, showToast, refreshDue, refreshTree]);

  // --- M4：锚点修复（§9.4 L354–360 显式操作；preview→apply 走安全保存） ---
  const applyRepair = useCallback(
    async (op: AnchorRepairOp) => {
      setRepairBusy(true);
      try {
        const preview = await indexIpc.anchorRepairPreview(op);
        const r = await indexIpc.anchorRepairApply(op, preview.newBlockId ?? undefined);
        lastOpRef.current = r.operationId;
        setRepairOpen(false);
        // 修复直写磁盘：若修的是当前打开文件，重载编辑器（§13.4 同聚焦检测），
        // 否则缓冲与磁盘分叉，下一次保存会撞 FILE_CONFLICT
        if (coordRef.current?.openFile?.relative === op.relativePath) {
          await coordRef.current
            .checkExternal((text, lineEnding) => {
              editorRef.current?.replaceDoc(text);
              setEolState(lineEnding as EolState);
            })
            .catch(() => {});
        }
        showToast("已按预览修复并保存，索引将自动同步");
        scheduleEngineScan(); // 触发重扫 → reconcile 收敛身份状态
      } catch (e) {
        showToast(`修复失败：${(e as HostErrorShape).message}`);
      } finally {
        setRepairBusy(false);
      }
    },
    [showToast, scheduleEngineScan],
  );
  const applyRepairRef = useRef(applyRepair);
  applyRepairRef.current = applyRepair;

  // --- 外部变更 + 基础目录核对：窗口聚焦（§13.3；M7 加节流全库核对） ---
  useEffect(() => {
    const win = getCurrentWindow();
    const un = win.onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      extRef.current?.focusPoke();
      const coord = coordRef.current;
      if (coord?.openFile) {
        void coord
          .checkExternal((text, lineEnding) => {
            editorRef.current?.replaceDoc(text);
            setEolState(lineEnding as EolState);
          })
          .then((result) => {
            if (result === "reloaded") showToast("磁盘文件有更新，已重新加载");
            if (result === "conflict" || result === "gone") {
              conflictMarkRef.current = coord.openFile!.relative;
              setConflictOpen(true);
            }
          })
          .catch(() => {});
      }
      if (wsInfo && Date.now() - lastTreeRefreshRef.current > 2000) {
        void refreshTree();
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [wsInfo, refreshTree, showToast]);

  // --- 文件操作辅助 ---
  const openRelAffected = useCallback(
    (rel: string, isDir: boolean): boolean => {
      const open = fileInfo?.relative;
      if (!open) return false;
      return open === rel || (isDir && open.toLowerCase().startsWith(rel.toLowerCase() + "/"));
    },
    [fileInfo],
  );

  /** 目标涉及当前打开文件时要求先处理 dirty（§13.6 先处理 dirty） */
  const requireClean = useCallback(
    (rel: string, isDir: boolean): boolean => {
      const coord = coordRef.current;
      if (!openRelAffected(rel, isDir)) return true;
      if (coord && (coord.isDirty() || coord.getState().status === "conflict")) {
        showToast("当前打开的文件有未保存修改，请先保存或切换后再操作");
        return false;
      }
      return true;
    },
    [openRelAffected, showToast],
  );

  const refreshParentOf = useCallback(
    async (rel: string) => {
      await loadDir(parentOf(rel));
      await refreshTree();
    },
    [loadDir, refreshTree],
  );

  // --- 新建 / 重命名 ---
  const openNamePrompt = useCallback((p: NamePrompt) => {
    setNamePrompt(p);
    setNameError(null);
    setNameValue(p.mode === "rename" ? p.entry.name : "");
  }, []);

  const submitNamePrompt = useCallback(async () => {
    if (!namePrompt) return;
    const name = nameValue.trim();
    if (!name) return setNameError("名称不能为空");
    if (name.includes("/") || name.includes("\\")) {
      return setNameError("请输入单个名称，不含路径分隔符");
    }
    try {
      if (namePrompt.mode === "new-file") {
        if (!name.toLowerCase().endsWith(".md")) return setNameError("文件名需以 .md 结尾");
        const path = joinPath(namePrompt.dir, name);
        await workspaceIpc.fileCreate(path);
        setNamePrompt(null);
        await loadDir(namePrompt.dir || "");
        if (namePrompt.dir) {
          setExpanded((s) => new Set(s).add(namePrompt.dir));
        }
        void loadFileRef.current?.(path);
      } else if (namePrompt.mode === "new-dir") {
        const path = joinPath(namePrompt.dir, name);
        await workspaceIpc.dirCreate(path);
        setNamePrompt(null);
        await loadDir(namePrompt.dir || "");
        setExpanded((s) => new Set(s).add(namePrompt.dir).add(path));
      } else {
        const entry = namePrompt.entry;
        if (!entry.isDir && !name.toLowerCase().endsWith(".md")) {
          return setNameError("文件名需以 .md 结尾");
        }
        const parent = parentOf(entry.relativePath);
        const newRel = joinPath(parent, name);
        if (newRel === entry.relativePath) {
          setNamePrompt(null);
          return;
        }
        if (!requireClean(entry.relativePath, entry.isDir)) return;
        await workspaceIpc.move(entry.relativePath, newRel);
        setNamePrompt(null);
        await refreshParentOf(newRel);
        if (openRelAffected(entry.relativePath, entry.isDir)) {
          const newOpen = fileInfo
            ? fileInfo.relative.replace(entry.relativePath, newRel)
            : null;
          if (newOpen) {
            coordRef.current?.repath(newOpen);
            setFileInfo({ root: fileInfo!.root, relative: newOpen });
          }
        }
        showToast(`已重命名为 ${name}`);
      }
    } catch (e) {
      setNameError((e as HostErrorShape).message);
    }
  }, [namePrompt, nameValue, loadDir, refreshParentOf, requireClean, openRelAffected, fileInfo, showToast]);

  // --- 移动 ---
  const openMoveDialog = useCallback((entry: TreeEntryDto) => {
    if (!requireClean(entry.relativePath, entry.isDir)) return;
    setMoveDialog({ entry });
    setMoveTarget(parentOf(entry.relativePath));
    setMoveName(entry.name);
    setMovePreview(null);
    setMoveError(null);
  }, [requireClean]);

  const submitMovePreview = useCallback(async () => {
    if (!moveDialog) return;
    const name = moveName.trim();
    if (!name) return setMoveError("名称不能为空");
    if (name.includes("/") || name.includes("\\")) return setMoveError("名称不含路径分隔符");
    if (!moveDialog.entry.isDir && !name.toLowerCase().endsWith(".md")) {
      return setMoveError("文件名需以 .md 结尾");
    }
    const dst = joinPath(moveTarget, name);
    if (dst === moveDialog.entry.relativePath) {
      setMoveDialog(null);
      return;
    }
    setMoveDst(dst);
    try {
      const p = await workspaceIpc.movePreview(moveDialog.entry.relativePath, dst);
      setMovePreview(p);
      setMoveError(null);
    } catch (e) {
      setMoveError((e as HostErrorShape).message);
    }
  }, [moveDialog, moveName, moveTarget]);

  const submitMove = useCallback(async () => {
    if (!moveDialog || !movePreview) return;
    try {
      await workspaceIpc.move(moveDialog.entry.relativePath, moveDst);
      const entry = moveDialog.entry;
      setMoveDialog(null);
      await refreshParentOf(moveDst);
      if (openRelAffected(entry.relativePath, entry.isDir) && fileInfo) {
        const newOpen = fileInfo.relative.replace(entry.relativePath, moveDst);
        coordRef.current?.repath(newOpen);
        setFileInfo({ root: fileInfo.root, relative: newOpen });
      }
      showToast(`已移动到 ${moveDst}`);
    } catch (e) {
      setMoveError((e as HostErrorShape).message);
    }
  }, [moveDialog, movePreview, moveDst, refreshParentOf, openRelAffected, fileInfo, showToast]);

  // --- 删除（先预览确认，§13.6） ---
  const requestDelete = useCallback(
    async (entry: TreeEntryDto) => {
      if (!requireClean(entry.relativePath, entry.isDir)) return;
      try {
        const preview = await workspaceIpc.deletePreview(entry.relativePath);
        setDeleteConfirm({ entry, preview });
      } catch (e) {
        showToast(`删除预览失败：${(e as HostErrorShape).message}`);
      }
    },
    [requireClean, showToast],
  );

  const submitDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    try {
      await workspaceIpc.delete(deleteConfirm.entry.relativePath);
      const entry = deleteConfirm.entry;
      setDeleteConfirm(null);
      if (openRelAffected(entry.relativePath, entry.isDir)) {
        coordRef.current?.close();
        setFileInfo(null);
      }
      await refreshParentOf(entry.relativePath);
      showToast("已移入回收站（可恢复）");
    } catch (e) {
      setDeleteConfirm(null);
      showToast(`删除失败：${(e as HostErrorShape).message}`);
    }
  }, [deleteConfirm, openRelAffected, refreshParentOf, showToast]);

  // --- 回收站 ---
  const openTrash = useCallback(async () => {
    setTrashOpen(true);
    setTrashEntries(await workspaceIpc.trashList().catch(() => []));
  }, []);

  const tryRestore = useCallback(
    async (entry: TrashEntryDto) => {
      try {
        const r = await workspaceIpc.trashRestore(entry.operationId);
        showToast(`已恢复到 ${r.restoredPath}`);
        setRestorePrompt(null);
        setTrashEntries(await workspaceIpc.trashList().catch(() => []));
        await refreshTree();
      } catch (e) {
        const err = e as HostErrorShape;
        if (err.code === "FILE_CONFLICT") {
          setRestorePrompt({
            entry,
            target: suggestRestorePath(entry.originalRelativePath, entry.kind === "FILE"),
          });
          setRestoreError(null);
        } else {
          setRestoreError(err.message);
        }
      }
    },
    [refreshTree, showToast],
  );

  const submitRestore = useCallback(async () => {
    if (!restorePrompt) return;
    const t = restorePrompt.target.trim();
    if (!t) return setRestoreError("路径不能为空");
    try {
      const r = await workspaceIpc.trashRestore(restorePrompt.entry.operationId, t);
      showToast(`已恢复到 ${r.restoredPath}`);
      setRestorePrompt(null);
      setTrashEntries(await workspaceIpc.trashList().catch(() => []));
      await refreshTree();
    } catch (e) {
      setRestoreError((e as HostErrorShape).message);
    }
  }, [restorePrompt, refreshTree, showToast]);

  // --- 其余沿用 M1 的编辑器交互 ---
  const normalizeEol = useCallback((choice: "LF" | "CRLF") => {
    coordRef.current?.normalizeEol(choice);
    setEolState(choice);
    coordRef.current?.notifyInput();
  }, []);

  const restoreDraft = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !draftPrompt?.text) return;
    editor.replaceDoc(draftPrompt.text);
    coordRef.current?.notifyInput();
    setDraftPrompt(null);
    editor.focus();
  }, [draftPrompt]);

  const discardDraft = useCallback(async () => {
    const f = coordRef.current?.openFile;
    if (f) await ipc.draftDiscard(f.relative).catch(() => {});
    setDraftPrompt(null);
  }, []);

  const useDisk = useCallback(async () => {
    try {
      await coordRef.current?.resolveUseDisk((text) => {
        editorRef.current?.replaceDoc(text);
      });
      setConflictOpen(false);
      showToast("已载入磁盘版本（本地草稿已留底）");
      // 冲突解除：文档从 CONFLICT 回到待重扫（§13.4 L901 挡评解除）
      const f = coordRef.current?.openFile;
      if (f) {
        await indexIpc.markDocStatus(f.relative, "PENDING").catch(() => {});
        extRef.current?.handleFsChanged({
          rel: f.relative,
          hash: null,
          size: null,
          mtimeMs: null,
          own: false,
          dir: false,
        });
      }
    } catch (e) {
      showToast(`载入失败：${(e as HostErrorShape).message}`);
    }
  }, [showToast]);

  const localWins = useCallback(async () => {
    try {
      await coordRef.current?.resolveLocalWins();
      setConflictOpen(false);
      showToast("已以本地版本覆盖（磁盘旧版已自动备份）");
    } catch (e) {
      showToast(`覆盖失败：${(e as HostErrorShape).message}`);
    }
  }, [showToast]);

  const submitSaveAs = useCallback(async () => {
    const name = saveAsName.trim();
    if (!name.toLowerCase().endsWith(".md")) return setSaveAsError("文件名需以 .md 结尾");
    if (name.includes("/") || name.includes("\\")) {
      return setSaveAsError("仅支持同一目录内另存，请输入文件名");
    }
    try {
      const r = await coordRef.current?.saveAsNewFile(name, () => {});
      if (r) {
        const f = coordRef.current?.openFile;
        if (f) setFileInfo({ ...f });
        setSaveAsOpen(false);
        setConflictOpen(false);
        setSaveAsError(null);
        showToast(`已另存为 ${name}`);
        await refreshTree();
      }
    } catch (e) {
      setSaveAsError((e as HostErrorShape).message);
    }
  }, [saveAsName, refreshTree, showToast]);

  const forgetRecent = useCallback(async (root: string) => {
    setRecents(await workspaceIpc.recentForget(root).catch(() => []));
  }, []);

  // --- 渲染 ---

  const status = coordState?.status ?? "idle";
  const statusText: Record<string, string> = {
    idle: "未打开文件",
    clean: coordState?.lastSavedAtMs ? `已保存 ${fmtTime(coordState.lastSavedAtMs)}` : "已保存",
    dirty: "未保存 · 自动保存已开启",
    saving: "保存中…",
    conflict: "冲突 · 自动保存已暂停",
    error: `错误：${coordState?.lastError?.message ?? ""}`,
  };
  const canEdit = fileInfo !== null && banner === null;
  const filterActive = filterQuery.trim().length > 0;

  const treeActions = {
    onToggleDir: toggleDir,
    onSelectDir: setSelectedDir,
    onOpenFile: openFile,
    onEntryAction: (entry: TreeEntryDto, action: "rename" | "move" | "delete") => {
      if (action === "rename") openNamePrompt({ mode: "rename", entry });
      else if (action === "move") openMoveDialog(entry);
      else void requestDelete(entry);
    },
  };

  return (
    <div className="m2-shell">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="brand">RecallMD</span>
          <span className="m2-ws-name" title={wsInfo ? wsInfo.root : ""}>
            {wsInfo ? wsInfo.root.split(/[\\/]/).pop() : ""}
          </span>
          <span className="spacer" />
          <button className="tree-act" title="切换知识库" onClick={requestSwitchWorkspace}>
            ⇄
          </button>
        </div>
        <div className="sidebar-tools">
          <button onClick={() => openNamePrompt({ mode: "new-file", dir: selectedDir })}>
            新建文件
          </button>
          <button onClick={() => openNamePrompt({ mode: "new-dir", dir: selectedDir })}>
            新建文件夹
          </button>
          <button onClick={() => void refreshTree()}>刷新</button>
          <button onClick={() => void openTrash()}>回收站</button>
        </div>
        <div className="sidebar-filter">
          <input
            ref={filterInputRef}
            className="text-input"
            placeholder="按文件名过滤（Ctrl+P）"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
          />
          {selectedDir && !filterActive && (
            <div className="filter-note" title={selectedDir}>
              新建目标：{selectedDir}
            </div>
          )}
        </div>
        <div className="sidebar-tree">
          {filterActive ? (
            <div className="tree">
              {filterHits === null ? (
                <div className="tree-loading">搜索中…</div>
              ) : filterHits.length === 0 ? (
                <div className="tree-loading">无匹配文件</div>
              ) : (
                filterHits.map((rel) => (
                  <div
                    key={rel}
                    className={`tree-row${fileInfo?.relative === rel ? " active" : ""}`}
                    style={{ paddingLeft: 8 }}
                    onClick={() => openFile(rel)}
                    title={rel}
                  >
                    <span className="tree-icon file">📄</span>
                    <span className="tree-name">{rel.split("/").pop()}</span>
                    <span className="filter-dir">{parentOf(rel)}</span>
                  </div>
                ))
              )}
            </div>
          ) : (
            <SidebarTree
              childrenMap={childrenMap}
              expanded={expanded}
              activeRel={fileInfo?.relative ?? null}
              selectedDir={selectedDir}
              actions={treeActions}
            />
          )}
        </div>
        {wsInfo && (
          <nav className="sidebar-nav">
            <button
              type="button"
              className={`nav-row${view === "review" ? " active" : ""}`}
              onClick={() => {
                setView(view === "review" ? "editor" : "review");
                refreshDue();
              }}
            >
              <span>今日待复习</span>
              {dueBadge && dueBadge.count > 0 && (
                <span className="nav-badge">{dueBadge.count}</span>
              )}
            </button>
            <button
              type="button"
              className={`nav-row${view === "stats" ? " active" : ""}`}
              onClick={() => setView(view === "stats" ? "editor" : "stats")}
            >
              <span>统计</span>
            </button>
            <button
              type="button"
              className={`nav-row${view === "settings" ? " active" : ""}`}
              onClick={() => setView(view === "settings" ? "editor" : "settings")}
            >
              <span>设置</span>
            </button>
          </nav>
        )}
      </aside>

      <div className="main-col">
        {view === "editor" && (
          <header className="topbar">
            <span className="file-path" title={fileInfo ? `${fileInfo.root}\\${fileInfo.relative}` : ""}>
              {fileInfo ? fileInfo.relative : "未打开文件"}
            </span>
            <span className="spacer" />
            <button
              disabled={!fileInfo || engineDead || status === "conflict"}
              title="为当前文件的复习块插入 ID 锚点并保存"
              onClick={() => void handleInclude()}
            >
              纳入复习
            </button>
            <button
              disabled={!canEdit || status === "saving"}
              onClick={() => void handleSave()}
            >
              保存 (Ctrl+S)
            </button>
          </header>
        )}

        {view === "editor" && wsInfo && banner && (
          <div className="banner banner-error">
            <span>{banner.message}</span>
            <span className="banner-note">
              {banner.kind === "readonly" ? "该文件以只读方式处理；另存转换后再编辑" : ""}
            </span>
            <button onClick={() => void refreshTree()}>刷新目录树</button>
          </div>
        )}

        {view === "editor" && canEdit && eolState === "MIXED" && (
          <div className="banner banner-warn">
            <span>此文件混合使用 LF 与 CRLF 换行，保存前需统一（选择后自动保存一次）</span>
            <button onClick={() => normalizeEol("LF")}>统一为 LF</button>
            <button onClick={() => normalizeEol("CRLF")}>统一为 CRLF</button>
          </div>
        )}

        <div className={`editor-area${view === "editor" ? "" : " is-hidden"}`}>
          <div className="editor-shell" ref={hostRef} />
          {wsInfo && fileInfo === null && !banner && view === "editor" && (
            <div className="welcome">
              <h2>从左侧选择一个文件开始</h2>
              <p>
                选中文件夹后可直接新建文件；删除的文件进入回收站，可随时恢复。
                保存协议的恢复材料保存在 <code>.recallmd/</code>。
              </p>
            </div>
          )}
        </div>

        {view !== "editor" && (
          <div className="page-mount">
            {view === "review" && (
              <ReviewPage
                service={reviewService()}
                onExit={() => setView("editor")}
                onDueChanged={refreshDue}
              />
            )}
            {view === "stats" && <StatsPage service={reviewService()} />}
            {view === "settings" && (
              <SettingsPage
                service={reviewService()}
                workspaceRoot={wsInfo?.root ?? ""}
                onAutosaveChanged={(v) => coordRef.current?.setAutosaveEnabled(v)}
              />
            )}
          </div>
        )}

        {recoveryMode && recoveryMode !== "CLEARED" && (
          <div className={`recover-banner ${recoveryMode === "OFFLINE" ? "bad" : ""}`}>
            {recoveryMode === "OFFLINE" ? (
              <span>
                学习记录暂不可用（元数据库离线）：正文读写不受影响，评分暂停。请升级应用或从备份恢复。
              </span>
            ) : (
              <>
                <span>
                  学习历史丢失（{recoveryMode === "REBUILT_NO_HISTORY" ? "数据库被删除" : "数据库损坏已隔离"}），
                  已从正文重建的块处于<b>暂停</b>状态，不会自动进入复习（§12.6）。
                </span>
                <button
                  disabled={repairBusy}
                  onClick={() => {
                    setRepairBusy(true);
                    void indexIpc
                      .enableRecoveredBlocks()
                      .then((n) => {
                        setRecoveryMode(null);
                        showToast(`已启用 ${n} 个重建块，从现在重新开始`);
                      })
                      .catch((e) => showToast(`启用失败：${(e as HostErrorShape).message}`))
                      .finally(() => setRepairBusy(false));
                  }}
                >
                  从现在重新开始
                </button>
              </>
            )}
          </div>
        )}

        <footer className="statusbar">
          <span className={`save-dot save-${status}`} />
          <span className={status === "error" || status === "conflict" ? "bad" : ""}>
            {statusText[status]}
          </span>
          {fileInfo && (
            <span
              className={engineUi?.conflicts ? "bad clickable" : ""}
              onClick={() => engineUi?.conflicts && setRepairOpen(true)}
            >
              {engineDead
                ? "引擎不可用"
                : engineUi
                  ? `${engineUi.blocks} 块 · ${engineUi.anchored} 已锚定${engineUi.conflicts ? ` · ${engineUi.conflicts} 身份冲突` : ""}`
                  : "扫描中…"}
            </span>
          )}
          {syncSummary && (
            <span
              className={syncSummary.conflict || syncSummary.pendingDocs ? "bad clickable" : "clickable"}
              onClick={() => setRepairOpen(true)}
              title="库级索引状态（点击打开身份修复）"
            >
              索引 {syncSummary.active} 活跃
              {syncSummary.missing ? ` · ${syncSummary.missing} 缺失` : ""}
              {syncSummary.conflict ? ` · ${syncSummary.conflict} 冲突` : ""}
              {syncSummary.pendingDocs ? ` · ${syncSummary.pendingDocs} 待同步` : ""}
            </span>
          )}
          <span className="spacer" />
          <span>UTF-8{hasBom ? " · BOM" : ""}</span>
          <span>{eolState}</span>
          <span>
            Ln {cursor.line}, Col {cursor.col}
          </span>
          <span>
            {cursor.lines.toLocaleString()} 行 · {cursor.chars.toLocaleString()} 字符
          </span>
        </footer>
      </div>

      {/* M4：身份冲突修复面板（§9.4 L354–360 显式操作） */}
      {repairOpen && (
        <Modal title="身份修复（显式操作，保存前可见差异语义）">
          <p className="hint">
            每个操作只改动选定的锚点行，其余内容原样保存；修复后引擎重扫自动收敛身份状态。
          </p>
          {idDiags.length === 0 && (
            <p>当前文件没有身份诊断。库级状态见状态栏（缺失的旧 ID 可在下方恢复）。</p>
          )}
          <ul className="repair-list">
            {idDiags.map((d, i) => (
              <li key={`${d.code}-${d.blockId}-${d.startOffset}-${i}`}>
                <code>{d.code}</code>
                <span className="mono">{d.blockId ?? "（无 ID）"}</span>
                {d.blockId && (d.code === "ID_DUPLICATED" || d.code === "ID_EXTRA") && (
                  <button
                    disabled={repairBusy}
                    onClick={() =>
                      void applyRepairRef.current({
                        kind: "duplicateRekey",
                        relativePath: fileInfo?.relative ?? "",
                        blockId: d.blockId!,
                        expectedHash: coordRef.current?.getBaseHash() ?? "",
                      })
                    }
                  >
                    此处是副本：生成新 ID
                  </button>
                )}
                {d.blockId && (d.code === "ID_MISPLACED" || d.code === "ID_MALFORMED") && (
                  <button
                    disabled={repairBusy}
                    onClick={() =>
                      void applyRepairRef.current({
                        kind: "misplacedRemove",
                        relativePath: fileInfo?.relative ?? "",
                        blockId: d.blockId!,
                        expectedHash: coordRef.current?.getBaseHash() ?? "",
                      })
                    }
                  >
                    删除该注释行
                  </button>
                )}
              </li>
            ))}
          </ul>
          {(() => {
            const missing = (lastRegistryRef.current?.blocks ?? [])
              .filter((b) => b.status === "MISSING")
              .slice(0, 20);
            if (missing.length === 0) return null;
            return (
              <div className="repair-missing">
                <h4>缺失的旧 ID（可恢复原历史，§9.4 L357）</h4>
                <ul className="repair-list">
                  {missing.map((b) => (
                    <MissingIdRow
                      key={b.blockId}
                  blockId={b.blockId}
                  title={b.title}
                  relativePath={b.relativePath}
                  disabled={repairBusy}
                  onRestore={(line) =>
                    void applyRepairRef.current({
                      kind: "missingReinsert",
                      relativePath: b.relativePath,
                      blockId: b.blockId,
                      lineIndex: line,
                      expectedHash:
                        b.relativePath === fileInfo?.relative
                          ? coordRef.current?.getBaseHash() ?? ""
                          : "",
                    })
                  }
                    />
                  ))}
                </ul>
                <p className="hint">行号从 0 起：锚点行将插在该行（该块的标题行）下方。</p>
              </div>
            );
          })()}
          <div className="modal-actions">
            <button onClick={() => setRepairOpen(false)}>关闭</button>
          </div>
        </Modal>
      )}

      {toast && <div className="toast">{toast}</div>}

      {/* 启动屏：未打开 workspace 时覆盖整个应用 */}
      {!wsInfo && (
        <div className="start-screen">
          <div className="start-card">
            <h2>RecallMD</h2>
            <p className="hint">
              打开一个文件夹作为知识库。首次打开会在该文件夹创建
              <code>.recallmd/</code>元数据目录（恢复材料与操作日志）；
              仅支持本机固定磁盘 NTFS 分区。
            </p>
            {wsError && (
              <div className="banner banner-error start-error">
                <span>
                  {wsError.code === "WORKSPACE_LOCKED"
                    ? "该知识库已在其他 RecallMD 窗口打开，本版不支持多实例同时写入。"
                    : `打开失败：${wsError.message}`}
                </span>
              </div>
            )}
            <button className="primary" onClick={() => void pickWorkspace()}>
              选择知识库文件夹…
            </button>
            {recents.length > 0 && (
              <>
                <h3>最近的知识库</h3>
                <div className="recent-list">
                  {recents.map((r) => (
                    <div key={r.root} className="recent-item">
                      <button className="recent-open" onClick={() => void applyOpenWorkspace(r.root)}>
                        <span className="recent-name">{r.name}</span>
                        <span className="recent-path" title={r.root}>
                          {r.root}
                        </span>
                        <span className="recent-time">{fmtDateTime(r.lastOpenedAtMs)}</span>
                      </button>
                      <button
                        className="tree-act"
                        title="从最近列表移除"
                        onClick={() => void forgetRecent(r.root)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {draftPrompt && (
        <Modal title="发现未保存的恢复草稿">
          <p>
            此文件存在崩溃/退出前的草稿（
            {draftPrompt.savedAtMs ? fmtTime(draftPrompt.savedAtMs) : "时间未知"}），内容与当前磁盘文件不同。
          </p>
          <div className="modal-actions">
            <button className="primary" onClick={restoreDraft}>
              恢复草稿到编辑器
            </button>
            <button onClick={() => void discardDraft()}>丢弃草稿</button>
          </div>
        </Modal>
      )}

      {conflictOpen && (
        <Modal title="文件冲突：磁盘版本与本地修改不一致">
          <p>
            磁盘上的文件已在外部被修改（其他编辑器、Git 等）。本地未保存的修改与恢复草稿均已保留，不会丢失。
          </p>
          <div className="modal-actions">
            <button className="primary" onClick={() => void useDisk()}>
              使用磁盘版本（本地留底）
            </button>
            <button onClick={() => void localWins()}>以本地覆盖（磁盘版自动备份）</button>
            <button
              onClick={() => {
                setSaveAsOpen(true);
                setSaveAsName(`copy-${fileInfo?.relative.split("/").pop() ?? "note.md"}`);
                setSaveAsError(null);
              }}
            >
              本地另存为新文件…
            </button>
          </div>
          <p className="hint">暂不提供三方自动合并；M7 提供手动合并流程。</p>
        </Modal>
      )}

      {saveAsOpen && (
        <Modal title="另存为新文件（同目录）">
          <input
            className="text-input"
            value={saveAsName}
            onChange={(e) => setSaveAsName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submitSaveAs()}
            autoFocus
          />
          {saveAsError && <p className="bad">{saveAsError}</p>}
          <div className="modal-actions">
            <button className="primary" onClick={() => void submitSaveAs()}>
              另存
            </button>
            <button onClick={() => setSaveAsOpen(false)}>取消</button>
          </div>
        </Modal>
      )}

      {switchGuard && (
        <Modal title="有未保存的修改">
          <p>切换前请选择：保存（失败会停留）或放弃（草稿写入恢复区，可再次打开时恢复）。</p>
          <div className="modal-actions">
            <button className="primary" onClick={() => void guardResolve("save")}>
              保存并继续
            </button>
            <button onClick={() => void guardResolve("discard")}>放弃修改并继续</button>
            <button onClick={() => void guardResolve("cancel")}>取消</button>
          </div>
        </Modal>
      )}

      {namePrompt && (
        <Modal
          title={
            namePrompt.mode === "new-file"
              ? `新建文件${namePrompt.dir ? `（在 ${namePrompt.dir} 内）` : "（在根目录）"}`
              : namePrompt.mode === "new-dir"
                ? `新建文件夹${namePrompt.dir ? `（在 ${namePrompt.dir} 内）` : "（在根目录）"}`
                : `重命名（${namePrompt.entry.relativePath}）`
          }
        >
          <input
            className="text-input"
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submitNamePrompt()}
            autoFocus
          />
          {nameError && <p className="bad">{nameError}</p>}
          <div className="modal-actions">
            <button className="primary" onClick={() => void submitNamePrompt()}>
              {namePrompt.mode === "rename" ? "重命名" : "创建"}
            </button>
            <button onClick={() => setNamePrompt(null)}>取消</button>
          </div>
        </Modal>
      )}

      {moveDialog && (
        <Modal title={`移动 / 重命名：${moveDialog.entry.relativePath}`}>
          <p className="hint">选择目标文件夹并确认名称；同知识库内移动，不会覆盖已有文件。</p>
          <div className="dir-picker-box">
            <DirPickerTree
              excludeSubtreeOf={moveDialog.entry.isDir ? moveDialog.entry.relativePath : null}
              selected={moveTarget}
              onSelect={(rel) => {
                setMoveTarget(rel);
                setMovePreview(null);
              }}
            />
          </div>
          <input
            className="text-input move-name-input"
            value={moveName}
            onChange={(e) => {
              setMoveName(e.target.value);
              setMovePreview(null);
            }}
            placeholder="名称"
            autoFocus
          />
          {moveError && <p className="bad">{moveError}</p>}
          {movePreview && (
            <p className="move-preview">
              {movePreview.kind === "DIR"
                ? `将移动 ${movePreview.fileCount} 个文件、${movePreview.dirCount} 个子目录到 ${moveDst}`
                : `目标：${moveDst}${movePreview.caseOnly ? "（大小写重命名）" : ""}`}
            </p>
          )}
          <div className="modal-actions">
            {movePreview ? (
              <>
                <button className="primary" onClick={() => void submitMove()}>
                  确认移动
                </button>
                <button onClick={() => setMovePreview(null)}>上一步</button>
              </>
            ) : (
              <>
                <button className="primary" onClick={() => void submitMovePreview()}>
                  下一步
                </button>
                <button onClick={() => setMoveDialog(null)}>取消</button>
              </>
            )}
          </div>
        </Modal>
      )}

      {deleteConfirm && (
        <Modal title={`删除：${deleteConfirm.entry.relativePath}`}>
          <p>
            {deleteConfirm.preview.kind === "DIR"
              ? `将删除该文件夹及其内容：${deleteConfirm.preview.fileCount} 个文件、${deleteConfirm.preview.dirCount} 个子目录。`
              : "将删除该文件。"}
            删除后移入知识库回收站，可随时恢复。
          </p>
          {deleteConfirm.preview.entries.length > 0 && (
            <ul className="delete-entries">
              {deleteConfirm.preview.entries.map((p) => (
                <li key={p}>{p}</li>
              ))}
              {deleteConfirm.preview.totalEntries > deleteConfirm.preview.entries.length && (
                <li>… 共 {deleteConfirm.preview.totalEntries} 项</li>
              )}
            </ul>
          )}
          <div className="modal-actions">
            <button className="danger" onClick={() => void submitDelete()}>
              移入回收站
            </button>
            <button onClick={() => setDeleteConfirm(null)}>取消</button>
          </div>
        </Modal>
      )}

      {trashOpen && (
        <Modal title="回收站（库内 .recallmd/trash，不自动清空）">
          {trashEntries.length === 0 ? (
            <p className="hint">回收站为空。</p>
          ) : (
            <div className="trash-list">
              {trashEntries.map((t) => (
                <div key={t.operationId} className="trash-item">
                  <div className="trash-info">
                    <span className="trash-path">{t.originalRelativePath}</span>
                    <span className="hint">
                      {t.kind === "DIR" ? `文件夹 · ${t.fileCount} 文件 / ${t.dirCount} 目录` : "文件"}
                      {" · "}
                      {fmtDateTime(t.deletedAtMs)}
                    </span>
                  </div>
                  <button onClick={() => void tryRestore(t)}>恢复</button>
                </div>
              ))}
            </div>
          )}
          <div className="modal-actions">
            <button onClick={() => setTrashOpen(false)}>关闭</button>
          </div>
        </Modal>
      )}

      {restorePrompt && (
        <Modal title={`原位置被占用：${restorePrompt.entry.originalRelativePath}`}>
          <p>不会覆盖现存文件，请提供新的恢复路径。</p>
          <input
            className="text-input"
            value={restorePrompt.target}
            onChange={(e) => setRestorePrompt({ ...restorePrompt, target: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && void submitRestore()}
            autoFocus
          />
          {restoreError && <p className="bad">{restoreError}</p>}
          <div className="modal-actions">
            <button className="primary" onClick={() => void submitRestore()}>
              恢复到该路径
            </button>
            <button onClick={() => setRestorePrompt(null)}>取消</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}
