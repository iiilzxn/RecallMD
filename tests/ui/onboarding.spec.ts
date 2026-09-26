// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding, useOnboarding } from "../../src/ui/onboarding/Onboarding";
import { INITIAL_GUIDE, ONBOARDING_KEY, observedStep, readGuide, visibleStep, writeGuide, type GuideContext } from "../../src/ui/onboarding/state";

const empty: GuideContext = { workspace: false, file: false, view: "editor", clean: false, enrolled: false, preview: false, empty: true, canEdit: false, engineDead: false, oversized: false, review: null };
let context: GuideContext;
let controller: ReturnType<typeof useOnboarding>;
let root: Root;
let container: HTMLDivElement;
function Harness() {
  controller = useOnboarding();
  return createElement(Onboarding, { guide: controller, context, onNewFile: () => {}, onFillExample: () => {}, onNavigate: () => {} });
}
async function render(patch: Partial<GuideContext> = {}) {
  context = { ...context, ...patch };
  await act(async () => root.render(createElement(Harness)));
}
async function button(text: string) {
  const target = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => (b.getAttribute("aria-label") ?? b.textContent) === text);
  expect(target, text).toBeTruthy();
  await act(async () => target!.click());
}
beforeEach(() => {
  localStorage.removeItem(ONBOARDING_KEY);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  context = { ...empty };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.removeItem(ONBOARDING_KEY);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("新用户引导", () => {
  it("首次打开显示四页概念图，跳过后重新启动不再弹出，仍能主动重看", async () => {
    await render();
    expect(document.querySelector("dialog[open]")?.textContent).toContain("你的笔记，就是知识库");
    for (const text of ["一个小节，一个值得回忆的问题", "学的时候，留下得分点", "先回忆，再翻开答案"]) {
      await button("下一步");
      expect(document.querySelector(".guide-intro-copy")?.textContent).toContain(text);
    }
    await button("先自己探索，以后从「新手引导」重新打开");
    expect(readGuide().introSeen).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(document.querySelector("dialog[open]")).toBeNull();
    await act(async () => controller.openIntro());
    expect(document.querySelector("dialog[open]")).not.toBeNull();
  });

  it("取消选择知识库、未保存或保存失败，都不能提前完成纳入步骤", async () => {
    await render();
    await act(async () => controller.start());
    expect(controller.state.step).toBe("workspace");
    await render({ workspace: true });
    expect(controller.state.step).toBe("note");
    await render({ file: true, canEdit: true });
    expect(controller.state.step).toBe("include");
    await render({ enrolled: true });
    expect(controller.state.step).toBe("include");
    await render({ clean: true });
    expect(controller.state.step).toBe("preview");
    await render({ preview: true });
    expect(controller.state.step).toBe("points");
  });

  it("得分点可跳过，但实际评分成功前不能宣布完成", async () => {
    writeGuide({ ...INITIAL_GUIDE, introSeen: true, status: "active", step: "points" });
    context = { ...empty, workspace: true, file: true, clean: true, enrolled: true, preview: true };
    await render();
    await button("先跳过，稍后再设置");
    expect(controller.state.step).toBe("learn");
    await render({ view: "review", review: { phase: "hidden", goalReady: false } });
    expect(controller.state.step).toBe("goal");
    await render({ review: { phase: "hidden", goalReady: true } });
    expect(controller.state.step).toBe("reveal");
    await render({ review: { phase: "revealed", goalReady: true } });
    expect(controller.state.step).toBe("rate");
    await render({ review: { phase: "done", goalReady: false } });
    expect(controller.state.step).toBe("rate"); // Empty queue / skip is not a successful rating.
    await act(async () => controller.advance("rate"));
    expect(controller.state.step).toBe("done");
    expect(document.querySelector(".guide-coach")?.textContent).toContain("第一次练习，完成了");
  });

  it("暂停与收起提醒会保留进度，重启后可继续；重看概念图不会在后台推进", async () => {
    writeGuide({ ...INITIAL_GUIDE, introSeen: true, status: "active", step: "include" });
    await render({ workspace: true, file: true });
    await button("暂停操作引导");
    await button("收起引导提醒");
    expect(controller.state).toMatchObject({ status: "idle", step: "include" });
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await act(async () => controller.resume());
    expect(controller.state).toMatchObject({ status: "active", step: "include" });
    await act(async () => controller.openIntro());
    await render({ clean: true, enrolled: true });
    expect(controller.state.step).toBe("include");
    await button("关闭对话框");
    await button("继续引导");
    expect(controller.state.step).toBe("preview");
  });

  it("恢复到需要笔记的步骤时，提示先打开知识库和笔记但不丢失原进度", () => {
    expect(visibleStep("points", empty)).toBe("workspace");
    expect(visibleStep("points", { ...empty, workspace: true })).toBe("note");
    expect(visibleStep("points", { ...empty, workspace: true, file: true })).toBe("include");
    expect(observedStep("points", { ...empty, workspace: true })).toBe("points");
  });

  it("取题尚未完成、题目重新隐藏时不会指向失效的评分按钮", () => {
    const review: GuideContext = { ...empty, workspace: true, view: "review", review: { phase: "loading", goalReady: true } };
    expect(observedStep("goal", review)).toBe("goal");
    review.review = { phase: "hidden", goalReady: true };
    expect(visibleStep("rate", review)).toBe("reveal");
    review.review = { phase: "hidden", goalReady: false };
    expect(visibleStep("rate", review)).toBe("goal");
  });

  it("没有可学习内容时给出今日复习和结束入口", async () => {
    writeGuide({ ...INITIAL_GUIDE, introSeen: true, status: "active", step: "goal" });
    await render({ workspace: true, view: "review", review: { phase: "done", goalReady: false } });
    expect(document.querySelector(".guide-coach")?.textContent).toContain("当前队列里没有内容");
    await button("先结束引导");
    expect(controller.state.status).toBe("complete");
    expect(document.querySelector(".guide-coach")).toBeNull();
  });

  it("偏好损坏、旧版本或存储不可用不会阻止首次启动", () => {
    for (const text of ["{bad", "null", '{"version":9}', JSON.stringify({ ...INITIAL_GUIDE, step: "unknown" })]) {
      localStorage.setItem(ONBOARDING_KEY, text);
      expect(readGuide()).toEqual(INITIAL_GUIDE);
    }
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => writeGuide(INITIAL_GUIDE)).not.toThrow();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("disabled"); });
    expect(readGuide()).toEqual(INITIAL_GUIDE);
  });
});
