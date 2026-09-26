import { useEffect, useState } from "react";
import type { HostErrorShape } from "../editor/ipc";
import { jevIpc, type JevConfig } from "../review/jev";
import { Icon } from "./Icon";

export function JevSettings() {
  const [config, setConfig] = useState<JevConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setError(null);
    try { setConfig(await jevIpc.config()); }
    catch (e) { setError((e as HostErrorShape).message); }
  }
  useEffect(() => { void load(); }, []);

  async function update(action: "toggle" | "save" | "clear") {
    if (!config || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = action === "clear" ? await jevIpc.clearKey()
        : await jevIpc.saveConfig(action === "toggle" ? !config.enabled : config.enabled, action === "save" ? apiKey.trim() : null);
      setConfig(next);
      setApiKey("");
      setMessage(action === "clear" ? "API Key 已删除，Jev 打分已关闭。" : action === "save" ? "API Key 已保存。" : next.enabled ? "Jev 打分已开启。" : "Jev 打分已关闭。");
    } catch (e) { setError((e as HostErrorShape).message); }
    finally { setBusy(false); }
  }

  return <section className="stats-section jev-settings" data-setting-section="jev">
    <div className="section-heading"><h3><Icon name="spark" size={18} />Jev 智能打分</h3>
      <span className={`service-status${config?.enabled && config.hasApiKey ? " ready" : ""}`}>{!config ? "读取中" : !config.enabled ? "未开启" : config.hasApiKey ? "已配置" : "待填写 Key"}</span>
    </div>
    <p className="hint">在笔记预览的小节标题旁点击「＋」添加得分点，复习时提交答案，逐点评分并汇总为百分制。</p>
    <div className="settings-row">
      <label htmlFor="jev-enabled">开启 Jev 打分</label>
      <input id="jev-enabled" type="checkbox" checked={config?.enabled ?? false} disabled={!config || busy} onChange={() => void update("toggle")} />
      <span className="setting-behavior">{busy ? "正在保存…" : "适用于此设备上的所有知识库"}</span>
    </div>
    {config?.enabled && <div className="jev-key-form">
      <label htmlFor="jev-api-key">TypeSafe API Key</label>
      <div className="settings-row">
        <input id="jev-api-key" className="text-input" type="password" autoComplete="off" spellCheck={false}
          value={apiKey} maxLength={2048} disabled={busy} placeholder={config.hasApiKey ? "已保存；输入新 Key 可替换" : "粘贴 TypeSafe 官方 API Key"}
          onChange={(e) => setApiKey(e.target.value)} />
        <button className="btn primary" disabled={busy || !apiKey.trim()} onClick={() => void update("save")}>保存 API Key</button>
      </div>
      <p className="hint">{config.hasApiKey ? "已保存密钥。" : "保存 API Key 后即可使用。"}密钥保存在 Windows 凭据管理器中，不随笔记备份。</p>
      <p className="hint">点击提交评分时，会将本题题目、得分点和你的答案发送到 TypeSafe。需要已开通 Jev 访问权限的官方 Key，调用按 TypeSafe 账户计费。</p>
    </div>}
    {config?.hasApiKey && <button type="button" className="text-button danger" disabled={busy} onClick={() => void update("clear")}>删除已保存的 API Key</button>}
    {message && <p className="hint" role="status">{message}</p>}
    {error && <p className="review-error" role="alert">{error} {!config && <button className="btn small" onClick={() => void load()}>重新加载</button>}</p>}
  </section>;
}
