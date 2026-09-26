// M6 设置页（§16 Settings）：Workspace 信息、时区、新内容日配额、
// 自动保存开关、外观主题（M9）、备份/恢复入口、诊断与版本。备份命令层 M4 已全量就绪。

import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { indexIpc } from "../index/ipc";
import type { HostErrorShape } from "../editor/ipc";
import { ALGORITHM_ID, ALGORITHM_VERSION, STATE_SCHEMA_VERSION } from "../review/scheduler";
import type { DbBackupEntryDto, FullBackupResultDto } from "../index/ipc";
import type { ReviewService } from "../review/service";
import { getThemePref, setThemePref, type ThemePref } from "./theme";
import { ParticipationManager } from "./ParticipationManager";
import { JevSettings } from "./JevSettings";
import { SpeechSettings } from "./SpeechSettings";
import { Icon, type IconName } from "./Icon";

const SETTINGS_SECTIONS: readonly { id: string; label: string; icon: IconName }[] = [
  { id: "appearance", label: "外观", icon: "sun" },
  { id: "workspace", label: "知识库", icon: "folder" },
  { id: "review", label: "学习偏好", icon: "review" },
  { id: "jev", label: "Jev 打分", icon: "spark" },
  { id: "speech", label: "语音输入", icon: "mic" },
  { id: "participation", label: "复习内容", icon: "list" },
  { id: "backup", label: "备份与恢复", icon: "shield" },
  { id: "guide", label: "新手引导", icon: "book" },
];

