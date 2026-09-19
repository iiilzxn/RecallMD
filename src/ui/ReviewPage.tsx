// M6 Review 页面（设计 §5.2/§16）：先回忆再揭示 → 四 Rating。
// 反泄露纪律：揭示前正文字节不进入页面（body 仅在揭示动作后拉取渲染）；
// 展开上下文正文 = 揭示 + context_used=true（§5.2 L100）。
// 键盘：Space 揭示、1–4 评分、Esc 返回；输入框/IME 焦点不触发（§16 L1049）。
// 写入失败留在当前题（§17.3）；TOKEN_STALE 重揭示；重试复用 requestId（§10.4）。

import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, type HostErrorShape } from "../editor/ipc";
import { MarkdownView } from "./MarkdownView";
import type { PreviewItem, RatingName } from "../review/scheduler";
import type { ReviewService } from "../review/service";
import type { QueueItemDto, ReviewQueueResultDto } from "../review/ipc";
import { Modal } from "./Modal";

const RATING_LABELS: readonly { name: RatingName; key: string; hint: string; tier: string }[] = [
  { name: "Again", key: "1", hint: "没回忆起来", tier: "again" },
  { name: "Hard", key: "2", hint: "回忆正确，很费力", tier: "hard" },
  { name: "Good", key: "3", hint: "正常回忆正确", tier: "good" },
  { name: "Easy", key: "4", hint: "轻松完整回忆", tier: "easy" },
];

