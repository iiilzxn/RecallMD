// M1 编辑器页面：打开文件 → 编辑 → 安全保存（设计 §5.2/§13/§16 的 M1 子集）。
// M1 为单文件里程碑：根 = 所选文件所在目录，.recallmd 元数据建于该根内（§18 M1 说明）。

import { useCallback, useEffect, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ipc, type DraftDto, type HostErrorShape } from "../editor/ipc";
import { SaveCoordinator, type CoordinatorState } from "../editor/SaveCoordinator";
import { EditorController, type CursorInfo } from "../editor/EditorController";

type EolState = "LF" | "CRLF" | "MIXED";
type OpenBanner = { kind: "readonly" | "error"; message: string } | null;

const LAST_FILE_KEY = "recallmd.m1.lastFile";

function splitPath(abs: string): { root: string; relative: string } {
  const idx = Math.max(abs.lastIndexOf("\\"), abs.lastIndexOf("/"));
  if (idx <= 0) return { root: abs, relative: "" };
  return { root: abs.slice(0, idx), relative: abs.slice(idx + 1) };
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

export function M1App() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorController | null>(null);
  const coordRef = useRef<SaveCoordinator | null>(null);

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
  const [closeGuard, setCloseGuard] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // --- 编辑器与协调器初始化（一次） ---
  useEffect(() => {
    const coord = new SaveCoordinator();
    const handlers = {
      onDocChanged: () => coord.notifyInput(),
      onCompositionStart: () => coord.notifyCompositionStart(),
      onCompositionEnd: () => coord.notifyCompositionEnd(),
      onCursor: setCursor,
      onSave: () => void handleSaveRef.current?.(),
    };
    const editor = new EditorController(handlers);
    editorRef.current = editor;
    coordRef.current = coord;
    if (hostRef.current) {
      editor.mount(hostRef.current);
      coord.attach(() => editor.getText());
    }
    const unsub = coord.onStateChange((s) => {
      setCoordState(s);
      if (s.status === "conflict") setConflictOpen(true);
    });
    return () => {
      unsub();
      editor.destroy();
      coord.close();
      editorRef.current = null;
      coordRef.current = null;
    };
  }, []);

  // --- 打开文档 ---
  const openDocument = useCallback(async (root: string, relative: string) => {
    const coord = coordRef.current;
    const editor = editorRef.current;
    if (!coord || !editor) return;
    try {
      const rd = await ipc.readDocument(root, relative);
      setBanner(null);
      setEolState(rd.lineEnding);
      setHasBom(rd.hasBom);
      await coord.open(root, relative, rd);
      editor.replaceDoc(rd.text);
      editor.focus();
      setFileInfo({ root, relative });
      localStorage.setItem(LAST_FILE_KEY, JSON.stringify({ root, relative }));
      const draft = await ipc.draftRead(root, relative);
      if (draft.exists && draft.text != null && draft.text !== rd.text) {
        setDraftPrompt(draft);
      }
    } catch (e) {
      const err = e as HostErrorShape;
      setBanner({ kind: "readonly", message: `${err.message}（${err.code}）` });
      setFileInfo(null);
      coord.close();
    }
  }, []);

  const pickAndOpen = useCallback(async () => {
    const picked = await openFileDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (typeof picked !== "string") return;
    const { root, relative } = splitPath(picked);
    if (!relative) return;
    await openDocument(root, relative);
  }, [openDocument]);

  // 启动恢复上次文件
  useEffect(() => {
    const raw = localStorage.getItem(LAST_FILE_KEY);
    if (!raw) return;
    try {
      const { root, relative } = JSON.parse(raw);
      if (typeof root === "string" && typeof relative === "string") {
        void openDocument(root, relative);
      }
    } catch {
      /* 忽略损坏的记录 */
    }
  }, [openDocument]);

  // --- 保存 ---
  const handleSave = useCallback(async () => {
    const coord = coordRef.current;
    if (!coord || !coord.openFile) return;
    try {
      const r = await coord.saveNow("manual");
      setToast(`已保存 · ${r.byteSize.toLocaleString()} 字节`);
    } catch (e) {
      const err = e as HostErrorShape;
      if (err.code !== "FILE_CONFLICT") {
        setToast(`保存失败：${err.message}`);
      }
      // FILE_CONFLICT → 状态机置 conflict → 模态框自动弹出
    }
  }, []);
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  // --- 外部变更检测：窗口聚焦时（§13.3 M1 简化） ---
  useEffect(() => {
    const win = getCurrentWindow();
    const un = win.onFocusChanged(({ payload: focused }) => {
      if (!focused || !coordRef.current?.openFile) return;
      void coordRef.current
        .checkExternal((text, lineEnding) => {
          editorRef.current?.replaceDoc(text);
          setEolState(lineEnding as EolState);
        })
        .then((result) => {
          if (result === "reloaded") setToast("磁盘文件有更新，已重新加载");
        })
        .catch(() => {});
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // --- 关闭守卫：未保存修改必须显式决策（§13.1） ---
  useEffect(() => {
    const win = getCurrentWindow();
    const un = win.onCloseRequested(async (event) => {
      const coord = coordRef.current;
      if (!coord?.openFile || (!coord.isDirty() && coord.getState().status !== "conflict")) return;
      event.preventDefault();
      await coord.writeDraft();
      setCloseGuard(true);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const closeApp = useCallback(async (mode: "save" | "discard" | "cancel") => {
    const coord = coordRef.current;
    const win = getCurrentWindow();
    if (mode === "cancel") {
      setCloseGuard(false);
      return;
    }
    if (mode === "save") {
      try {
        await coord?.saveNow("manual");
      } catch {
        setCloseGuard(false);
        return; // 保存失败留在应用
      }
    } else {
      await coord?.writeDraft();
      coord?.close();
    }
    await win.destroy();
  }, []);

  // --- 混合换行规范化（§7.2） ---
  const normalizeEol = useCallback(async (choice: "LF" | "CRLF") => {
    coordRef.current?.normalizeEol(choice);
    setEolState(choice);
    coordRef.current?.notifyInput(); // 触发一次自动保存落盘规范化结果
  }, []);

  // --- 草稿恢复 ---
  const restoreDraft = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !draftPrompt?.text) return;
    editor.replaceDoc(draftPrompt.text);
    coordRef.current?.notifyInput(); // 草稿内容进入 dirty 状态，等待保存
    setDraftPrompt(null);
    editor.focus();
  }, [draftPrompt]);

  const discardDraft = useCallback(async () => {
    const f = coordRef.current?.openFile;
    if (f) await ipc.draftDiscard(f.root, f.relative).catch(() => {});
    setDraftPrompt(null);
  }, []);

  // --- 冲突决策（§13.4） ---
  const useDisk = useCallback(async () => {
    try {
      await coordRef.current?.resolveUseDisk((text) => {
        editorRef.current?.replaceDoc(text);
      });
      setConflictOpen(false);
      setToast("已载入磁盘版本（本地草稿已留底）");
    } catch (e) {
      setToast(`载入失败：${(e as HostErrorShape).message}`);
    }
  }, []);

  const localWins = useCallback(async () => {
    try {
      await coordRef.current?.resolveLocalWins();
      setConflictOpen(false);
      setToast("已以本地版本覆盖（磁盘旧版已自动备份）");
    } catch (e) {
      setToast(`覆盖失败：${(e as HostErrorShape).message}`);
    }
  }, []);

  const submitSaveAs = useCallback(async () => {
    const name = saveAsName.trim();
    if (!name.toLowerCase().endsWith(".md")) {
      setSaveAsError("文件名需以 .md 结尾");
      return;
    }
    if (name.includes("/") || name.includes("\\")) {
      setSaveAsError("M1 仅支持同一目录内另存，请输入文件名");
      return;
    }
    try {
      const r = await coordRef.current?.saveAsNewFile(name, () => {});
      if (r) {
        const f = coordRef.current?.openFile;
        if (f) {
          setFileInfo({ ...f });
          localStorage.setItem(LAST_FILE_KEY, JSON.stringify(f));
        }
        setSaveAsOpen(false);
        setConflictOpen(false);
        setSaveAsError(null);
        setToast(`已另存为 ${name}`);
      }
    } catch (e) {
      setSaveAsError((e as HostErrorShape).message);
    }
  }, [saveAsName]);

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

  return (
    <div className="m1-shell">
      <header className="topbar">
        <span className="brand">RecallMD</span>
        <span className="m1-tag">M1 · 安全编辑器</span>
        <span className="file-path" title={fileInfo ? `${fileInfo.root}\\${fileInfo.relative}` : ""}>
          {fileInfo ? fileInfo.relative : "未打开文件"}
        </span>
        <span className="spacer" />
        <button onClick={() => void pickAndOpen()}>打开文件…</button>
        <button
          disabled={!canEdit || status === "saving"}
          onClick={() => void handleSave()}
        >
          保存 (Ctrl+S)
        </button>
      </header>

      {banner && (
        <div className="banner banner-error">
          <span>{banner.message}</span>
          <span className="banner-note">
            {banner.kind === "readonly" ? "该文件以只读方式处理；另存转换后再编辑" : ""}
          </span>
          <button onClick={() => void pickAndOpen()}>打开其他文件…</button>
        </div>
      )}

      {canEdit && eolState === "MIXED" && (
        <div className="banner banner-warn">
          <span>此文件混合使用 LF 与 CRLF 换行，保存前需统一（选择后自动保存一次）</span>
          <button onClick={() => void normalizeEol("LF")}>统一为 LF</button>
          <button onClick={() => void normalizeEol("CRLF")}>统一为 CRLF</button>
        </div>
      )}

      <div className="editor-area">
        {/* 编辑器宿主必须常驻挂载；未打开文件时被欢迎页覆盖 */}
        <div className="editor-shell" ref={hostRef} />
        {fileInfo === null && !banner && (
          <div className="welcome">
            <h2>打开一个 Markdown 文件开始</h2>
            <p>
              M1 阶段：单文件安全编辑。保存协议会在文件所在目录创建
              <code>.recallmd/</code>元数据（恢复副本与操作日志）。
            </p>
            <button className="primary" onClick={() => void pickAndOpen()}>
              打开文件…
            </button>
          </div>
        )}
      </div>

      <footer className="statusbar">
        <span className={`save-dot save-${status}`} />
        <span className={status === "error" || status === "conflict" ? "bad" : ""}>
          {statusText[status]}
        </span>
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

      {toast && <div className="toast">{toast}</div>}

      {draftPrompt && (
        <Modal title="发现未保存的恢复草稿">
          <p>
            此文件存在崩溃/退出前的草稿（{draftPrompt.savedAtMs ? fmtTime(draftPrompt.savedAtMs) : "时间未知"}
            ），内容与当前磁盘文件不同。
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
                setSaveAsName(`copy-${fileInfo?.relative ?? "note.md"}`);
                setSaveAsError(null);
              }}
            >
              本地另存为新文件…
            </button>
          </div>
          <p className="hint">M1 暂不提供三方自动合并；M7 提供手动合并流程。</p>
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

      {closeGuard && (
        <Modal title="有未保存的修改">
          <p>关闭前请选择：保存（失败会留在应用）或放弃（草稿已写入恢复区，可再次打开时恢复）。</p>
          <div className="modal-actions">
            <button className="primary" onClick={() => void closeApp("save")}>
              保存并关闭
            </button>
            <button onClick={() => void closeApp("discard")}>放弃修改并关闭</button>
            <button onClick={() => void closeApp("cancel")}>取消</button>
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
