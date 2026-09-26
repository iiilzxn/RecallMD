// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorCallbacks } from "../../src/editor/EditorController";
import type { ReadDocumentDto } from "../../src/editor/ipc";

const host = vi.hoisted(() => ({ read: vi.fn(), draft: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (value: string) => value,
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "workspace_info") return { workspaceId: "test", root: "D:/Test", formatVersion: 1 };
    if (command === "workspace_recent_list") return [];
    if (command === "tree_list") return ["A.md", "B.md", "Large.md"].map((name) => ({ name, relativePath: name, isDir: false }));
    if (command === "read_document") return host.read(args.relativePath);
    if (command === "draft_read") return host.draft(args.relativePath);
    if (command === "app_config_read") return { dailyNewLimit: 20, autosave: false };
    if (command === "review_queue") return { items: [], counts: { learning: 0, review: 0, newTotal: 0 }, quota: { limit: 20, usedToday: 0, remaining: 20 }, nextUpcomingAt: null };
    if (command === "registry_read") return { blocks: [], documents: [], recoveryMode: null };
    return null;
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onFocusChanged: async () => () => {}, onCloseRequested: async () => () => {}, destroy: async () => {} }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../src/engine/workerClient", () => ({ EngineClient: class { dead = true; dispose() {} } }));
vi.mock("../../src/index/externalSync", () => ({ ExternalSync: class { startTimers() {} stopTimers() {} focusPoke() {} quick() {} } }));
vi.mock("../../src/ui/NoteMarkdownView", () => ({ NoteMarkdownView: ({ text }: { text: string }) => createElement("div", { className: "test-preview", "data-length": text.length }, text.slice(0, 50)) }));
vi.mock("../../src/editor/EditorController", () => ({
  EditorController: class {
    input: HTMLTextAreaElement | null = null;
    constructor(private callbacks: EditorCallbacks) {}
    mount(element: HTMLElement) {
      this.input = document.createElement("textarea");
      this.input.className = "test-editor";
      this.input.addEventListener("input", () => { this.callbacks.onDocChanged(); this.cursor(); });
      element.append(this.input);
    }
    replaceDoc(text: string) { this.input!.value = text; this.cursor(); }
    cursor() { const text = this.getText(); this.callbacks.onCursor({ line: 1, col: 1, lines: text.split("\n").length, chars: text.length }); }
    getText() { return this.input?.value ?? ""; }
    getView() { return null; }
    focus() { this.input?.focus(); }
    isComposing() { return false; }
    destroy() { this.input?.remove(); }
  },
}));

import { M2App } from "../../src/ui/M2App";
import { INITIAL_GUIDE, ONBOARDING_KEY } from "../../src/ui/onboarding/state";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function read(text: string): ReadDocumentDto {
  return { text, rawByteHash: "hash", byteSize: text.length, hasBom: false, lineEnding: "LF", mtimeMs: 0, fileIdentity: null };
}

let root: Root;
let container: HTMLDivElement;
async function flush() { await act(async () => { await Promise.resolve(); }); }
async function clickFile(name: string) {
  const row = Array.from(container.querySelectorAll<HTMLElement>(".tree-row")).find((element) => element.title === name)!;
  expect(row).toBeTruthy();
  await act(async () => row.click());
}
async function clickButton(name: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => (element.getAttribute("aria-label") ?? element.textContent?.trim()) === name)!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}

