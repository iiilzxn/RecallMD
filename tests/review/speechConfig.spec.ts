// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { ipcCall } from "../../src/editor/ipc";
import { SPEECH_CONFIG_EVENT, speechIpc, type SpeechConfig } from "../../src/review/speech";

vi.mock("../../src/editor/ipc", () => ({ ipcCall: vi.fn() }));

it("保存录音上限时将数值传给原生端，并与其他设置一起同步", async () => {
  const config: SpeechConfig = { enabled: true, model: "paraformer-bilingual-fp32", modelsRoot: "D:/Models", device: "麦克风", maxSeconds: 1800, models: [] };
  vi.mocked(ipcCall).mockResolvedValue(config);
  const listener = vi.fn(); window.addEventListener(SPEECH_CONFIG_EVENT, listener);
  try {
    expect(await speechIpc.save(config)).toEqual(config);
    expect(ipcCall).toHaveBeenCalledExactlyOnceWith("speech_config_save", { config: { enabled: true, model: "paraformer-bilingual-fp32", modelsRoot: "D:/Models", device: "麦克风", maxSeconds: 1800 } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail.maxSeconds).toBe(1800);
  } finally { window.removeEventListener(SPEECH_CONFIG_EVENT, listener); }
});
