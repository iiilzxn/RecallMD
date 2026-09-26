// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { NoteMarkdownView } from "../../src/ui/NoteMarkdownView";

const saveRubric = vi.hoisted(() => vi.fn());

vi.mock("../../src/review/jev", async (original) => {
  const actual = await original<typeof import("../../src/review/jev")>();
  return { ...actual, jevIpc: { noteRubrics: async () => [{ blockId: "one", headingOffset: 0, points: ["原得分点"] }], saveNoteRubric: saveRubric } };
});

it("保存得分点失败时保留表单且不推进引导，重试成功后才推进", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onPointSaved = vi.fn();
  saveRubric.mockReset().mockRejectedValueOnce({ code: "IO_ERROR", message: "保存失败" }).mockResolvedValue({ blockId: "one", headingOffset: 0, points: ["原得分点", "新的得分点"] });
  try {
    await act(async () => root.render(createElement(NoteMarkdownView, { text: "# 题目\n\n原答案", baseRelative: "note.md", savedHash: "old", syncRevision: 0, active: true, onInclude: () => {}, onPointSaved })));
    await act(async () => container.querySelector<HTMLButtonElement>(".note-point-add")!.click());
    const input = document.querySelector<HTMLTextAreaElement>("#note-point-draft")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(input, "新的得分点"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    const save = Array.from(document.querySelectorAll<HTMLButtonElement>("dialog button")).find((button) => button.textContent === "保存得分点")!;
    await act(async () => save.click());
    expect(onPointSaved).not.toHaveBeenCalled();
    expect(input.value).toBe("新的得分点");
    expect(document.querySelector("dialog[open]")?.textContent).toContain("保存失败");
    await act(async () => save.click());
    expect(onPointSaved).toHaveBeenCalledTimes(1);
    expect(document.querySelector("dialog[open]")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("笔记被外部更新时保留正在输入的得分点，并阻止向旧题面保存", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props = { text: "# 题目\n\n原答案", baseRelative: "note.md", savedHash: "old", syncRevision: 0, active: true, onInclude: () => {} };
  try {
    await act(async () => root.render(createElement(NoteMarkdownView, props)));
    await act(async () => container.querySelector<HTMLButtonElement>(".note-point-chip")!.click());
    const input = document.querySelector<HTMLTextAreaElement>("#note-point-draft")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(input, "正在整理、尚未保存的得分点"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => root.render(createElement(NoteMarkdownView, { ...props, text: "# 题目\n\n外部改写后的答案", savedHash: "new" })));
    expect(document.querySelector<HTMLTextAreaElement>("#note-point-draft")?.value).toBe("正在整理、尚未保存的得分点");
    const save = Array.from(document.querySelectorAll<HTMLButtonElement>("dialog button")).find((button) => button.textContent === "保存得分点")!;
    expect(save.disabled).toBe(true);
    expect(document.querySelector("dialog")?.textContent).toContain("原文已变化");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
