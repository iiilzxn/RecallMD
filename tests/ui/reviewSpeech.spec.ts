// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewPage } from "../../src/ui/ReviewPage";
import type { ReviewService } from "../../src/review/service";

const host = vi.hoisted(() => ({ read: vi.fn(), start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), grade: vi.fn(), jev: false }));
vi.mock("../../src/editor/ipc", () => ({ ipc: { readDocument: host.read }, ipcCall: vi.fn().mockResolvedValue(null) }));
vi.mock("../../src/review/jev", async (original) => ({ ...await original<typeof import("../../src/review/jev")>(), jevIpc: { config: async () => ({ enabled: host.jev, hasApiKey: host.jev }), grade: host.grade } }));
vi.mock("../../src/review/speech", async (original) => ({ ...await original<typeof import("../../src/review/speech")>(), speechIpc: {
  config: async () => ({ enabled: true, model: "paraformer-bilingual-fp32", modelsRoot: "D:/Models", device: null, maxSeconds: 180, models: [{ id: "paraformer-bilingual-fp32", label: "双语模型", ready: true, missing: [], sizeMib: 825 }] }),
  start: host.start, stop: host.stop, cancel: host.cancel, status: async (sessionId: string) => ({ sessionId, seconds: 1, level: .1, stopped: false, error: null }),
} }));
let root: Root, container: HTMLDivElement;
async function mount({ hasRubric = true, learnNow = false, legacyGoal = "" } = {}) {
  const item = { blockId: "one", relativePath: "note.md", headingPath: ["数据结构", "栈的顺序？"], title: "栈的顺序？", phase: "REVIEW", neverRated: false, needsRecheck: false, hasRubric, recallPrompt: legacyGoal, startOffset: 0, bodyStartOffset: 0, endOffset: 4 };
  const service = { queue: async () => ({ items: [item], counts: { learning: 0, review: 1, newTotal: 0 }, quota: { limit: 20, usedToday: 0, remaining: 20 }, nextUpcomingAt: null }), begin: async () => ({ token: "test-token", state: { needsRecheck: false } }), now: () => 100, previewIntervals: () => [] } as unknown as ReviewService;
  await act(async () => root.render(createElement(ReviewPage, { service, learnNow, onSwitchMode: () => {}, onExit: () => {}, onManage: () => {}, onDueChanged: () => {} })));
}
async function click(prefix: string) { const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.startsWith(prefix))!; expect(button).toBeTruthy(); await act(async () => button.click()); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.jev = false; host.read.mockReset().mockResolvedValue({ text: "参考答案", rawByteHash: "hash" });
  host.start.mockReset().mockImplementation(async (sessionId) => ({ sessionId, device: "测试麦克风" }));
  host.stop.mockReset().mockImplementation(async (sessionId) => ({ sessionId, model: "paraformer-bilingual-fp32", text: "后进先出", audioSeconds: 2, processingMs: 300 }));
  host.cancel.mockReset().mockResolvedValue(undefined); host.grade.mockReset().mockResolvedValue({ score: 100, points: [] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("语音与复习流程", () => {
  it("不开 Jev 也能语音回答，揭示后保留答案，不请求智能评分", async () => {
    await mount(); await click("语音回答");
    const reveal = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.startsWith("显示原文"))!;
    expect(reveal.disabled).toBe(true);
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    expect(host.read).not.toHaveBeenCalled();
    await click("结束并转写");
    expect(container.querySelector<HTMLTextAreaElement>("#jev-answer")!.value).toBe("后进先出");
    await click("显示原文");
    expect(container.querySelector(".speech-answer-snapshot")?.textContent).toContain("后进先出");
    expect(host.grade).not.toHaveBeenCalled();
  });
  it("开启 Jev 后只在用户确认提交时发送修改后的答案", async () => {
    host.jev = true; await mount(); await click("语音回答"); await click("结束并转写");
    expect(host.grade).not.toHaveBeenCalled();
    const field = container.querySelector<HTMLTextAreaElement>("#jev-answer")!;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { set.call(field, "后进先出，最后放入的最先取出。"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await click("提交答案并评分");
    expect(host.grade).toHaveBeenCalledExactlyOnceWith("test-token", "后进先出，最后放入的最先取出。");
  });
  it("开启 Jev 但没有得分点时，只揭示原文并保留回答", async () => {
    host.jev = true;
    await mount({ hasRubric: false });
    expect(container.textContent).toContain("本题未设置得分点");
    await click("语音回答"); await click("结束并转写");
    expect(container.textContent).not.toContain("提交答案并评分");
    await click("显示原文");
    expect(host.read).toHaveBeenCalledOnce();
    expect(host.grade).not.toHaveBeenCalled();
    expect(container.querySelector(".speech-answer-snapshot")?.textContent).toContain("后进先出");
    expect(container.querySelector(".rating-actions")).not.toBeNull();
  });
  it("小节问题作为主标题，旧回忆目标不显示，路径不重复题目", async () => {
    await mount({ legacyGoal: "根因是异步同步" });
    expect(container.querySelector("h2.review-title")?.textContent).toBe("栈的顺序？");
    expect(container.querySelector(".review-breadcrumb")?.textContent).toBe("note.md / 数据结构");
    expect(container.textContent).not.toContain("根因是异步同步");
    expect(container.querySelector("#recall-prompt")).toBeNull();
  });
  it("新题无需设置回忆目标即可阅读原文，不触发 Jev", async () => {
    host.jev = true;
    await mount({ learnNow: true });
    expect(container.querySelector("h2.review-title")?.textContent).toBe("栈的顺序？");
    expect(container.textContent).not.toContain("题目目标");
    await click("阅读原文");
    expect(host.read).toHaveBeenCalledOnce();
    expect(container.querySelector(".rating-actions")).not.toBeNull();
    expect(host.grade).not.toHaveBeenCalled();
  });
  it("即使有得分点，展开上下文也不触发 Jev", async () => {
    host.jev = true;
    await mount();
    await click("语音回答"); await click("结束并转写");
    await click("展开上下文正文");
    expect(host.grade).not.toHaveBeenCalled();
    expect(container.querySelector(".speech-answer-snapshot")?.textContent).toContain("后进先出");
  });
  it("有得分点但未作答时可直接对照原文", async () => {
    host.jev = true; await mount();
    await click("显示原文（不打分）");
    expect(host.grade).not.toHaveBeenCalled();
    expect(container.querySelector(".rating-actions")).not.toBeNull();
  });
  it("语音按钮中的空格不能意外揭示答案", async () => {
    await mount(); const select = container.querySelector(".speech-input button")!;
    await act(async () => select.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    expect(host.read).not.toHaveBeenCalled();
  });
});