function tzDisplay(): string {
  const opts = Intl.DateTimeFormat().resolvedOptions();
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${opts.timeZone ?? "未知"} (UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")})`;
}

export function SettingsPage({
  service,
  workspaceRoot,
  onAutosaveChanged,
  onParticipationChanged,
  section = "general",
  onOpenGuide,
  onStartTour,
  onResumeTour,
}: {
  service: ReviewService;
  workspaceRoot: string;
  onAutosaveChanged: (enabled: boolean) => void;
  onParticipationChanged: () => void;
  section?: "general" | "participation" | "speech";
  onOpenGuide?: () => void;
  onStartTour?: () => void;
  onResumeTour?: () => void;
}) {
  const [dailyLimit, setDailyLimit] = useState<number | null>(null);
  const [savedLimit, setSavedLimit] = useState<number | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [autosave, setAutosave] = useState(true);
  const [themePref, setThemePrefState] = useState<ThemePref>(() => getThemePref());
  const [backups, setBackups] = useState<DbBackupEntryDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<HostErrorShape | null>(null);
  const managerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState(section === "general" ? "appearance" : section);

  useEffect(() => {
    setActiveSection(section === "general" ? "appearance" : section);
    if (section === "participation") {
      managerRef.current?.scrollIntoView({ block: "start" });
      managerRef.current?.focus({ preventScroll: true });
    } else if (section === "speech") {
      pageRef.current?.querySelector('[data-setting-section="speech"]')?.scrollIntoView({ block: "start" });
    } else {
      pageRef.current?.closest(".page-mount")?.scrollTo({ top: 0 });
    }
  }, [section]);

  const flash = useCallback((msg: string) => {
    setMessage(msg);
    setError(null);
    window.setTimeout(() => setMessage((cur) => (cur === msg ? null : cur)), 3200);
  }, []);

  useEffect(() => {
    service
      .appConfig()
      .then((c) => {
        setDailyLimit(c.dailyNewLimit);
        setSavedLimit(c.dailyNewLimit);
        setAutosave(c.autosave);
        setConfigLoaded(true);
      })
      .catch((e) => setError(e as HostErrorShape));
    indexIpc
      .backupDbList()
      .then(setBackups)
      .catch((e) => setError(e as HostErrorShape));
  }, [service]);

  const saveLimit = useCallback(async () => {
    if (dailyLimit == null || !Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 100) return;
    setBusy("limit");
    try {
      await service.setAppConfig("review.daily_new_limit", String(dailyLimit));
      setSavedLimit(dailyLimit);
      flash(`新内容日配额已设为 ${dailyLimit}`);
    } catch (e) {
      setError(e as HostErrorShape);
    } finally {
      setBusy(null);
    }
  }, [service, dailyLimit, flash]);

  const toggleAutosave = useCallback(async () => {
    const next = !autosave;
    setBusy("autosave");
    try {
      await service.setAppConfig("editor.autosave", next ? "1" : "0");
      setAutosave(next);
      onAutosaveChanged(next);
      flash(next ? "自动保存已开启" : "自动保存已关闭（Ctrl+S 手动保存仍可用）");
    } catch (e) {
      setError(e as HostErrorShape);
    } finally {
      setBusy(null);
    }
  }, [service, autosave, onAutosaveChanged, flash]);

  const backupNow = useCallback(async () => {
    setBusy("backup");
    try {
      const entry = await indexIpc.backupDbNow();
      flash(`已备份 ${entry.fileName}`);
      setBackups(await indexIpc.backupDbList());
    } catch (e) {
      setError(e as HostErrorShape);
    } finally {
      setBusy(null);
    }
  }, [flash]);

  const restoreBackup = useCallback(
    async (fileName: string) => {
      if (!window.confirm(`用 ${fileName} 恢复索引数据库？当前库会被隔离保全，恢复后建议重新打开知识库。`)) {
        return;
      }
      setBusy("restore");
      try {
        const r = await indexIpc.backupDbRestore(fileName);
        flash(`已从 ${r.restoredFrom} 恢复（${r.documentsPending} 个文档待重扫）`);
      } catch (e) {
        setError(e as HostErrorShape);
      } finally {
        setBusy(null);
      }
    },
    [flash],
  );

  const fullBackup = useCallback(async () => {
    const target = await openDialog({ directory: true, title: "选择完整备份目标目录" });
    if (!target) return;
    setBusy("full");
    try {
      const r: FullBackupResultDto = await indexIpc.backupFull(target);
      flash(`完整备份完成：${r.fileCount} 个文件 / ${(r.totalBytes / 1024).toFixed(0)} KB → ${r.backupDir}`);
    } catch (e) {
      setError(e as HostErrorShape);
    } finally {
      setBusy(null);
    }
  }, [flash]);

  const fullRestore = useCallback(async () => {
    const backupDir = await openDialog({ directory: true, title: "选择完整备份目录" });
    if (!backupDir) return;
    const target = await openDialog({ directory: true, title: "选择恢复目标目录（须为空）" });
    if (!target) return;
    setBusy("fullrestore");
    try {
      const r = await indexIpc.backupFullRestore(backupDir, target);
      flash(`已恢复 ${r.fileCount} 个文件到 ${r.targetRoot}（用「打开知识库」指向该目录）`);
    } catch (e) {
      setError(e as HostErrorShape);
    } finally {
      setBusy(null);
    }
  }, [flash]);

  // 外观（M9）：UI 层偏好，存 WebView localStorage，即改即生效（CSS 变量 + mermaid 重绘）
  const changeTheme = useCallback((pref: ThemePref) => {
    setThemePref(pref);
    setThemePrefState(pref);
  }, []);

  return (
    <div className="settings-page" ref={pageRef}>
      <header className="page-header">
        <div>
          <span className="eyebrow">属于你的工作空间</span>
          <h2>设置</h2>
          <p className="page-description">外观、学习节奏与数据管理。</p>
        </div>
      </header>
      {message && <div className="review-toast" role="status">{message}</div>}
      {error && <div className="review-error" role="alert">{error.message}</div>}

      <div className="settings-layout">
      <nav className="settings-navigation" aria-label="设置分类">
        {SETTINGS_SECTIONS.map((item) => <button type="button" key={item.id} className={activeSection === item.id ? "selected" : ""}
          aria-current={activeSection === item.id ? "location" : undefined} onClick={() => {
            setActiveSection(item.id);
            pageRef.current?.querySelector(`[data-setting-section="${item.id}"]`)?.scrollIntoView({ block: "start", behavior: "instant" });
          }}><Icon name={item.icon} size={16} />{item.label}</button>)}
      </nav>
      <div className="settings-content">
      <section className="stats-section" data-setting-section="appearance">
        <div className="section-heading"><h3><Icon name="sun" size={18} />外观</h3><span className="setting-behavior">立即生效</span></div>
        <p className="hint">选择适合此刻光线的界面。</p>
        <div className="settings-row theme-choices" role="radiogroup" aria-label="主题">
          {(
            [
              ["auto", "跟随系统"],
              ["light", "浅色"],
              ["dark", "深色"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="theme-option">
              <span className="theme-preview" data-theme={value} aria-hidden="true"><i /><span><b /><b /><b /><em /></span></span>
              <span className="theme-option-label">
              <span>{label}</span>
              <input
                type="radio"
                name="theme"
                value={value}
                checked={themePref === value}
                onChange={() => changeTheme(value)}
              />
              </span>
            </label>
          ))}
        </div>
        <p className="hint">跟随系统时随 Windows 深浅色设置自动切换；编辑器、预览（含图表与代码高亮）同步换肤。</p>
      </section>

      <section className="stats-section" data-setting-section="workspace">
        <h3><Icon name="folder" size={18} />知识库</h3>
        <dl className="settings-kv">
          <dt>知识库路径</dt>
          <dd>{workspaceRoot}</dd>
          <dt>时区（只影响显示与日配额分界）</dt>
          <dd>{tzDisplay()}</dd>
        </dl>
      </section>

      <section className="stats-section" data-setting-section="review">
        <h3><Icon name="review" size={18} />学习偏好</h3>
        <div className="settings-row">
          <label htmlFor="daily-limit">每天学习的新内容上限</label>
          <input
            id="daily-limit"
            type="number"
            min={0}
            max={100}
            step={1}
            disabled={!configLoaded || busy === "limit"}
            aria-describedby="daily-limit-help"
            value={dailyLimit ?? ""}
            onChange={(e) => setDailyLimit(e.target.value === "" ? null : Number(e.target.value))}
          />
          <button type="button" className="btn" disabled={!configLoaded || busy !== null || dailyLimit == null || !Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 100 || dailyLimit === savedLimit} onClick={() => void saveLimit()}>
            {busy === "limit" ? "保存中…" : "保存上限"}
          </button>
          {configLoaded && dailyLimit !== savedLimit && <span className="setting-unsaved" role="status">尚未保存</span>}
        </div>
        <p className="hint" id="daily-limit-help">填写 0–100 的整数，点击「保存上限」后生效。只限制每天首次评分的新内容。</p>
        <div className="settings-row">
          <label htmlFor="autosave">自动保存</label>
          <input
            id="autosave"
            type="checkbox"
            checked={autosave}
            disabled={!configLoaded || busy !== null}
            onChange={() => void toggleAutosave()}
          />
          <span className="setting-behavior">{busy === "autosave" ? "正在保存…" : "更改后立即生效"}</span>
        </div>
        <p className="hint">关闭后请使用 Ctrl+S 手动保存；恢复草稿仍会保留。</p>
      </section>

      <JevSettings />
      <SpeechSettings />

      <div ref={managerRef} tabIndex={-1} className="manager-anchor" data-setting-section="participation">
        <ParticipationManager service={service} onChanged={onParticipationChanged} />
      </div>

      <section className="stats-section" data-setting-section="backup">
        <h3><Icon name="shield" size={18} />备份与恢复</h3>
        <p className="hint">为笔记和学习记录留一份备份。</p>
        <div className="settings-row">
          <button type="button" className="btn primary" disabled={busy === "backup"} onClick={() => void backupNow()}>
            立即备份数据库
          </button>
          <button type="button" className="btn" disabled={busy === "full"} onClick={() => void fullBackup()}>
            完整备份（含正文）
          </button>
          <button type="button" className="btn" disabled={busy === "fullrestore"} onClick={() => void fullRestore()}>
            从完整备份恢复…
          </button>
        </div>
        {backups != null && backups.length > 0 && (
          <table className="settings-backups">
            <thead>
              <tr>
                <th>每日备份</th>
                <th>大小</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.fileName}>
                  <td>{b.fileName}</td>
                  <td>{(b.byteSize / 1024).toFixed(0)} KB</td>
                  <td>
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy === "restore"}
                      onClick={() => void restoreBackup(b.fileName)}
                    >
                      恢复
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {backups != null && backups.length === 0 && <p className="stats-empty">尚无每日备份（每天首次打开自动创建）。</p>}
      </section>

      <section className="stats-section" data-setting-section="guide">
        <div className="section-heading"><h3><Icon name="book" size={18} />新手引导</h3><span className="setting-behavior">随时重新开始</span></div>
        <p className="hint">用四页图解认识 RecallMD，或跟着真实界面走一遍记录、学习与复习。引导进度保存在当前设备。</p>
        <div className="settings-guide-actions">
          {onOpenGuide && <button type="button" className="btn" onClick={onOpenGuide}>查看概念图解</button>}
          {onStartTour && <button type="button" className="btn" onClick={onStartTour}>重新开始操作引导</button>}
          {onResumeTour && <button type="button" className="btn primary" onClick={onResumeTour}>继续上次引导</button>}
        </div>
      </section>
      <details className="stats-section technical-details">
        <summary>诊断与版本 · 技术详情</summary>
        <dl className="settings-kv">
          <dt>调度算法（冻结）</dt>
          <dd>
            {ALGORITHM_ID}@{ALGORITHM_VERSION}（状态 schema v{STATE_SCHEMA_VERSION}）
          </dd>
          <dt>参数</dt>
          <dd>request_retention 0.90 · maximum_interval 3650 天 · 短期学习 1m/10m · 重学 10m</dd>
        </dl>
      </details>
      </div>
      </div>
    </div>
  );
}