beforeEach(async () => {
  localStorage.setItem(ONBOARDING_KEY, JSON.stringify({ ...INITIAL_GUIDE, introSeen: true }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.read.mockReset().mockImplementation(async (name: string) => read(`# ${name}\n\n正文`));
  host.draft.mockReset().mockResolvedValue({ exists: false, text: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(M2App)));
  await flush();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.removeItem(ONBOARDING_KEY);
  vi.unstubAllGlobals();
});

describe("知识库界面异步边界", () => {
  it("引导不改动已有正文，只能由用户在空白笔记中主动填入示例", async () => {
    await clickFile("A.md");
    const input = container.querySelector<HTMLTextAreaElement>(".test-editor")!;
    const original = input.value;
    await clickButton("新手引导");
    const lastPage = document.querySelector<HTMLButtonElement>('[aria-label="第 4 页：先回忆，再翻开答案。"]')!;
    await act(async () => lastPage.click());
    const start = Array.from(document.querySelectorAll<HTMLButtonElement>("dialog button")).find((button) => button.textContent?.startsWith("开始操作引导"))!;
    await act(async () => start.click());
    expect(input.value).toBe(original);
    expect(document.querySelector(".guide-coach")?.textContent).not.toContain("在空白笔记中填入示例");
    host.read.mockResolvedValue(read(""));
    await clickFile("B.md");
    const fill = Array.from(document.querySelectorAll<HTMLButtonElement>(".guide-coach button")).find((button) => button.textContent === "在空白笔记中填入示例")!;
    expect(fill).toBeTruthy();
    expect(input.value).toBe("");
    await act(async () => fill.click());
    expect(input.value).toContain("## 栈遵循什么出栈顺序？");
    expect(container.querySelector(".statusbar")?.textContent).toContain("未保存");
  });

  it("快速打开 A、B 后，较晚返回的 A 不覆盖 B", async () => {
    const oldRead = deferred<ReadDocumentDto>();
    host.read.mockImplementation((name: string) => name === "A.md" ? oldRead.promise : Promise.resolve(read("# B.md\n\nB 内容")));
    await clickFile("A.md");
    await clickFile("B.md");
    expect(container.querySelector(".file-path")?.textContent).toBe("B");
    await act(async () => oldRead.resolve(read("# A.md\n\nA 内容")));
    expect(container.querySelector(".file-path")?.textContent).toBe("B");
    expect(container.querySelector<HTMLTextAreaElement>(".test-editor")?.value).toContain("B 内容");
  });

  it("读取另一篇笔记期间继续输入，必须保留修改并显示切换守卫", async () => {
    await clickFile("A.md");
    const nextRead = deferred<ReadDocumentDto>();
    host.read.mockReturnValue(nextRead.promise);
    await clickFile("B.md");
    const input = container.querySelector<HTMLTextAreaElement>(".test-editor")!;
    await act(async () => { input.value += "\n未保存的新内容"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => nextRead.resolve(read("# B.md\n\nB 内容")));
    expect(input.value).toContain("未保存的新内容");
    expect(document.querySelector("dialog[open]")?.textContent).toContain("有未保存的修改");
  });

  it("可选的恢复草稿读取失败，不关闭已经打开的有效笔记", async () => {
    host.draft.mockRejectedValue({ code: "IO_ERROR", message: "恢复草稿不可读" });
    await clickFile("A.md");
    expect(container.querySelector(".file-path")?.textContent).toBe("A");
    expect(container.querySelector<HTMLTextAreaElement>(".test-editor")?.value).toContain("A.md");
  });

  it("阅读小文件后打开大文件，应回到可用的编辑视图", async () => {
    await clickFile("A.md");
    await clickButton("阅读预览");
    expect(container.querySelector(".test-preview")).not.toBeNull();
    host.read.mockResolvedValue(read("x".repeat(5_000_001)));
    await clickFile("Large.md");
    expect(container.querySelector(".test-preview")).toBeNull();
    const edit = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "编辑")!;
    expect(edit.disabled).toBe(false);
  });

  it("编辑器内 Ctrl+E 能切换阅读，搜索输入框内不会触发", async () => {
    await clickFile("A.md");
    const input = container.querySelector<HTMLTextAreaElement>(".test-editor")!;
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true })));
    expect(container.querySelector(".test-preview")).not.toBeNull();
    const search = container.querySelector<HTMLInputElement>('[aria-label="按文件名过滤（Ctrl+P）"]')!;
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true })));
    expect(container.querySelector(".test-preview")).not.toBeNull();
  });

  it("用户已切到统计页，文件读取完成不会强行跳回编辑页", async () => {
    const pending = deferred<ReadDocumentDto>();
    host.read.mockReturnValue(pending.promise);
    await clickFile("A.md");
    await clickButton("统计");
    await act(async () => pending.resolve(read("# A.md\n\n正文")));
    expect(container.querySelector(".stats-page")).not.toBeNull();
  });

  it("另一篇笔记读取失败时，保留当前文件和未保存内容", async () => {
    await clickFile("A.md");
    const pending = deferred<ReadDocumentDto>();
    host.read.mockReturnValue(pending.promise);
    await clickFile("B.md");
    const input = container.querySelector<HTMLTextAreaElement>(".test-editor")!;
    await act(async () => { input.value += "\n需要保留的文字"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => pending.reject({ code: "FILE_NOT_FOUND", message: "文件已被移动" }));
    expect(container.querySelector(".file-path")?.textContent).toBe("A");
    expect(input.value).toContain("需要保留的文字");
  });

  it("关闭知识库后忽略迟到的文件内容", async () => {
    const pending = deferred<ReadDocumentDto>();
    host.read.mockReturnValue(pending.promise);
    await clickFile("A.md");
    await clickButton("切换知识库");
    await act(async () => pending.resolve(read("# 旧知识库内容")));
    expect(container.querySelector(".start-screen")).not.toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>(".test-editor")?.value).toBe("");
  });
});
