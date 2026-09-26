import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../Icon";
import { Modal } from "../Modal";
import { nextStep, observedStep, readGuide, TOUR_STEPS, visibleStep, writeGuide, type GuideContext, type TourStep } from "./state";
import "./onboarding.css";

export const EXAMPLE_NOTE = "# 我的第一张复习卡\n\n## 栈遵循什么出栈顺序？\n\n栈遵循后进先出（LIFO）：最后放进去的元素最先取出。\n\n就像叠起来的盘子，通常先拿走最上面的一个。\n";

export function useOnboarding() {
  const [state, setState] = useState(readGuide);
  const [introOpen, setIntroOpen] = useState(() => !state.introSeen);
  useEffect(() => writeGuide(state), [state]);
  const pause = useCallback(() => setState((s) => ({ ...s, introSeen: true, status: "paused" })), []);
  const openIntro = useCallback(() => {
    setState((s) => s.status === "active" ? { ...s, status: "paused" } : s);
    setIntroOpen(true);
  }, []);
  const closeIntro = useCallback(() => {
    setIntroOpen(false);
    setState((s) => ({ ...s, introSeen: true }));
  }, []);
  const start = useCallback(() => {
    setIntroOpen(false);
    setState({ version: 1, introSeen: true, status: "active", step: "workspace" });
  }, []);
  const resume = useCallback(() => setState((s) => ({ ...s, status: "active" })), []);
  const finish = useCallback(() => setState((s) => ({ ...s, status: "complete", step: "done" })), []);
  const dismissReminder = useCallback(() => setState((s) => ({ ...s, status: "idle" })), []);
  const advance = useCallback((from: TourStep) => setState((s) => s.status === "active" && s.step === from ? { ...s, step: nextStep(from) } : s), []);
  const observe = useCallback((context: GuideContext) => setState((s) => {
    if (s.status !== "active") return s;
    const step = observedStep(s.step, context);
    return step === s.step ? s : { ...s, step };
  }), []);
  return { state, introOpen, openIntro, closeIntro, start, pause, resume, finish, dismissReminder, advance, observe };
}

const CONCEPTS = [
  { eyebrow: "01 / 知识的起点", title: "你的笔记，就是知识库。", description: "选一个本地文件夹，放进 Markdown 笔记。熟悉的文字、代码和图表，都可以成为学习材料。", detail: "笔记以 .md 文件保存在本地，随时可以用其他编辑器打开。" },
  { eyebrow: "02 / 从记录到学习", title: "一个小节，一个值得回忆的问题。", description: "用标题组织知识，在下面写清答案。点击「纳入复习」，有正文的小节就能参与学习。", detail: "学习时再为小节设置明确的题目目标，让每次回忆都有方向。" },
  { eyebrow: "03 / 给答案一个标准", title: "学的时候，留下得分点。", description: "在阅读视图中，点小节标题旁的「＋」，记录回答必须包含的要点。可以添加多个，也能随时修改。", detail: "标签超过 5 个字会省略，悬浮可看全文。Jev 打分是可选项，在设置中开启并填写 API Key；也可以一直手动复习。" },
  { eyebrow: "04 / 让理解留下来", title: "先回忆，再翻开答案。", description: "先用「学习新内容」理解笔记。以后到「今日复习」尝试回忆，核对原文，再如实选择回忆表现。", detail: "软件据此安排下一次复习。忘记也没关系，选择「没回忆起来」，再学一次。" },
] as const;

