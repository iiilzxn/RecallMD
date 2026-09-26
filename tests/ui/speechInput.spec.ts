// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechInput } from "../../src/ui/SpeechInput";
import { appendTranscript, type SpeechConfig, type SpeechTranscript } from "../../src/review/speech";

const host = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), status: vi.fn() }));
vi.mock("../../src/review/speech", async (original) => ({ ...await original<typeof import("../../src/review/speech")>(), speechIpc: host }));
const config: SpeechConfig = { enabled: true, model: "paraformer-bilingual-fp32", modelsRoot: "D:/Models", device: null, maxSeconds: 180,
  models: [{ id: "paraformer-bilingual-fp32", label: "双语模型", ready: true, missing: [], sizeMib: 825 }] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function result(sessionId: string): SpeechTranscript { return { sessionId, model: "paraformer-bilingual-fp32", text: "后进先出", audioSeconds: 3, processingMs: 500 }; }
let root: Root, container: HTMLDivElement;
let onTranscript: ReturnType<typeof vi.fn<(result: SpeechTranscript) => void>>;
let onBusy: ReturnType<typeof vi.fn<(busy: boolean) => void>>;
async function click(text: string) { const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.startsWith(text))!; expect(button).toBeTruthy(); await act(async () => button.click()); }
async function render(key = "question-one") { await act(async () => root.render(createElement(SpeechInput, { key, config, onTranscript, onBusyChange: onBusy }))); }
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.start.mockReset().mockImplementation(async (sessionId) => ({ sessionId, device: "测试麦克风" }));
  host.stop.mockReset().mockImplementation(async (sessionId) => result(sessionId));
  host.cancel.mockReset().mockResolvedValue(undefined);
  host.status.mockReset().mockImplementation(async (sessionId) => ({ sessionId, seconds: 1, level: 0.1, stopped: false, error: null }));
  onTranscript = vi.fn(); onBusy = vi.fn();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); await render();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("本地语音输入异步边界", () => {
  it("可恢复的丢帧提醒不会取消录音，仍允许用户正常结束转写", async () => {
    vi.useFakeTimers();
    host.status.mockImplementation(async (sessionId) => ({ sessionId, seconds: 1, level: .1, stopped: false, error: null, warning: "录音中出现过短暂丢帧，仍在继续" }));
    await click("语音回答");
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(container.textContent).toContain("仍在继续");
    expect(host.cancel).not.toHaveBeenCalled(); expect(host.stop).not.toHaveBeenCalled();
    expect(onBusy).toHaveBeenLastCalledWith(true);
    await click("结束并转写"); expect(onTranscript).toHaveBeenCalledTimes(1);
  });
  it("真正的设备错误会取消录音，并保留具体原因", async () => {
    vi.useFakeTimers();
    host.status.mockImplementation(async (sessionId) => ({ sessionId, seconds: 1, level: 0, stopped: true, error: "系统拒绝访问麦克风（PermissionDenied）" }));
    await click("语音回答");
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(host.cancel).toHaveBeenCalledTimes(1); expect(host.stop).not.toHaveBeenCalled();
    expect(container.textContent).toContain("PermissionDenied");
    expect(onBusy).toHaveBeenLastCalledWith(false);
  });
  it("显示配置的录音时长，到达上限只转写一次", async () => {
    vi.useFakeTimers();
    await act(async () => root.render(createElement(SpeechInput, { key: "long", config: { ...config, maxSeconds: 1800 }, onTranscript, onBusyChange: onBusy })));
    host.status.mockImplementation(async (sessionId) => ({ sessionId, seconds: 1800, level: 0, stopped: true, error: null }));
    await click("语音回答"); expect(container.textContent).toContain("最长 30 分钟");
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(host.stop).toHaveBeenCalledTimes(1); expect(onTranscript).toHaveBeenCalledTimes(1);
  });
  it("正常结束只追加一次结果，固定使用中英双语模型", async () => {
    await click("语音回答");
    const id = host.start.mock.calls[0][0];
    expect(container.querySelector("select")).toBeNull();
    expect(onBusy).toHaveBeenLastCalledWith(true);
    await click("结束并转写");
    expect(host.stop).toHaveBeenCalledWith(id);
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith(result(id));
    expect(onBusy).toHaveBeenLastCalledWith(false);
    expect(container.textContent).toContain("中英双语 · 本地转写");
    expect(appendTranscript("我原来的文字", " 后进先出 ")).toBe("我原来的文字\n后进先出");
  });
  it("启动未完成就取消，迟到的启动响应不能重新进入录音", async () => {
    const pending = deferred<unknown>(); host.start.mockReturnValue(pending.promise);
    await click("语音回答"); const id = host.start.mock.calls[0][0];
    await click("取消录音");
    expect(host.cancel).toHaveBeenCalledWith(id);
    await act(async () => pending.resolve({ sessionId: id, device: "旧设备" }));
    expect(container.textContent).not.toContain("结束并转写");
    expect(onTranscript).not.toHaveBeenCalled();
  });
  it("上一段转写被取消后，迟到的结果不影响下一段录音", async () => {
    const old = deferred<SpeechTranscript>(); host.stop.mockReturnValueOnce(old.promise);
    await click("语音回答"); const oldId = host.start.mock.calls[0][0];
    await click("结束并转写"); await click("取消录音"); await click("语音回答");
    const nextId = host.start.mock.calls[1][0]; expect(nextId).not.toBe(oldId);
    await act(async () => old.resolve(result(oldId)));
    expect(onTranscript).not.toHaveBeenCalled();
    expect(container.textContent).toContain("结束并转写");
    await click("结束并转写"); expect(onTranscript).toHaveBeenCalledExactlyOnceWith(result(nextId));
  });
  it("切换题目会取消原会话，原题结果不回填到新题", async () => {
    const pending = deferred<SpeechTranscript>(); host.stop.mockReturnValueOnce(pending.promise);
    await click("语音回答"); const id = host.start.mock.calls[0][0]; await click("结束并转写");
    await render("question-two"); expect(host.cancel).toHaveBeenCalledWith(id);
    await act(async () => pending.resolve(result(id)));
    expect(onTranscript).not.toHaveBeenCalled();
    expect(container.textContent).toContain("语音回答");
  });
  it("录音启动失败后可以重试，不清除已经输入的答案", async () => {
    host.start.mockRejectedValueOnce({ code: "SPEECH_DEVICE", message: "麦克风权限未开启" });
    await click("语音回答"); expect(container.textContent).toContain("麦克风权限未开启");
    expect(onTranscript).not.toHaveBeenCalled(); expect(onBusy).toHaveBeenLastCalledWith(false);
    await click("语音回答"); expect(container.textContent).toContain("结束并转写");
  });
  it("双击开始只启动一次，F2 的重复和输入法事件不结束录音", async () => {
    const pending = deferred<unknown>(); host.start.mockReturnValueOnce(pending.promise);
    const start = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.startsWith("语音回答"))!;
    await act(async () => { start.click(); start.click(); }); expect(host.start).toHaveBeenCalledTimes(1);
    const id = host.start.mock.calls[0][0]; await act(async () => pending.resolve({ sessionId: id, device: "麦克风" }));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", repeat: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", isComposing: true }));
    }); expect(host.stop).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "F2" })));
    expect(host.stop).toHaveBeenCalledTimes(1);
  });
});
