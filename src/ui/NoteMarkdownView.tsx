import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HostErrorShape } from "../editor/ipc";
import { parseMarkdown, segmentDocument } from "../engine/segment";
import { jevIpc, pointLabel, rubricProblem, type NoteRubric } from "../review/jev";
import { MarkdownView, type MarkdownViewProps, type TocHeading } from "./MarkdownView";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { tooltipPosition } from "./tooltipPosition";

function PointChip({ point, onEdit }: { point: string; onEdit: () => void }) {
  const tooltipId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof tooltipPosition> | null>(null);
  const clearClose = useCallback(() => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  const hide = useCallback(() => { clearClose(); setOpen(false); setPosition(null); }, [clearClose]);
  const show = useCallback(() => { clearClose(); setOpen(true); }, [clearClose]);
  const closeSoon = useCallback(() => {
    clearClose();
    closeTimerRef.current = setTimeout(() => {
      if (!focusRef.current && !buttonRef.current?.matches(":hover") && !tooltipRef.current?.matches(":hover")) hide();
    }, 160);
  }, [clearClose, hide]);
  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    const tooltip = tooltipRef.current;
    if (!rect || !tooltip) return;
    setPosition(tooltipPosition(rect, { width: tooltip.getBoundingClientRect().width, height: tooltip.scrollHeight + 2 }, { width: window.innerWidth, height: window.innerHeight }));
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, point, place]);
  useEffect(() => clearClose, [clearClose]);
  useEffect(() => {
    if (!open) return;
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && tooltipRef.current?.contains(event.target)) return;
      const rect = buttonRef.current?.getBoundingClientRect();
      if (focusRef.current && rect && rect.bottom >= 0 && rect.top <= window.innerHeight) place();
      else hide();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", place); };
  }, [open, hide, place]);
  return <>
    <button ref={buttonRef} type="button" className="note-point-chip" aria-label={`编辑得分点：${point}`}
      aria-describedby={open ? tooltipId : undefined}
      onMouseEnter={show} onMouseLeave={closeSoon} onFocus={() => { focusRef.current = true; show(); }} onBlur={() => { focusRef.current = false; closeSoon(); }}
      onClick={() => { hide(); onEdit(); }} onKeyDown={(event) => { if (event.key === "Escape") hide(); }}>
      {pointLabel(point)}
    </button>
    {open && createPortal(<div ref={tooltipRef} id={tooltipId} role="tooltip" className="note-point-tooltip"
      onMouseEnter={show} onMouseLeave={closeSoon}
      style={position ?? { visibility: "hidden" }}>{point}</div>, document.body)}
  </>;
}

interface Props extends Omit<MarkdownViewProps, "renderHeadingActions"> {
  baseRelative: string;
  savedHash: string | null;
  /** 索引同步结束时刷新；不在每次输入时读数据库。 */
  syncRevision: unknown;
  active: boolean;
  onInclude: () => void;
  onPointSaved?: () => void;
}