/** Code-native concept diagrams stay sharp and follow both app themes. */
function ConceptArt({ page }: { page: number }) {
  return <div className={`guide-art guide-art-${page}`} aria-hidden="true">
    <span className="guide-art-caption">RECALLMD / FIELD NOTES</span>
    {page === 0 && <div className="guide-library-art">
      <div className="guide-folder"><Icon name="folder" size={45} /><strong>我的知识库</strong><small>一个自己的文件夹</small></div>
      <div className="guide-paper guide-paper-back"><Icon name="file" size={20} /><span>读书笔记.md</span><i /><i /><i /></div>
      <div className="guide-paper"><Icon name="file" size={20} /><span>数据结构.md</span><b>## 栈的出栈顺序</b><i /><i /><div className="guide-mini-tag">Markdown · 本地</div></div>
    </div>}
    {page === 1 && <div className="guide-section-art">
      <div className="guide-paper"><span className="guide-code-line"># 数据结构</span><b><em>##</em> 栈遵循什么出栈顺序？</b><p>后进先出，最后放入的先取出。</p><div className="guide-paper-divider" /><b><em>##</em> 队列遵循什么顺序？</b><p>先进先出，最先放入的先取出。</p></div>
      <div className="guide-art-connector"><Icon name="arrow" size={22} /><small>纳入复习</small></div>
      <div className="guide-card-stack"><div><Icon name="review" size={18} /><b>栈的出栈顺序</b><small>一题，专注一个知识点</small></div><div><Icon name="review" size={18} /><b>队列的顺序</b></div></div>
    </div>}
    {page === 2 && <div className="guide-points-art">
      <div className="guide-paper"><span>数据结构 / 阅读</span><div className="guide-example-heading"><b>栈遵循什么出栈顺序？</b><span className="guide-fake-plus">＋</span></div><div className="guide-example-tags"><span>后进先出</span><span>最后入栈的…</span></div><p>像一叠盘子，最上面的先取走。</p><i /><i /></div>
      <div className="guide-art-callout"><Icon name="spark" size={18} /><div><small>保存完整含义</small><strong>最后入栈的元素最先出栈</strong></div></div>
    </div>}
    {page === 3 && <div className="guide-cycle-art">
      <div className="guide-cycle-question"><Icon name="review" size={25} /><small>今日复习</small><strong>栈遵循什么出栈顺序？</strong><span>先试着用自己的话回答。</span></div>
      <div className="guide-cycle-steps"><span><i>1</i>主动回忆</span><Icon name="arrow" size={16} /><span><i>2</i>核对原文</span><Icon name="arrow" size={16} /><span><i>3</i>如实评价</span></div>
      <div className="guide-next-review"><Icon name="clock" size={16} /><span>在合适的时间，再见一面</span><span className="guide-cycle-line" /></div>
    </div>}
    <span className="guide-art-number">0{page + 1}</span>
  </div>;
}

function Intro({ guide }: { guide: ReturnType<typeof useOnboarding> }) {
  const [page, setPage] = useState(0);
  const content = CONCEPTS[page];
  return <Modal title="欢迎来到 RecallMD" onDismiss={guide.closeIntro} className="onboarding-dialog">
    <ConceptArt page={page} />
    <div className="guide-intro-copy" aria-live="polite" aria-atomic="true">
      <span className="eyebrow">{content.eyebrow}</span>
      <h2>{content.title}</h2><p>{content.description}</p><p className="guide-intro-detail">{content.detail}</p>
    </div>
    <div className="guide-intro-footer">
      <nav className="guide-page-dots" aria-label="概念图页码">{CONCEPTS.map((item, i) => <button key={item.title} type="button" aria-label={`第 ${i + 1} 页：${item.title}`} aria-current={page === i ? "step" : undefined} onClick={() => setPage(i)} />)}</nav>
      <div className="guide-intro-buttons">{page > 0 && <button type="button" className="btn" onClick={() => setPage(page - 1)}>上一步</button>}<button type="button" className="btn primary" onClick={() => page === CONCEPTS.length - 1 ? guide.start() : setPage(page + 1)}>{page === CONCEPTS.length - 1 ? "开始操作引导" : "下一步"}<Icon name="arrow" size={16} /></button></div>
    </div>
    <button type="button" className="text-button guide-intro-skip" onClick={guide.closeIntro}>先自己探索，以后从「新手引导」重新打开</button>
  </Modal>;
}

type Rect = { left: number; top: number; width: number; height: number };
const TARGETS: Record<TourStep, string | null> = {
  workspace: "workspace", note: "new-file", include: "include", preview: "preview", points: "point-add",
  learn: "learn", goal: "goal", reveal: "reveal", rate: "rate", done: null,
};