/** §11.2 L460：短间隔显示分钟，长间隔显示天 */
export function formatIntervalMs(ms: number): string {
  if (ms < 86_400_000) {
    const minutes = Math.round(ms / 60_000);
    return minutes < 1 ? "马上" : `${minutes} 分钟`;
  }
  const days = ms / 86_400_000;
  return `${days < 10 ? Math.round(days * 10) / 10 : Math.round(days)} 天`;
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

type Phase = "loading" | "hidden" | "revealed" | "done";

interface Props {
  service: ReviewService;
  onExit: () => void;
  onManage: () => void;
  /** 评分/参与变化后通知外层刷新侧栏到期角标 */
  onDueChanged: () => void;
  /** 工作区相对路径图片 → asset URL（M9 本地图片；由持有 workspace 根的 M2App 注入） */
  resolveImage?: (rel: string) => string | null;
}

export function ReviewPage({ service, onExit, onManage, onDueChanged, resolveImage }: Props) {
  const [queueInfo, setQueueInfo] = useState<ReviewQueueResultDto | null>(null);
  const [session, setSession] = useState<QueueItemDto[]>([]);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [bodyText, setBodyText] = useState<string | null>(null);
  /** 揭示时取到的全文：仅供渲染层携带引用/脚注定义（§7.2 L197），不复用为题面 */
  const [fullText, setFullText] = useState<string | null>(null);
  const [contextRaw, setContextRaw] = useState<string | null>(null);
  const [contextUsed, setContextUsed] = useState(false);
  const [resolution, setResolution] = useState<"KEEP" | "RESET" | null>(null);
  const [preview, setPreview] = useState<PreviewItem[]>([]);
  const [error, setError] = useState<HostErrorShape | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [ratedCount, setRatedCount] = useState(0);
  const [excludeConfirm, setExcludeConfirm] = useState(false);
  const participationBusyRef = useRef(false);
  const moreRef = useRef<HTMLDetailsElement>(null);
  const beginRef = useRef<Awaited<ReturnType<ReviewService["begin"]>> | null>(null);
  const startedAtRef = useRef(0);
  const requestIdRef = useRef<string | null>(null);
  /** 本会话跳过的块（§16 L1049：跳过仅本会话；重拉队列时排除，持久 due 不变） */
  const skippedRef = useRef<Set<string>>(new Set());

  const currentItem = session[index] ?? null;
  const needsRecheck = beginRef.current?.state.needsRecheck ?? currentItem?.needsRecheck ?? false;

  const flashInfo = useCallback((msg: string) => {
    setInfo(msg);
    window.setTimeout(() => setInfo((cur) => (cur === msg ? null : cur)), 2600);
  }, []);

  const loadCurrent = useCallback(
    async (items: QueueItemDto[], i: number) => {
      const item = items[i];
      if (!item) {
        setPhase("done");
        return;
      }
      setPhase("loading");
      setExcludeConfirm(false);
      if (moreRef.current) moreRef.current.open = false;
      setError(null);
      setBodyText(null);
      setFullText(null);
      setContextRaw(null);
      setContextUsed(false);
      setResolution(null);
      setPreview([]);
      requestIdRef.current = null;
      setPromptDraft(item.recallPrompt ?? "");
      try {
        beginRef.current = await service.begin(item.blockId);
        startedAtRef.current = service.now();
        setPhase("hidden");
      } catch (e) {
        // 到期条件在揭示窗口内变化（并发评分/暂停）→ 从会话移除继续
        setSession((s) => s.filter((_, idx) => idx !== i));
        flashInfo(`跳过 ${item.title ?? item.relativePath}：${(e as HostErrorShape).message}`);
        void loadCurrent(
          items.filter((_, idx) => idx !== i),
          i,
        );
      }
    },
    [service, flashInfo],
  );

  const loadQueue = useCallback(
    async (interactive: boolean) => {
      setPhase("loading");
      setError(null);
      setRatedCount(0);
      skippedRef.current = new Set();
      try {
        const q = await service.queue();
        setQueueInfo(q);
        setSession(q.items);
        setIndex(0);
        if (q.items.length > 0) {
          await loadCurrent(q.items, 0);
        } else {
          beginRef.current = null;
          setPhase("done");
          if (interactive) flashInfo("当前没有到期内容");
        }
      } catch (e) {
        setError(e as HostErrorShape);
        setPhase("done");
      }
    },
    [service, loadCurrent, flashInfo],
  );

  useEffect(() => {
    void loadQueue(false);
  }, [loadQueue]);

  const advance = useCallback(
    (dropIndex: number) => {
      const next = session.filter((_, idx) => idx !== dropIndex);
      setSession(next);
      if (next.length === 0) {
        // 会话结束：重拉队列确认没有新到期（学习步 10 分钟内一般没有）；
        // 本会话跳过的块不再回场（§16 跳过仅本会话）
        beginRef.current = null;
        setIndex(0);
        void service
          .queue()
          .then((q) => {
            setQueueInfo(q);
            const fresh = q.items.filter((i) => !skippedRef.current.has(i.blockId));
            if (fresh.length > 0) {
              setSession(fresh);
              setIndex(0);
              void loadCurrent(fresh, 0);
            } else {
              setSession([]);
              setPhase("done");
            }
          })
          .catch(() => setPhase("done"));
      } else {
        const nextIdx = dropIndex >= next.length ? next.length - 1 : dropIndex;
        setIndex(nextIdx);
        void loadCurrent(next, nextIdx);
      }
    },
    [session, service, loadCurrent],
  );

  const reveal = useCallback(
    async (withContext: boolean) => {
      const item = currentItem;
      const begin = beginRef.current;
      if (!item || !begin || phase !== "hidden" || busy) return;
      setBusy(true);
      setError(null);
      try {
        const doc = await ipc.readDocument(item.relativePath);
        setFullText(doc.text);
        setBodyText(doc.text.slice(item.bodyStartOffset, item.endOffset));
        if (withContext) {
          setContextRaw(doc.text.slice(item.startOffset, item.endOffset));
          setContextUsed(true);
        }
        setPreview(service.previewIntervals(begin, service.now()));
        setPhase("revealed");
      } catch (e) {
        setError(e as HostErrorShape);
      } finally {
        setBusy(false);
      }
    },
    [currentItem, phase, busy, service],
  );

  const rate = useCallback(
    async (rating: RatingName) => {
      const begin = beginRef.current;
      if (!begin || phase !== "revealed" || busy) return;
      if (needsRecheck && !resolution) {
        flashInfo("正文已变更：请先选择沿用进度或重新学习");
        return;
      }
      setBusy(true);
      setError(null);
      if (!requestIdRef.current) {
        requestIdRef.current = crypto.randomUUID();
      }
      try {
        await service.submit({
          begin,
          rating,
          changeResolution: resolution ?? undefined,
          contextUsed,
          durationMs: service.now() - startedAtRef.current,
          requestId: requestIdRef.current,
        });
        requestIdRef.current = null;
        setRatedCount((n) => n + 1);
        onDueChanged();
        advance(index);
      } catch (e) {
        const err = e as HostErrorShape;
        if (err.code === "REVIEW_TOKEN_STALE") {
          flashInfo("题面已变化，请重新回忆后评分");
          requestIdRef.current = null;
          void loadCurrent(session, index);
        } else if (err.code === "QUOTA_EXCEEDED") {
          flashInfo(err.message);
          requestIdRef.current = null;
          advance(index);
        } else {
          // 写入失败留在当前题（§17.3）；重试复用同一 requestId
          setError(err);
        }
      } finally {
        setBusy(false);
      }
    },
    [phase, busy, needsRecheck, resolution, service, contextUsed, index, session, advance, loadCurrent, flashInfo, onDueChanged],
  );

  const skip = useCallback(() => {
    if (!currentItem || busy || phase === "loading") return;
    skippedRef.current.add(currentItem.blockId);
    flashInfo("已跳过（仅本会话，到期安排不变）");
    advance(index);
  }, [currentItem, busy, phase, advance, index, flashInfo]);

  const pause = useCallback(
    async (action: "PAUSE" | "EXCLUDE") => {
      if (!currentItem || busy || participationBusyRef.current || phase === "loading") return;
      participationBusyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        await service.setParticipation([currentItem.blockId], action);
        setExcludeConfirm(false);
        flashInfo(action === "PAUSE" ? "已暂停。可在「设置 → 复习内容管理」恢复，学习进度已保留。" : "已排除。可在「设置 → 复习内容管理」重新纳入，学习进度已保留。");
        onDueChanged();
        advance(index);
      } catch (e) {
        setError(e as HostErrorShape);
      } finally {
        participationBusyRef.current = false;
        setBusy(false);
      }
    },
    [currentItem, busy, phase, service, advance, index, flashInfo, onDueChanged],
  );

  const savePrompt = useCallback(async () => {
    const item = currentItem;
    if (!item || busy) return;
    const trimmed = promptDraft.trim();
    if (trimmed === (item.recallPrompt ?? "")) return;
    try {
      await service.setPrompt(item.blockId, trimmed || null);
      flashInfo("提示已保存（题面已变，请重新回忆）");
      // 提示变更使会话令牌失效（§10.4）→ 同题重新 begin
      void loadCurrent(session, index);
    } catch (e) {
      setError(e as HostErrorShape);
    }
  }, [currentItem, busy, promptDraft, service, session, index, loadCurrent, flashInfo]);

  // 键盘：Space 揭示 / 1–4 评分 / Esc 返回；输入框与 IME 组合中不触发（§16）
  const keyState = useRef({ phase, resolution, needsRecheck, rate, reveal, onExit });
  keyState.current = { phase, resolution, needsRecheck, rate, reveal, onExit };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing || document.querySelector("dialog[open]")) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const s = keyState.current;
      if (e.key === "Escape") {
        e.preventDefault();
        s.onExit();
        return;
      }
      // Space must still activate the focused button/summary rather than reveal a card.
      if (target?.closest("button, a, summary")) return;
      if (e.key === " ") {
        if (s.phase === "hidden") {
          e.preventDefault();
          void s.reveal(false);
        }
        return;
      }
      if (s.phase === "revealed" && ["1", "2", "3", "4"].includes(e.key)) {
        if (s.needsRecheck && !s.resolution) return;
        e.preventDefault();
        const name = RATING_LABELS[Number(e.key) - 1].name;
        void s.rate(name);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const breadcrumb = currentItem
    ? [
        currentItem.relativePath.replace(/\/[^/]*$/, ""),
        ...currentItem.headingPath,
      ].filter(Boolean)
    : [];

  // 会话进度：已评 /（已评 + 剩余），收敛到 100%
  const sessionTotal = ratedCount + session.length;
  const progressPct = sessionTotal > 0 ? Math.round((ratedCount / sessionTotal) * 100) : 0;

  return (
    <div className="review-page">
      <header className="review-header">
        <div className="review-header-main">
          <strong>今日待复习</strong>
          {queueInfo
            ? queueInfo.counts.learning +
              queueInfo.counts.review +
              queueInfo.counts.newTotal
            : "…"}
          <span className="review-quota">
            新内容名额 {queueInfo?.quota.remaining ?? "–"}/{queueInfo?.quota.limit ?? "–"}
          </span>
          {queueInfo?.nextUpcomingAt != null && (
            <span className="review-upcoming">稍后到期 {formatClock(queueInfo.nextUpcomingAt)}</span>
          )}
        </div>
        <div className="review-header-actions">
          <button type="button" className="btn" onClick={onManage} disabled={busy}>管理复习内容</button>
          <button type="button" className="btn" disabled={busy || phase === "loading"} onClick={() => void loadQueue(true)}>
            刷新
          </button>
          <button type="button" className="btn" onClick={onExit}>
            返回编辑 (Esc)
          </button>
        </div>
      </header>

      <div className="review-progressbar" aria-hidden="true">
        <i style={{ width: `${progressPct}%` }} />
      </div>

      {info && <div className="review-toast" role="status">{info}</div>}
      {error && (
        <div className="review-error" role="alert">
          <span>
            {error.code === "TIME_ANOMALY"
              ? "系统时钟异常，评分已暂停，请检查系统时间后重试"
              : `${error.message}（操作未完成，请重试）`}
          </span>
        </div>
      )}

      {phase === "done" && !currentItem && queueInfo && (
        <section className="review-card review-empty">
          {queueInfo.counts.learning + queueInfo.counts.review + queueInfo.counts.newTotal > 0 ? (
            queueInfo.quota.remaining <= 0 ? (
              <>
                <h3>今日新内容名额已用完</h3>
                <p>
                  还有 {queueInfo.counts.learning + queueInfo.counts.review} 个已到期内容待复习；
                  新内容明天再来（名额 {queueInfo.quota.limit}/天）。
                </p>
              </>
            ) : (
              <>
                <h3>本会话已完成</h3>
                <p>
                  还有 {queueInfo.counts.learning + queueInfo.counts.review + queueInfo.counts.newTotal}{" "}
                  个到期内容是本会话跳过或暂停的（跳过仅本会话，持久安排不变）。
                  {ratedCount > 0 && ` 本轮已评分 ${ratedCount} 题。`}
                </p>
              </>
            )
          ) : (
            <>
              <h3>当前没有到期内容</h3>
              <p>
                {queueInfo.nextUpcomingAt != null
                  ? `稍后到期：${formatClock(queueInfo.nextUpcomingAt)}`
                  : "全部复习完成，写点新笔记吧。"}
                {ratedCount > 0 && ` 本轮已评分 ${ratedCount} 题。`}
              </p>
            </>
          )}
          <div className="review-empty-actions">
            <button type="button" className="btn primary" onClick={() => void loadQueue(true)}>
              再查一轮
            </button>
            <button type="button" className="btn" onClick={onExit}>
              返回编辑
            </button>
          </div>
        </section>
      )}

      {currentItem && (
        <section className="review-card">
          <div className="review-breadcrumb">{breadcrumb.join(" / ") || "（根）"}</div>
          <h2 className="review-title">
            {currentItem.title ?? `${currentItem.relativePath} · 前言`}
          </h2>
          <div className="review-meta">
            <span>{({ NEW: "新内容", LEARNING: "学习中", REVIEW: "复习中", RELEARNING: "重新学习中" } as Record<string, string>)[currentItem.phase.toUpperCase()] ?? currentItem.phase}</span>
            {currentItem.neverRated && <span className="tag-new">新内容</span>}
            {needsRecheck && <span className="tag-changed">正文已变更</span>}
          </div>

          <div className="review-prompt-row">
            <label className="review-prompt-label" htmlFor="recall-prompt">回忆提示</label>
            <input
              id="recall-prompt"
              className="review-prompt-input"
              value={promptDraft}
              placeholder="用一句话提示自己要回忆什么（可选）"
              maxLength={200}
              onChange={(e) => setPromptDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void savePrompt();
                e.stopPropagation();
              }}
            />
            <button type="button" className="btn small" onClick={() => void savePrompt()} disabled={busy}>
              保存
            </button>
          </div>

          {needsRecheck && (
            <div className="review-recheck">
              <p>这段正文自上次评分后有过修改。评分前请选择：</p>
              <div className="review-recheck-actions">
                <button
                  type="button"
                  className={`btn${resolution === "KEEP" ? " primary" : ""}`}
                  onClick={() => setResolution("KEEP")}
                >
                  小改动，沿用进度
                </button>
                <button
                  type="button"
                  className={`btn${resolution === "RESET" ? " primary" : ""}`}
                  onClick={() => setResolution("RESET")}
                >
                  知识重写，重新学习
                </button>
              </div>
            </div>
          )}

          {phase === "loading" && <div className="review-hidden">正在取题…</div>}

          {phase === "hidden" && (
            <>
              <div className="review-hidden" aria-hidden="true">
                正文已遮蔽——先回忆，再揭示。
              </div>
              <div className="review-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() => void reveal(false)}
                >
                  显示原文 (Space)
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void reveal(true)}
                  title="查看标题与原文所在段落；视作已揭示并记录使用上下文"
                >
                  展开上下文正文
                </button>
              </div>
            </>
          )}

          {phase === "revealed" && (
            <>
              {contextRaw != null && (
                <details className="review-context" open>
                  <summary>上下文（本次复习已记录为使用上下文提示）</summary>
                  <pre>{contextRaw}</pre>
                </details>
              )}
              {/* §207：复习渲染复用受控 Markdown 渲染（ID 注释/原始 HTML 不显示）；
                  baseRelative 修正相对链接/图片基准；defsText 携带全文引用/脚注定义（§7.2 L197） */}
              <div className="review-body">
                <MarkdownView
                  text={bodyText ?? ""}
                  baseRelative={currentItem?.relativePath ?? ""}
                  defsText={fullText}
                  resolveImage={resolveImage}
                  onExternalLink={(u) =>
                    flashInfo(`外链请在系统浏览器打开：${u.length > 60 ? `${u.slice(0, 60)}…` : u}`)
                  }
                />
              </div>
              <div className="review-actions">
                {RATING_LABELS.map((r, i) => {
                  const p = preview.find((x) => x.rating === r.name);
                  return (
                    <button
                      type="button"
                      key={r.name}
                      className={`btn rate-btn ${r.tier}`}
                      disabled={busy || (needsRecheck && !resolution)}
                      title={`${r.hint}（键盘 ${r.key}）`}
                      onClick={() => void rate(r.name)}
                    >
                      <span className="rate-name">{r.hint}</span>
                      <span className="rate-hint">{r.name}</span>
                      <span className="rate-interval">
                        {p ? formatIntervalMs(p.intervalMs) : "…"}
                      </span>
                      <span className="rate-key">{i + 1}</span>
                    </button>
                  );
                })}
              </div>
              <div className="review-progress">
                本题 {index + 1}/{session.length} · 已评 {ratedCount}
              </div>
            </>
          )}
          {(phase === "hidden" || phase === "revealed") && (
            <div className="review-secondary-actions">
              <button type="button" className="text-button" onClick={skip} disabled={busy}>跳过本题</button>
              <span className="hint">仅本轮跳过，不改变复习安排</span>
              <details className="review-more" ref={moreRef}>
                <summary>更多操作</summary>
                <div className="review-more-content">
                  <p className="hint">暂停或排除后，可在「设置 → 复习内容管理」恢复。</p>
                  <button type="button" disabled={busy} onClick={() => void pause("PAUSE")}>暂停复习</button>
                  <button type="button" className="danger" disabled={busy} onClick={() => { setError(null); setExcludeConfirm(true); }}>排除此内容…</button>
                </div>
              </details>
            </div>
          )}
        </section>
      )}
      {excludeConfirm && currentItem && (
        <Modal title="排除此内容？" onDismiss={busy ? undefined : () => setExcludeConfirm(false)}>
          <p>「{currentItem.title ?? "前言"}」将不再进入复习队列。笔记正文和学习进度会保留。</p>
          <p className="hint">以后可以在「设置 → 复习内容管理 → 已排除」重新纳入。</p>
          {error && <p className="review-error" role="alert">{error.message}</p>}
          <div className="modal-actions">
            <button type="button" className="danger" disabled={busy} onClick={() => void pause("EXCLUDE")}>{busy ? "正在排除…" : "确认排除"}</button>
            <button type="button" disabled={busy} onClick={() => setExcludeConfirm(false)}>取消</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
