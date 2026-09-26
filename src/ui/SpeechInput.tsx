import { useCallback, useEffect, useRef, useState } from "react";
import type { HostErrorShape } from "../editor/ipc";
import { speechIpc, type SpeechConfig, type SpeechTranscript } from "../review/speech";
import { Icon } from "./Icon";
import "./speech.css";

type Phase = "idle" | "starting" | "recording" | "transcribing";
export function SpeechInput({ config, disabled = false, onTranscript, onBusyChange, onOpenSettings }: {
  config: SpeechConfig | null;
  disabled?: boolean;
  onTranscript: (result: SpeechTranscript) => void;
  onBusyChange?: (busy: boolean) => void;
  onOpenSettings?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const active = useRef<{ id: string; phase: Phase } | null>(null);
  const mounted = useRef(false);
  const callbacks = useRef({ onTranscript, onBusyChange });
  callbacks.current = { onTranscript, onBusyChange };
  const busy = phase !== "idle";
  const ready = !!config?.enabled && !!config.models.find((m) => m.id === config.model)?.ready;
  const reset = useCallback(() => { active.current = null; setPhase("idle"); setLevel(0); callbacks.current.onBusyChange?.(false); }, []);
  const cancel = useCallback(() => {
    const session = active.current;
    reset(); setError(null); setWarning(null); setMessage("已取消，已有文字保留。");
    if (session) void speechIpc.cancel(session.id).catch(() => { if (mounted.current && !active.current) setError("取消请求未送达，请检查应用状态；录音会在设置的时长上限后自动停止。"); });
  }, [reset]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const session = active.current; active.current = null;
      if (session) void speechIpc.cancel(session.id).catch(() => {});
      callbacks.current.onBusyChange?.(false);
    };
  }, []);
  const start = useCallback(async () => {
    if (active.current || disabled || !ready) return;
    const id = crypto.randomUUID(); active.current = { id, phase: "starting" };
    setPhase("starting"); setSeconds(0); setLevel(0); setError(null); setMessage(null); setWarning(null); callbacks.current.onBusyChange?.(true);
    try {
      const result = await speechIpc.start(id);
      if (!mounted.current || active.current?.id !== id) return;
      active.current.phase = "recording"; setPhase("recording"); setMessage(result.device ? `正在使用：${result.device}` : null);
    } catch (e) {
      if (!mounted.current || active.current?.id !== id) return;
      reset(); setError((e as HostErrorShape).message || "录音启动失败，请重试。");
      void speechIpc.cancel(id).catch(() => {});
    }
  }, [disabled, ready, reset]);
  const stop = useCallback(async () => {
    const session = active.current;
    if (!session || session.phase !== "recording") return;
    session.phase = "transcribing"; setPhase("transcribing"); setLevel(0); setError(null); setMessage(null);
    try {
      const result = await speechIpc.stop(session.id);
      if (!mounted.current || active.current?.id !== session.id) return;
      if (result.sessionId !== session.id) throw new Error("录音结果不匹配，请重新录制。");
      callbacks.current.onTranscript(result);
      reset(); setMessage(result.preview ? "浏览器演示文字，未使用真实麦克风。" : `已转写 ${result.audioSeconds.toFixed(1)} 秒录音 · 用时 ${(result.processingMs / 1000).toFixed(1)} 秒。请核对术语后再提交。`);
    } catch (e) {
      if (!mounted.current || active.current?.id !== session.id) return;
      reset(); setError((e as HostErrorShape).message || "本地转写失败，请重试或检查语音设置。");
      void speechIpc.cancel(session.id).catch(() => {});
    }
  }, [reset]);
  useEffect(() => {
    if (phase !== "recording") return;
    let pending = false;
    const poll = async () => {
      const session = active.current;
      if (pending || !session || session.phase !== "recording") return;
      pending = true;
      try {
        const status = await speechIpc.status(session.id);
        if (!mounted.current || active.current?.id !== session.id || active.current.phase !== "recording") return;
        setSeconds(status.seconds); setLevel(status.level); setWarning(status.warning ?? null);
        if (status.error) { cancel(); setError(status.error); }
        else if (status.stopped) void stop();
      } catch (e) {
        if (mounted.current && active.current?.id === session.id && active.current.phase === "recording") { cancel(); setError((e as HostErrorShape).message); }
      } finally { pending = false; }
    };
    const timer = window.setInterval(() => void poll(), 250);
    return () => window.clearInterval(timer);
  }, [phase, cancel, stop]);
  const shortcuts = useRef({ start, stop, disabled, ready }); shortcuts.current = { start, stop, disabled, ready };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "F2" || e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || document.querySelector("dialog[open]")) return;
      if (shortcuts.current.disabled || !shortcuts.current.ready) return;
      e.preventDefault(); e.stopPropagation();
      if (active.current?.phase === "recording") void shortcuts.current.stop(); else if (!active.current) void shortcuts.current.start();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  return <div className={`speech-input${busy ? " is-active" : ""}`} aria-label="本地语音输入">
    <div className="speech-input-controls">
      <span className="speech-model-name">{config ? "中英双语 · 本地转写" : "读取语音设置…"}</span>
      {phase === "recording" ? <button type="button" className="btn primary speech-recording" onClick={() => void stop()}><Icon name="stop" size={15} />结束并转写<kbd>F2</kbd></button>
        : <button type="button" className="btn" disabled={disabled || !ready || busy} onClick={() => void start()} aria-keyshortcuts="F2"><Icon name="mic" size={16} />{phase === "starting" ? "正在打开麦克风…" : phase === "transcribing" ? "正在本地转写…" : "语音回答"}{!busy && <kbd>F2</kbd>}</button>}
      {busy && <button type="button" className="text-button" onClick={cancel}>取消录音</button>}
      {!busy && onOpenSettings && <button type="button" className="text-button" onClick={onOpenSettings}>语音设置</button>}
    </div>
    {phase === "recording" && <div className="speech-recording-state" role="status"><i />录音中 <span>{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(Math.floor(seconds % 60)).padStart(2, "0")}</span><meter aria-label="麦克风输入音量" min={0} max={0.3} value={level} /><small>最长 {Math.floor((config?.maxSeconds ?? 600) / 60)} 分钟，结束后转写</small></div>}
    {!busy && !ready && config && <p className="hint">{!config.enabled ? "语音输入已关闭，可在语音设置中开启。" : "Paraformer 原版尚未就绪，请在语音设置中选择模型文件夹。"}</p>}
    {message && <p className="hint" role="status">{message}</p>}
    {warning && <p className="hint" role="status">{warning}</p>}
    {error && <p className="review-error" role="alert">{error}</p>}
  </div>;
}
