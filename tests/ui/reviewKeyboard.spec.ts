// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewPage } from "../../src/ui/ReviewPage";
import type { ReviewService } from "../../src/review/service";

vi.mock("../../src/editor/ipc", () => ({ ipc: { readDocument: async () => ({ text: "参考答案", rawByteHash: "hash" }) }, ipcCall: vi.fn().mockResolvedValue(null) }));
vi.mock("../../src/review/jev", async (original) => {
  const actual = await original<typeof import("../../src/review/jev")>();
  return { ...actual, jevIpc: { config: async () => ({ enabled: false, hasApiKey: false }) } };
});

let root: Root;
let container: HTMLDivElement;
let submit: ReturnType<typeof vi.fn>;
let onRated: ReturnType<typeof vi.fn<() => void>>;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const item = { blockId: "one", relativePath: "note.md", headingPath: [], title: "测试题", phase: "REVIEW", neverRated: false, needsRecheck: false, recallPrompt: "测试题", startOffset: 0, bodyStartOffset: 0, endOffset: 4 };
  submit = vi.fn().mockResolvedValue({ quota: { limit: 20, usedToday: 1, remaining: 19 } });
  onRated = vi.fn();
  const service = {
    queue: vi.fn().mockResolvedValue({ items: [item], counts: { learning: 0, review: 1, newTotal: 0 }, quota: { limit: 20, usedToday: 0, remaining: 20 }, nextUpcomingAt: null }),
    begin: vi.fn().mockResolvedValue({ token: "test-token", state: { needsRecheck: false } }),
    now: () => 100, previewIntervals: () => [], submit,
  } as unknown as ReviewService;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(ReviewPage, { service, onSwitchMode: () => {}, onExit: () => {}, onManage: () => {}, onDueChanged: () => {}, onRated })));
  const reveal = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.startsWith("显示原文"))!;
  await act(async () => reveal.click());
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("复习键盘操作", () => {
  it("焦点在按钮上时仍能按 3 选择 Good", async () => {
    const button = container.querySelector<HTMLButtonElement>(".rate-btn.again")!;
    await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true })));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ rating: "Good" }));
    expect(onRated).toHaveBeenCalledTimes(1);
  });

  it("带修饰键、重复按键和输入框中的数字不提交评分", async () => {
    const input = document.createElement("input");
    container.append(input);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "3", ctrlKey: true, bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "3", repeat: true, bubbles: true }));
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("评分写入失败时不通知引导完成，重试成功才通知", async () => {
    submit.mockRejectedValueOnce({ code: "IO_ERROR", message: "写入失败" });
    const button = container.querySelector<HTMLButtonElement>(".rate-btn.good")!;
    await act(async () => button.click());
    expect(onRated).not.toHaveBeenCalled();
    expect(container.querySelector(".rating-actions")).not.toBeNull();
    await act(async () => button.click());
    expect(onRated).toHaveBeenCalledTimes(1);
  });
});