/** Non-modal coach: only the card receives pointer events, the real app stays usable. */
function Coach({ target, children, label }: { target: string | null; children: React.ReactNode; label: string }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ card: { left: number; top: number }; ring: Rect | null; suspended: boolean } | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    let lastTarget: Element | null = null;
    const measure = () => {
      frame = 0;
      const card = cardRef.current;
      if (!card) return;
      const suspended = !!document.querySelector("dialog[open]");
      const element = target ? Array.from(document.querySelectorAll<HTMLElement>(`[data-guide="${target}"]`)).find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !el.closest("[inert], .is-hidden");
      }) : null;
      let rect = element?.getBoundingClientRect();
      if (element && element !== lastTarget && !suspended) {
        lastTarget = element;
        if (rect && (rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth)) {
          element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
          rect = element.getBoundingClientRect();
        }
      }
      const margin = 16, gap = 16;
      const width = card.offsetWidth, height = card.offsetHeight;
      const clampX = (x: number) => Math.max(margin, Math.min(x, innerWidth - width - margin));
      const clampY = (y: number) => Math.max(margin, Math.min(y, innerHeight - height - margin));
      let left = innerWidth - width - margin, top = innerHeight - height - margin;
      let ring: Rect | null = null;
      if (rect && rect.bottom > 0 && rect.top < innerHeight) {
        ring = { left: Math.max(4, rect.left - 4), top: Math.max(4, rect.top - 4), width: Math.min(rect.width + 8, innerWidth - 8), height: Math.min(rect.height + 8, innerHeight - 8) };
        // Prefer beside a control, then below/above. Each fit keeps the target clear.
        if (rect.right + gap + width <= innerWidth - margin) { left = rect.right + gap; top = clampY(rect.top); }
        else if (rect.left - gap - width >= margin) { left = rect.left - gap - width; top = clampY(rect.top); }
        else if (rect.bottom + gap + height <= innerHeight - margin) { left = clampX(rect.left); top = rect.bottom + gap; }
        else if (rect.top - gap - height >= margin) { left = clampX(rect.left); top = rect.top - gap - height; }
      }
      const value = { card: { left: clampX(left), top: clampY(top) }, ring, suspended };
      setLayout((old) => JSON.stringify(old) === JSON.stringify(value) ? old : value);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "disabled"] });
    const resize = new ResizeObserver(schedule);
    if (cardRef.current) resize.observe(cardRef.current);
    const shell = document.querySelector(".m2-shell");
    if (shell) resize.observe(shell);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    measure();
    return () => { cancelAnimationFrame(frame); mutations.disconnect(); resize.disconnect(); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true); };
  }, [target]);
  return createPortal(<div className="guide-coach-layer" style={{ visibility: layout && !layout.suspended ? "visible" : "hidden" }}>
    {layout?.ring && <div className="guide-target-ring" style={layout.ring} aria-hidden="true" />}
    <div ref={cardRef} className="guide-coach" role="region" aria-label={label} style={layout?.card}>{children}</div>
  </div>, document.body);
}

const TITLES: Record<TourStep, string> = {
  workspace: "选一个知识库文件夹", note: "打开你的第一篇笔记", include: "让一个小节加入复习", preview: "切到阅读视图", points: "在标题旁，添一个得分点",
  learn: "开始学习新内容", goal: "给这一题一个清晰的目标", reveal: "阅读、理解，再对照", rate: "如实选择回忆表现", done: "第一次练习，完成了。",
};
const DESCRIPTIONS: Record<TourStep, string> = {
  workspace: "点击「选择知识库文件夹」，也可以打开最近使用的知识库。新建一个空文件夹，就能从零开始。",
  note: "从左侧打开已有的 .md 笔记，或点击「新建文件」。新文件的名字以 .md 结尾，例如「我的笔记.md」。",
  include: "用 Markdown 标题写问题，在下面写答案，然后点「纳入复习」。软件会保存笔记，并把有正文的小节加入复习。只有空标题时还不能复习。",
  preview: "点击工具栏的「阅读」，看看 Markdown 渲染后的样子。下一步，我们直接在小节标题旁标记答案要点。",
  points: "点击小节标题旁的「＋」，写下一个回答必须包含的要点并保存。可以添加多个；标签悬浮能看全文，点击能编辑。这一步可以跳过。",
  learn: "点击左侧「学习新内容」，为尚未学过的小节设置题目目标。已有学习记录的内容，可以到「今日复习」查看。",
  goal: "题目目标是复习时看到的问题，例如「栈遵循什么出栈顺序？」。输入后点「保存目标」，也可以用小节标题填写。得分点是答案标准，两者各有用途。",
  reveal: "首次学习先阅读原文、理解内容。以后复习时，先试着回忆，再显示原文核对；忘记的部分也是下一次学习的线索。",
  rate: "核对后按实际表现选择一档，软件会安排下次复习。没想起来选第一档，正确但费力选第二档；第三、四档分别表示正常、轻松完整的回忆。初次阅读不等于已经记住。",
  done: "你已经走过了笔记、学习和评价的流程。之后按「今日复习」的安排回来，让知识慢慢留在记忆里。",
};

