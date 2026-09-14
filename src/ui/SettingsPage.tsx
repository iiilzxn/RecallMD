// M6 设置页（§16 Settings）：Workspace 信息、时区、新内容日配额、
// 自动保存开关、备份/恢复入口、诊断与版本。备份命令层 M4 已全量就绪。

import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { indexIpc } from "../index/ipc";
import type { HostErrorShape } from "../editor/ipc";
import { ALGORITHM_ID, ALGORITHM_VERSION, STATE_SCHEMA_VERSION } from "../review/scheduler";
import type { DbBackupEntryDto, FullBackupResultDto } from "../index/ipc";
import type { ReviewService } from "../review/service";

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
}: {
  service: ReviewService;
  workspaceRoot: string;
  onAutosaveChanged: (enabled: boolean) => void;
}) {
  const [dailyLimit, setDailyLimit] = useState<number | null>(null);
  const [autosave, setAutosave] = useState(true);
  const [backups, setBackups] = useState<DbBackupEntryDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<HostErrorShape | null>(null);

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
        setAutosave(c.autosave);
      })
      .catch((e) => setError(e as HostErrorShape));
    indexIpc
      .backupDbList()
      .then(setBackups)
      .catch((e) => setError(e as HostErrorShape));
  }, [service]);

  const saveLimit = useCallback(async () => {
    if (dailyLimit == null) return;
    setBusy("limit");
    try {
      await service.setAppConfig("review.daily_new_limit", String(dailyLimit));
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

  return (
    <div className="settings-page">
      <header className="page-header">
        <h2>设置</h2>
      </header>
      {message && <div className="review-toast">{message}</div>}
      {error && <div className="review-error">{error.message}</div>}

      <section className="stats-section">
        <h3>知识库</h3>
        <dl className="settings-kv">
          <dt>Workspace 路径</dt>
          <dd>{workspaceRoot}</dd>
          <dt>时区（只影响显示与日配额分界）</dt>
          <dd>{tzDisplay()}</dd>
        </dl>
      </section>

      <section className="stats-section">
        <h3>复习</h3>
        <div className="settings-row">
          <label htmlFor="daily-limit">新内容日配额（0–100，每天最多首次评分的新块数）</label>
          <input
            id="daily-limit"
            type="number"
            min={0}
            max={100}
            value={dailyLimit ?? ""}
            onChange={(e) => setDailyLimit(e.target.value === "" ? null : Number(e.target.value))}
          />
          <button type="button" className="btn" disabled={busy === "limit" || dailyLimit == null} onClick={() => void saveLimit()}>
            保存
          </button>
        </div>
        <div className="settings-row">
          <label htmlFor="autosave">自动保存（关闭后仅 Ctrl+S 手动保存；草稿兜底不受影响）</label>
          <input
            id="autosave"
            type="checkbox"
            checked={autosave}
            disabled={busy === "autosave"}
            onChange={() => void toggleAutosave()}
          />
        </div>
      </section>

      <section className="stats-section">
        <h3>备份与恢复</h3>
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

      <section className="stats-section">
        <h3>诊断与版本</h3>
        <dl className="settings-kv">
          <dt>调度算法（冻结）</dt>
          <dd>
            {ALGORITHM_ID}@{ALGORITHM_VERSION}（状态 schema v{STATE_SCHEMA_VERSION}）
          </dd>
          <dt>参数</dt>
          <dd>request_retention 0.90 · maximum_interval 3650 天 · 短期学习 1m/10m · 重学 10m</dd>
        </dl>
      </section>
    </div>
  );
}
