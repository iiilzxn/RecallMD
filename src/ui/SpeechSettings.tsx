import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { DEFAULT_SPEECH_MODEL, speechIpc, type SpeechTranscript } from "../review/speech";
import { useSpeechConfig } from "./useSpeechConfig";
import { SpeechInput } from "./SpeechInput";
import { Icon } from "./Icon";

export function SpeechSettings() {
  const { config, error, saving, load, save } = useSpeechConfig();
  const [devices, setDevices] = useState<string[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [trial, setTrial] = useState(false);
  const [history, setHistory] = useState<SpeechTranscript[]>([]);
  const [folderError, setFolderError] = useState<string | null>(null);
  async function refreshDevices() { try { setDevices(await speechIpc.devices() ?? []); setDeviceError(null); } catch { setDeviceError("未能读取麦克风列表，可重试或使用系统默认设备。"); } }
  useEffect(() => { void refreshDevices(); }, []);
  async function chooseFolder() {
    try {
      const path = await open({ directory: true, multiple: false, title: "选择语音模型文件夹" });
      if (typeof path === "string" && config) { await save({ ...config, modelsRoot: path }); setFolderError(null); }
    } catch { setFolderError("未能选择模型文件夹，请重试。"); }
  }
  const locked = saving || recording;
  const model = config?.models.find((item) => item.id === DEFAULT_SPEECH_MODEL);
  return <section className="stats-section speech-settings" data-setting-section="speech">
    <div className="section-heading"><h3><Icon name="mic" size={18} />本地语音输入</h3><span className="service-status ready">离线 · 无需 Key</span></div>
    <p className="hint">录下回答，结束后在本机转成文字。使用 Paraformer 中英双语原版；声音只在本机内存中处理，不保存录音文件。Jev 评分另需联网。</p>
    <div className="settings-row"><label htmlFor="speech-enabled">开启语音输入</label><input id="speech-enabled" type="checkbox" checked={config?.enabled ?? false} disabled={!config || locked} onChange={() => config && void save({ ...config, enabled: !config.enabled })} /><span className="setting-behavior">适用于此设备上的所有知识库</span></div>
    <div className="speech-model-card" aria-label="语音识别模型">
      <div><strong>Paraformer 中英双语</strong><span className="speech-model-badge">FP32 原版</span></div>
      <p>支持中文、英文及中英混合口述，在本机离线转写。</p>
      <span>{model ? `文件约 ${model.sizeMib} MiB · ${model.ready ? "已就绪" : "文件缺失或版本不匹配"}` : "正在检查模型…"}</span>
      {model && !model.ready && <small>需要：{model.missing.join("、")}</small>}
    </div>
    <div className="speech-folder"><span>模型文件夹</span><code>{config?.modelsRoot ?? "读取中…"}</code><div><button type="button" className="btn small" disabled={!config || locked} onClick={() => void chooseFolder()}><Icon name="folder" size={14} />选择文件夹</button><button type="button" className="text-button" disabled={locked} onClick={() => void load()}>重新检查</button></div></div>
    <div className="settings-row speech-device-row"><label htmlFor="speech-device">麦克风</label><select id="speech-device" value={config?.device ?? ""} disabled={!config || locked} onChange={(e) => config && void save({ ...config, device: e.target.value || null })}><option value="">系统默认麦克风</option>{devices.map((device, index) => <option key={`${device}-${index}`} value={device}>{device}</option>)}{config?.device && !devices.includes(config.device) && <option value={config.device}>{config.device}（未连接）</option>}</select><button type="button" className="text-button" disabled={locked} onClick={() => void refreshDevices()}>刷新设备</button></div>
    <div className="settings-row speech-device-row"><label htmlFor="speech-limit">单次录音上限</label><select id="speech-limit" value={config?.maxSeconds ?? 600} disabled={!config || locked} onChange={(e) => config && void save({ ...config, maxSeconds: Number(e.target.value) })}><option value={180}>3 分钟</option><option value={600}>10 分钟</option><option value={1800}>30 分钟</option></select><span className="setting-behavior">更改后用于下一次录音</span></div>
    <p className="hint">上限用于防止意外长时间录音，与模型能力无关。到时自动结束并转写，不会自动提交答案。</p>
    {deviceError && <p className="hint">{deviceError}</p>}
    {(error || folderError) && <p className="review-error" role="alert">{error || folderError}</p>}
    <div className="speech-trial"><button type="button" className="text-button guide-entry" aria-expanded={trial} onClick={() => setTrial((value) => !value)}><Icon name="mic" size={16} />{trial ? "收起试录区" : "试录一段"}</button>
      {trial && <><p className="hint">录一段话，检查麦克风和转写效果。试录文字仅保留在本页，不写入笔记，也不影响复习安排。</p><SpeechInput config={config} disabled={saving} onBusyChange={setRecording} onTranscript={(result) => setHistory((items) => [result, ...items].slice(0, 8))} />
      <div className="speech-history">{history.map((result) => <article key={result.sessionId}><div><strong>{config?.models.find((model) => model.id === result.model)?.label ?? result.model}</strong><span>{result.audioSeconds.toFixed(1)} 秒录音 · {(result.processingMs / 1000).toFixed(1)} 秒转写{result.preview ? " · 演示" : ""}</span></div><p>{result.text}</p></article>)}</div>
      {history.length > 0 && <button type="button" className="text-button" disabled={recording} onClick={() => setHistory([])}>清空试录文字</button>}</>}
    </div>
  </section>;
}