export function Onboarding({ guide, context, onNewFile, onFillExample, onNavigate }: {
  guide: ReturnType<typeof useOnboarding>;
  context: GuideContext;
  onNewFile: () => void;
  onFillExample: () => void;
  onNavigate: (view: "editor" | "learn" | "review" | "settings") => void;
}) {
  const { state, observe } = guide;
  const headingId = useId();
  const contextKey = JSON.stringify(context);
  useEffect(() => { if (!guide.introOpen) observe(context); }, [contextKey, state.step, state.status, guide.introOpen, observe]); // primitive key prevents effect churn on parent renders
  if (guide.introOpen) return <Intro guide={guide} />;
  if (state.status === "paused") return <Coach target={null} label="操作引导已暂停"><div className="guide-resume"><Icon name="book" size={19} /><span>新手引导已暂停</span><button type="button" className="text-button" onClick={guide.resume}>继续引导</button><button type="button" className="tree-act" aria-label="收起引导提醒" onClick={guide.dismissReminder}><Icon name="close" size={14} /></button></div></Coach>;
  if (state.status !== "active") return null;
  const step = visibleStep(state.step, context);
  const needsEditor = ["note", "include", "preview", "points"].includes(step) && context.view !== "editor";
  const needsReview = ["goal", "reveal", "rate"].includes(step) && context.view !== "review";
  const queueEmpty = ["goal", "reveal", "rate"].includes(step) && context.view === "review" && context.review?.phase === "done";
  const target = needsEditor ? "notes" : needsReview ? "learn" : queueEmpty ? "review-nav" : TARGETS[step];
  const progress = Math.min(TOUR_STEPS.indexOf(state.step) + 1, 9);
  return <Coach target={target} label="新手操作引导">
    <div className="guide-coach-top"><span><Icon name="book" size={15} />上手指南 · {step === "done" ? "已完成" : `${progress} / 9`}</span><button type="button" className="tree-act" aria-label="暂停操作引导" onClick={guide.pause}><Icon name="close" size={15} /></button></div>
    <div className="guide-step-track" aria-hidden="true">{TOUR_STEPS.slice(0, 9).map((s, i) => <i key={s} className={i < progress ? "filled" : ""} />)}</div>
    <div aria-live="polite" aria-atomic="true"><h3 id={headingId}>{queueEmpty ? "当前队列里没有内容" : TITLES[step]}</h3><p>{queueEmpty ? "可能还未纳入内容、内容已学过，或今天的新内容配额已用完。可以看看「今日复习」，也可以先结束引导，之后再从设置中打开。" : DESCRIPTIONS[step]}</p></div>
    {step === "include" && !needsEditor && <>
      <pre className="guide-note-example">{"## 栈遵循什么出栈顺序？\n\n后进先出，最后放入的先取出。"}</pre>
      {context.engineDead && <p className="guide-step-note" role="status">复习内容识别暂不可用，请重新打开软件后继续；可以先保存笔记。</p>}
      {!context.canEdit && <p className="guide-step-note" role="status">这篇笔记目前无法编辑，请先处理页面上的提示，或打开另一篇笔记。</p>}
      {context.empty && context.canEdit && <button type="button" className="btn" onClick={onFillExample}>在空白笔记中填入示例</button>}
    </>}
    {step === "preview" && context.oversized && <p className="guide-step-note">这篇笔记过大，无法预览。请打开一篇较短的笔记后继续。</p>}
    {step === "points" && <details className="guide-step-note"><summary>没有看到 ＋？</summary><p>请等小节识别完成，并确认它在「复习内容管理」中处于启用状态。</p></details>}
    {step === "done" && <div className="guide-step-note"><Icon name="spark" size={16} />想试试 Jev？在「设置 → Jev 打分」开启并填写 API Key，再按预设得分点辅助评分。最终回忆表现仍由你选择。</div>}
    <div className="guide-coach-actions">
      {needsEditor ? <button type="button" className="btn primary" onClick={() => onNavigate("editor")}>返回笔记<Icon name="arrow" size={15} /></button> : needsReview ? <button type="button" className="btn primary" onClick={() => onNavigate("learn")}>返回学习<Icon name="arrow" size={15} /></button> : <>
        {step === "note" && <button type="button" className="btn primary" onClick={onNewFile}>新建一篇笔记<Icon name="plus" size={15} /></button>}
        {step === "points" && <button type="button" className="btn" onClick={() => guide.advance("points")}>先跳过，稍后再设置</button>}
        {queueEmpty && <><button type="button" className="btn" onClick={() => onNavigate("review")}>打开今日复习</button><button type="button" className="text-button" onClick={guide.finish}>先结束引导</button></>}
        {step === "done" && <button type="button" className="btn primary" onClick={guide.finish}>开始自己的学习<Icon name="check" size={15} /></button>}
      </>}
      {step !== "done" && !queueEmpty && <button type="button" className="text-button" onClick={guide.pause}>稍后继续</button>}
    </div>
  </Coach>;
}