export function NoteMarkdownView({ savedHash, syncRevision, active, onInclude, onPointSaved, ...markdown }: Props) {
  const { baseRelative, text } = markdown;
  const [snapshot, setSnapshot] = useState<{ hash: string; path: string; entries: NoteRubric[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [selection, setSelection] = useState<{ entry: NoteRubric; title: string; index: number | null; hash: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const submitRef = useRef(false);
  const loadSequenceRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const sequence = ++loadSequenceRef.current;
    setLoadError(null);
    if (!active || !savedHash) { setSnapshot(null); return; }
    jevIpc.noteRubrics(baseRelative, savedHash).then((entries) => {
      if (!cancelled && sequence === loadSequenceRef.current) setSnapshot({ hash: savedHash, path: baseRelative, entries });
    }).catch((error: HostErrorShape) => {
      if (!cancelled && sequence === loadSequenceRef.current) { setSnapshot(null); setLoadError(error.message); }
    });
    return () => { cancelled = true; };
  }, [active, baseRelative, savedHash, syncRevision, reload]);

  // 外部换版时保留输入并禁止保存；离开笔记才关闭，避免静默丢失得分点草稿。
  useEffect(() => { setSelection(null); setSaveError(null); }, [baseRelative, active]);
  const selectionStale = selection !== null && selection.hash !== savedHash;

  const qualified = useMemo(() => {
    try { return new Set(segmentDocument(text, parseMarkdown(text)).filter((b) => b.kind === "SECTION" && b.qualified).map((b) => b.startOffset)); }
    catch { return new Set<number>(); }
  }, [text]);
  const entries = snapshot?.hash === savedHash && snapshot.path === baseRelative ? snapshot.entries : [];
  const byOffset = useMemo(() => new Map(entries.map((entry) => [entry.headingOffset, entry])), [entries]);
  const open = useCallback((entry: NoteRubric, heading: TocHeading, index: number | null) => {
    if (submitRef.current || !savedHash) return;
    setSelection({ entry, title: heading.text, index, hash: savedHash });
    setDraft(index === null ? "" : entry.points[index]);
    setSaveError(null);
  }, [savedHash]);

  const renderHeadingActions = useCallback((heading: TocHeading) => {
    if (!active || !qualified.has(heading.offset)) return null;
    const entry = byOffset.get(heading.offset);
    if (!entry) return null;
    return <span className="note-point-actions" role="group" aria-label={`${heading.text}的得分点`}>
      <button type="button" data-guide="point-add" className="note-point-add" aria-label={`为「${heading.text}」添加得分点`}
        title={entry.points.length >= 30 ? "每个小节最多 30 个得分点" : "添加得分点"}
        disabled={entry.points.length >= 30} onClick={() => open(entry, heading, null)}><Icon name="plus" size={16} /></button>
      {entry.points.map((point, index) => <PointChip key={`${entry.blockId}:${index}`} point={point} onEdit={() => open(entry, heading, index)} />)}
    </span>;
  }, [active, qualified, byOffset, open]);

  async function save(remove = false) {
    if (!selection || !savedHash || selectionStale || submitRef.current) return;
    const { entry, index } = selection;
    const points = [...entry.points];
    const value = draft.trim();
    if (remove && index !== null) points.splice(index, 1);
    else {
      if (!value) { setSaveError("请写下这个得分点的完整含义。"); return; }
      if (points.some((point, i) => i !== index && point === value)) { setSaveError("这个得分点已存在。"); return; }
      if (index === null) points.push(value); else points[index] = value;
    }
    const problem = rubricProblem(points);
    if (problem) { setSaveError(problem); return; }
    submitRef.current = true;
    setBusy(true);
    setSaveError(null);
    try {
      const result = await jevIpc.saveNoteRubric({ relativePath: baseRelative, expectedHash: selection.hash, blockId: entry.blockId, expectedPoints: entry.points, points });
      loadSequenceRef.current += 1;
      setSnapshot((current) => current?.hash === savedHash && current.path === baseRelative
        ? { ...current, entries: current.entries.map((item) => item.blockId === result.blockId ? result : item) } : current);
      setSelection(null);
      if (!remove && result.points.length > 0) onPointSaved?.();
    } catch (error) {
      setSaveError((error as HostErrorShape).message);
      if (["JEV_RUBRIC_STALE", "JEV_NOTE_STALE"].includes((error as HostErrorShape).code)) setReload((n) => n + 1);
    } finally { submitRef.current = false; setBusy(false); }
  }

  return <>
    {active && !savedHash && <p className="hint note-points-hint">保存笔记后，可在小节标题旁添加得分点。</p>}
    {active && savedHash && snapshot && entries.length === 0 && qualified.size > 0 && <p className="hint note-points-hint">
      纳入复习后，可在小节标题旁添加得分点。 <button type="button" className="text-button" onClick={onInclude}>纳入复习</button>
    </p>}
    {active && loadError && <p className="hint note-points-hint" role="status">得分点暂不可用：{loadError} <button type="button" className="text-button" onClick={() => setReload((n) => n + 1)}>重试</button></p>}
    <MarkdownView {...markdown} renderHeadingActions={renderHeadingActions} />
    {selection && active && <Modal title={selection.index === null ? "添加得分点" : "编辑得分点"} onDismiss={busy ? undefined : () => setSelection(null)}>
      <p className="note-point-section-name">{selection.title}</p>
      <label className="review-prompt-label" htmlFor="note-point-draft">得分点内容</label>
      <textarea id="note-point-draft" className="jev-textarea" rows={4} value={draft} disabled={busy} maxLength={1000}
        placeholder="写下回答中必须包含的核心含义或条件…" onChange={(event) => setDraft(event.target.value)} />
      <p className="hint">{Array.from(draft.trim()).length}/500 字 · 标题旁显示前 5 个字，悬浮查看全文。Jev 按完整内容评分。</p>
      {(selectionStale || saveError) && <p className="review-error" role="alert">{selectionStale ? "原文已变化，暂不能保存。你的输入仍保留在这里；请先复制保留，再关闭并重新打开得分点核对。" : saveError}</p>}
      <div className="modal-actions">
        <button type="button" className="btn primary" disabled={busy || selectionStale || !draft.trim() || Array.from(draft.trim()).length > 500} onClick={() => void save()}>{busy ? "保存中…" : "保存得分点"}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => setSelection(null)}>取消</button>
        {selection.index !== null && <button type="button" className="text-button danger" disabled={busy || selectionStale} onClick={() => void save(true)}>删除得分点</button>}
      </div>
    </Modal>}
  </>;
}
