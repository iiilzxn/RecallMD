import { useCallback, useEffect, useState } from "react";
import { SPEECH_CONFIG_EVENT, speechIpc, type SpeechConfig, type SpeechPreferences } from "../review/speech";
import type { HostErrorShape } from "../editor/ipc";

export function useSpeechConfig() {
  const [config, setConfig] = useState<SpeechConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try {
      const value = await speechIpc.config();
      if (value) { setConfig(value); setError(null); }
      else setError("未读取到语音设置，请重新加载。");
    } catch (e) { setError((e as HostErrorShape).message); }
  }, []);
  useEffect(() => {
    let disposed = false;
    void speechIpc.config().then((value) => { if (!disposed && value) setConfig(value); }).catch((e: HostErrorShape) => { if (!disposed) setError(e.message); });
    const changed = (event: Event) => { setConfig((event as CustomEvent<SpeechConfig>).detail); setError(null); };
    window.addEventListener(SPEECH_CONFIG_EVENT, changed);
    return () => { disposed = true; window.removeEventListener(SPEECH_CONFIG_EVENT, changed); };
  }, []);
  const save = useCallback(async (next: SpeechPreferences) => {
    setSaving(true); setError(null);
    try { const value = await speechIpc.save(next); setConfig(value); return value; }
    catch (e) { setError((e as HostErrorShape).message); return null; }
    finally { setSaving(false); }
  }, []);
  return { config, error, saving, load, save };
}
