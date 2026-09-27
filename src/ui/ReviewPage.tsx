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
import { jevIpc, type JevConfig, type JevGrade } from "../review/jev";
import { JevFeedback } from "./JevFeedback";
import { Icon } from "./Icon";
import type { GuideReviewState } from "./onboarding/state";
import { SpeechInput } from "./SpeechInput";
import { useSpeechConfig } from "./useSpeechConfig";
import { appendTranscript } from "../review/speech";

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
  learnNow?: boolean;
  onSwitchMode: () => void;
  service: ReviewService;
  onExit: () => void;
  onManage: () => void;
  /** 评分/参与变化后通知外层刷新侧栏到期角标 */
  onDueChanged: () => void;
  /** 工作区相对路径图片 → asset URL（M9 本地图片；由持有 workspace 根的 M2App 注入） */
  resolveImage?: (rel: string) => string | null;
  onGuideStateChange?: (state: GuideReviewState | null) => void;
  onRated?: () => void;
  onSpeechSettings?: () => void;
}

export function ReviewPage({ service, learnNow = false, onSwitchMode, onExit, onManage, onDueChanged, resolveImage, onGuideStateChange, onRated, onSpeechSettings }: Props) {
  const speech = useSpeechConfig();
  const [speechBusy, setSpeechBusy] = useState(false);
  const speechBusyRef = useRef(false);
  const onSpeechBusy = useCallback((value: boolean) => { speechBusyRef.current = value; setSpeechBusy(value); }, []);
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
  const [ratedCount, setRatedCount] = useState(0);
  const [excludeConfirm, setExcludeConfirm] = useState(false);
  const [jevConfig, setJevConfig] = useState<JevConfig | null>(null);
  const [jevConfigError, setJevConfigError] = useState<string | null>(null);
  const [answerDraft, setAnswerDraft] = useState("");
  const [submittedAnswer, setSubmittedAnswer] = useState("");
  const [jevResult, setJevResult] = useState<JevGrade | null>(null);
  const [jevError, setJevError] = useState<HostErrorShape | null>(null);
  const [grading, setGrading] = useState(false);
  const gradeRequestRef = useRef(0);
  const gradeBusyRef = useRef(false);
  const participationBusyRef = useRef(false);
  const moreRef = useRef<HTMLDetailsElement>(null);
  const reviewPageRef = useRef<HTMLDivElement>(null);
  const beginRef = useRef<Awaited<ReturnType<ReviewService["begin"]>> | null>(null);
  const startedAtRef = useRef(0);
  const requestIdRef = useRef<string | null>(null);
  /** 本会话跳过的块（§16 L1049：跳过仅本会话；重拉队列时排除，持久 due 不变） */
  const skippedRef = useRef<Set<string>>(new Set());

  const currentItem = session[index] ?? null;
  const question = currentItem?.title?.trim() || "回忆这篇笔记的前言内容";
  const jevReady = !learnNow && !!jevConfig?.enabled && jevConfig.hasApiKey && !!currentItem?.hasRubric;
  const navigationLocked = busy || speechBusy;
  const needsRecheck = beginRef.current?.state.needsRecheck ?? currentItem?.needsRecheck ?? false;

  useEffect(() => { onGuideStateChange?.({ phase }); }, [phase, onGuideStateChange]);
  useEffect(() => () => onGuideStateChange?.(null), [onGuideStateChange]);

  useEffect(() => {
    let cancelled = false;
    jevIpc.config().then((config) => { if (!cancelled) setJevConfig(config); })
      .catch((e: HostErrorShape) => { if (!cancelled) setJevConfigError(e.message); });
    return () => { cancelled = true; gradeRequestRef.current += 1; };
  }, []);

  const resetGrading = useCallback(() => {
    gradeRequestRef.current += 1;
    gradeBusyRef.current = false;
    setAnswerDraft("");
    setSubmittedAnswer("");
    setJevResult(null);
    setJevError(null);
    setGrading(false);
  }, []);

  const gradeAnswer = useCallback(async (token: string, answer: string) => {
    if (gradeBusyRef.current) return;
    const request = ++gradeRequestRef.current;
    gradeBusyRef.current = true;
    setGrading(true);
    setJevError(null);
    try {
      const result = await jevIpc.grade(token, answer);
      if (request === gradeRequestRef.current) setJevResult(result);
    } catch (e) {
      if (request === gradeRequestRef.current) setJevError(e as HostErrorShape);
    } finally {
      if (request === gradeRequestRef.current) { setGrading(false); gradeBusyRef.current = false; }
    }
  }, []);

  const flashInfo = useCallback((msg: string) => {
    setInfo(msg);
    window.setTimeout(() => setInfo((cur) => (cur === msg ? null : cur)), 2600);
  }, []);

  const loadCurrent = useCallback(
    async (items: QueueItemDto[], i: number) => {
      resetGrading();
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
      try {
        beginRef.current = await service.begin(item.blockId, learnNow);
        startedAtRef.current = service.now();
        setPhase("hidden");
        reviewPageRef.current?.closest(".page-mount")?.scrollTo({ top: 0 });
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
    [service, learnNow, flashInfo, resetGrading],
  );

  const loadQueue = useCallback(
    async (interactive: boolean) => {
      resetGrading();
      setPhase("loading");
      setError(null);
      setRatedCount(0);
      skippedRef.current = new Set();
      try {
        const q = await service.queue(undefined, learnNow);
        setQueueInfo(q);
        setSession(q.items);
        setIndex(0);
        if (q.items.length > 0) {
          await loadCurrent(q.items, 0);
        } else {
          beginRef.current = null;
          setPhase("done");
          if (interactive) flashInfo(learnNow ? "当前没有可开始的新题，或今日名额已用完" : "当前没有到期内容");
        }
      } catch (e) {
        setError(e as HostErrorShape);
        setPhase("done");
      }
    },
    [service, learnNow, loadCurrent, flashInfo, resetGrading],
  );

  useEffect(() => {
    void loadQueue(false);
  }, [loadQueue]);

  const advance = useCallback(
    (dropIndex: number) => {
      resetGrading();
      const next = session.filter((_, idx) => idx !== dropIndex);
      setSession(next);
      if (next.length === 0) {
        // 会话结束：重拉队列确认没有新到期（学习步 10 分钟内一般没有）；
        // 本会话跳过的块不再回场（§16 跳过仅本会话）
        beginRef.current = null;
        setIndex(0);
        void service
          .queue(undefined, learnNow)
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
    [session, service, learnNow, loadCurrent, resetGrading],
  );

  const reveal = useCallback(
    async (withContext: boolean) => {
      const item = currentItem;
      const begin = beginRef.current;
      if (!item || !begin || phase !== "hidden" || busy || speechBusyRef.current) return;
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
        if (answerDraft.trim()) {
          const answer = answerDraft.trim();
          setSubmittedAnswer(answer);
          if (jevReady && !withContext) void gradeAnswer(begin.token, answer);
        }
      } catch (e) {
        setError(e as HostErrorShape);
      } finally {
        setBusy(false);
      }
    },
    [currentItem, phase, busy, speechBusy, service, jevReady, answerDraft, gradeAnswer],
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
        const submitted = await service.submit({
          begin,
          rating,
          changeResolution: resolution ?? undefined,
          contextUsed,
          durationMs: service.now() - startedAtRef.current,
          requestId: requestIdRef.current,
        });
        setQueueInfo((queue) => queue ? { ...queue, quota: submitted.quota } : queue);
        requestIdRef.current = null;
        setRatedCount((n) => n + 1);
        onRated?.();
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
    [phase, busy, needsRecheck, resolution, service, contextUsed, index, session, advance, loadCurrent, flashInfo, onDueChanged, onRated],
  );

  const skip = useCallback(() => {
    if (!currentItem || navigationLocked || phase === "loading") return;
    skippedRef.current.add(currentItem.blockId);
    flashInfo("已跳过（仅本会话，到期安排不变）");
    advance(index);
  }, [currentItem, navigationLocked, phase, advance, index, flashInfo]);

  const pause = useCallback(
    async (action: "PAUSE" | "EXCLUDE") => {
      if (!currentItem || navigationLocked || participationBusyRef.current || phase === "loading") return;
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
    [currentItem, navigationLocked, phase, service, advance, index, flashInfo, onDueChanged],
  );

  // 键盘：Space 揭示 / 1–4 评分 / Esc 返回；输入框与 IME 组合中不触发（§16）
  const keyState = useRef({ phase, resolution, needsRecheck, rate, reveal, onExit, navigationLocked });
  keyState.current = { phase, resolution, needsRecheck, rate, reveal, onExit, navigationLocked };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || document.querySelector("dialog[open]")) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const s = keyState.current;
      if (e.key === "Escape") {
        e.preventDefault();
        if (s.navigationLocked) return;
        s.onExit();
        return;
      }
      // Space must still activate the focused button/summary rather than reveal a card.
      if (e.key === " ") {
        if (target?.closest("button, a, summary")) return;
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
        ...currentItem.headingPath.slice(0, -1),
      ].filter(Boolean)
    : [];

  // 会话进度：已评 /（已评 + 剩余），收敛到 100%
  const sessionTotal = ratedCount + session.length;
  const progressPct = sessionTotal > 0 ? Math.round((ratedCount / sessionTotal) * 100) : 0;

  return (
    <div className="review-page" ref={reviewPageRef}>
      <header className="review-header">
        <div className="review-header-main">
          <span className="eyebrow">{learnNow ? "理解，然后记住" : "主动回忆"}</span>
          <h1>{learnNow ? "开始一段新的学习" : "给记忆一点时间"}</h1>
          <div className="review-session-meta">
          <span className="review-count"><Icon name="review" size={14} />本轮剩余 {queueInfo ? session.length : "…"} 个小节</span>
          <span className="review-quota">今日新内容名额 {queueInfo?.quota.remaining ?? "–"}/{queueInfo?.quota.limit ?? "–"}</span>
          {phase === "done" && queueInfo?.nextUpcomingAt != null && (
            <span className="review-upcoming">稍后到期 {formatClock(queueInfo.nextUpcomingAt)}</span>
          )}
          </div>
        </div>
        <div className="review-header-actions">
          <button type="button" className="btn" onClick={onSwitchMode} disabled={navigationLocked || phase === "loading"}>
            {learnNow ? "去复习到期题" : "立即学习新题"}
          </button>
          <button type="button" className="btn icon-button" title="管理复习内容" aria-label="管理复习内容" onClick={onManage} disabled={navigationLocked}><Icon name="list" /></button>
          <button type="button" className="btn icon-button" title="刷新队列" aria-label="刷新队列" disabled={navigationLocked || phase === "loading"} onClick={() => void loadQueue(true)}>
            <Icon name="refresh" />
          </button>
          <button type="button" className="btn icon-button" title="返回笔记 (Esc)" aria-label="返回笔记" onClick={onExit} disabled={navigationLocked}>
            <Icon name="back" />
          </button>
        </div>
      </header>

      <p className="hint review-mode-hint">
        {learnNow
          ? "先明确题目，阅读原文理解内容，再选择学习评级。得分点可在笔记预览的小节标题旁添加。首次评级占用一个新题名额。"
          : "围绕题目独立作答，再揭示原文。开启 Jev 后，提交答案即可按笔记中设置的得分点批改。"}
      </p>
      {jevConfigError && <p className="hint" role="status">Jev 设置读取失败：{jevConfigError}。仍可手动复习。</p>}

      <div className="review-session-progress">
      <div className="review-progress-label"><span>本轮进度</span><span><strong>{ratedCount}</strong> / {sessionTotal}</span></div>
      <div className="review-progressbar" role="progressbar" aria-label="本轮复习进度" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${progressPct}%` }} />
      </div>
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
                  {learnNow ? "可以切换到到期复习，巩固已经学过的题目。" : `还有 ${queueInfo.counts.learning + queueInfo.counts.review} 个已到期内容待复习；`}
                  新题名额为每天 {queueInfo.quota.limit} 题，可在设置中调整。
                </p>
              </>
            ) : (
              <>
                <h3>本会话已完成</h3>
                <p>
                  还有 {queueInfo.counts.learning + queueInfo.counts.review + queueInfo.counts.newTotal}{" "}
                  个{learnNow ? "新题暂未学习" : "到期内容暂未复习"}（跳过仅本会话，下次仍会出现）。
                  {ratedCount > 0 && ` 本轮已评分 ${ratedCount} 题。`}
                </p>
              </>
            )
          ) : (
            <>
              <h3>{learnNow ? "当前没有待学的新题" : "当前没有到期内容"}</h3>
              <p>
                {learnNow ? "可以回到笔记，把每个问题写成一个小节，再点击「纳入复习」；已评分的题目会按间隔出现在到期复习中。" : queueInfo.nextUpcomingAt != null
                  ? `稍后到期：${formatClock(queueInfo.nextUpcomingAt)}`
                  : "全部复习完成，写点新笔记吧。"}
                {ratedCount > 0 && ` 本轮已评分 ${ratedCount} 题。`}
              </p>
            </>
          )}
          <div className="review-empty-actions">
            <button type="button" className="btn" onClick={onSwitchMode}>
              {learnNow ? "去复习到期题" : "立即学习新题"}
            </button>
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
          <div className="review-card-topline">
            <span className={`review-stage${phase === "revealed" ? " revealed" : ""}`}><Icon name={phase === "revealed" ? "check" : "review"} size={14} />{phase === "revealed" ? "对照与反馈" : learnNow ? "学习新内容" : "先试着回忆"}</span>
            <span className="review-card-number">{String(ratedCount + 1).padStart(2, "0")}</span>
          </div>
          <div className="review-breadcrumb"><Icon name="file" size={13} />{breadcrumb.join(" / ") || "知识库"}</div>
          <h2 className="review-title">
            {question}
          </h2>
          <div className="review-meta">
            <span>{({ NEW: "新内容", LEARNING: "学习中", REVIEW: "复习中", RELEARNING: "重新学习中" } as Record<string, string>)[currentItem.phase.toUpperCase()] ?? currentItem.phase}</span>
            {currentItem.neverRated && <span className="tag-new">首次评分</span>}
            {needsRecheck && <span className="tag-changed">正文已变更</span>}
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
              {!learnNow ? <div className="jev-answer-entry">
                <SpeechInput key={currentItem.blockId} config={speech.config} disabled={busy || speech.saving}
                  onBusyChange={onSpeechBusy} onOpenSettings={onSpeechSettings}
                  onTranscript={(result) => setAnswerDraft((text) => appendTranscript(text, result.text))} />
                {speech.error && <p className="hint">语音设置暂不可用：{speech.error} <button type="button" className="text-button" onClick={() => void speech.load()}>重试</button></p>}
                <label htmlFor="jev-answer">我的回忆答案</label>
                <p className="hint" id="jev-answer-help">用自己的话作答，也可以先口述再核对转写。提交后锁定答案、显示原文{jevReady ? "和评分" : "供你核对"}；得分点在作答时保持隐藏。</p>
                <textarea id="jev-answer" className="jev-textarea" rows={7} maxLength={20000} disabled={busy || speechBusy}
                  value={answerDraft} aria-describedby="jev-answer-help" placeholder="写下你记得的内容，不必逐字背诵…" onChange={(e) => setAnswerDraft(e.target.value)} />
              </div> : <div className="review-hidden">
                <span className="recall-symbol" aria-hidden="true"><Icon name={learnNow ? "book" : "review"} size={27} /></span>
                <strong>从理解开始</strong>
                <p>阅读原文，理解这一题的核心内容。</p>
              </div>}
              {!learnNow && !currentItem.hasRubric && <p className="hint">本题未设置得分点，仅对照原文；在笔记阅读视图中点击题目旁的「＋」添加后，Jev 才会评分。</p>}
              {!learnNow && currentItem.hasRubric && jevConfig?.enabled && !jevConfig.hasApiKey && <p className="hint">Jev 已开启，请在设置中保存 API Key。本次可先手动复习。</p>}
              <div className="review-actions reveal-actions" data-guide="reveal">
                <button
                  type="button"
                  className="btn primary"
                  disabled={navigationLocked}
                  onClick={() => void reveal(false)}
                >
                  {learnNow ? "阅读原文" : jevReady && answerDraft.trim() ? "提交答案并评分" : jevReady ? "显示原文（不打分）" : "显示原文"} (Space)
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={navigationLocked}
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
              {submittedAnswer && (!jevReady || contextUsed) && <div className="speech-answer-snapshot"><strong>你的回忆回答</strong><p>{submittedAnswer}</p></div>}
              {submittedAnswer && jevReady && !contextUsed && <JevFeedback answer={submittedAnswer} grading={grading} result={jevResult} error={jevError}
                retryDisabled={busy || !beginRef.current || jevError?.code === "REVIEW_TOKEN_STALE" || jevError?.code === "REVIEW_TOKEN_INVALID"}
                onRetry={() => { if (beginRef.current) void gradeAnswer(beginRef.current.token, submittedAnswer); }} />}
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
              <div className="rating-heading"><span>这次回忆，感觉怎么样？</span><small>按揭示前的表现选择</small></div>
              <div className="review-actions rating-actions" data-guide="rate">
                {RATING_LABELS.map((r, i) => {
                  const p = preview.find((x) => x.rating === r.name);
                  return (
                    <button
                      type="button"
                      key={r.name}
                      className={`btn rate-btn ${r.tier}`}
                      disabled={navigationLocked || (needsRecheck && !resolution)}
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
              <button type="button" className="text-button" onClick={skip} disabled={navigationLocked}>跳过本题</button>
              <span className="hint">仅本轮跳过，不改变复习安排</span>
              <details className="review-more" ref={moreRef}>
                <summary>更多操作</summary>
                <div className="review-more-content">
                  <p className="hint">暂停或排除后，可在「设置 → 复习内容管理」恢复。</p>
                  <button type="button" disabled={navigationLocked} onClick={() => void pause("PAUSE")}>暂停复习</button>
                  <button type="button" className="danger" disabled={navigationLocked} onClick={() => { setError(null); setExcludeConfirm(true); }}>排除此内容…</button>
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
