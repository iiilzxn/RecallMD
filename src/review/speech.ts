import { ipcCall } from "../editor/ipc";

export type SpeechModelId = "paraformer-bilingual-fp32";
export const DEFAULT_SPEECH_MODEL: SpeechModelId = "paraformer-bilingual-fp32";
export interface SpeechPreferences { enabled: boolean; model: SpeechModelId; modelsRoot: string; device: string | null; maxSeconds: number }
export interface SpeechModel { id: SpeechModelId; label: string; ready: boolean; missing: string[]; sizeMib: number }
export interface SpeechConfig extends SpeechPreferences { models: SpeechModel[] }
export interface SpeechStatus { sessionId: string; phase: "starting" | "recording" | "transcribing"; seconds: number; level: number; stopped: boolean; device: string; error: string | null; warning?: string | null }
export interface SpeechTranscript { sessionId: string; model: SpeechModelId; text: string; audioSeconds: number; processingMs: number; preview?: boolean }
export const SPEECH_CONFIG_EVENT = "recallmd-speech-config";
export const speechIpc = {
  config: () => ipcCall<SpeechConfig>("speech_config_read", {}),
  save: async ({ enabled, model, modelsRoot, device, maxSeconds }: SpeechPreferences) => {
    const result = await ipcCall<SpeechConfig>("speech_config_save", { config: { enabled, model, modelsRoot, device, maxSeconds } });
    window.dispatchEvent(new CustomEvent(SPEECH_CONFIG_EVENT, { detail: result }));
    return result;
  },
  devices: () => ipcCall<string[]>("speech_devices", {}),
  start: (sessionId: string) => ipcCall<SpeechStatus>("speech_start", { sessionId }),
  status: (sessionId: string) => ipcCall<SpeechStatus>("speech_status", { sessionId }),
  stop: (sessionId: string) => ipcCall<SpeechTranscript>("speech_stop", { sessionId }),
  cancel: (sessionId: string) => ipcCall<void>("speech_cancel", { sessionId }),
};
export function appendTranscript(current: string, incoming: string): string {
  return [current.trimEnd(), incoming.trim()].filter(Boolean).join("\n");
}
