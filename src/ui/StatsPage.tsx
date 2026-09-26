// 统计仅展示真实复习次数和自评分布，不推断记忆率。
// 空态：无历史时提示完成首次复习。

import { useCallback, useEffect, useState } from "react";
import type { HostErrorShape } from "../editor/ipc";
import type { ReviewStatsResultDto } from "../review/ipc";
import type { ReviewService } from "../review/service";
import { Icon, type IconName } from "./Icon";

const RATING_NAMES = ["Again", "Hard", "Good", "Easy"] as const;
const RATING_LABELS = ["再学一次", "有些费力", "正常回忆", "轻松回忆"] as const;

function Stat({ label, value, note, icon, featured = false }: { label: string; value: number | string; note?: string; icon?: IconName; featured?: boolean }) {
  return (
    <div className={`stat-cell${featured ? " featured" : ""}`}>
      {icon && <span className="stat-icon"><Icon name={icon} size={19} /></span>}
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}

export function StatsPage({ service }: { service: ReviewService }) {
  const [stats, setStats] = useState<ReviewStatsResultDto | null>(null);
  const [error, setError] = useState<HostErrorShape | null>(null);
  const [period, setPeriod] = useState<"today" | "week" | "month">("week");

  const refresh = useCallback(() => {
    service
      .stats()
      .then((s) => {
        setStats(s);
        setError(null);
      })
      .catch((e) => setError(e as HostErrorShape));
  }, [service]);

  useEffect(refresh, [refresh]);
  const distribution = stats ? (period === "today" ? stats.ratingsToday : period === "week" ? stats.ratings7d : stats.ratings30d) : [0, 0, 0, 0];
  const distributionTotal = distribution.reduce((sum, value) => sum + value, 0);

  return (
    <div className="stats-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">学习足迹</span>
          <h2>每一次回忆，都算数。</h2>
          <p className="page-description">回看练习的积累，找到适合自己的学习节奏。</p>
        </div>
        <button type="button" className="btn" onClick={refresh}>
          <Icon name="refresh" size={15} />刷新数据
        </button>
      </header>
      {error && <div className="review-error">{error.message}</div>}
      {!stats && !error && <p>读取中…</p>}
      {stats && (
        <>
          {stats.rated30d === 0 ? (
            <p className="stats-empty">还没有评分记录——完成第一次复习后这里会出现统计。</p>
          ) : (
            <>
              <section className="stats-overview" aria-label="复习次数概览">
                <div className="stats-grid overview-grid">
                  <Stat label="今日已复习" value={stats.ratedToday} note="次复习记录" icon="check" featured />
                  <Stat label="最近 7 天" value={stats.rated7d} note="次复习记录" icon="clock" />
                  <Stat label="最近 30 天" value={stats.rated30d} note="次复习记录" icon="stats" />
                  <Stat label="近 7 天覆盖" value={stats.distinctBlocks7d} note="个不同的知识小节" icon="book" />
                </div>
              </section>
              <section className="stats-section rating-distribution">
                <div className="section-heading">
                  <div><h3>回忆的状态</h3><p className="hint">你在每次复习后选择的评级。</p></div>
                  <div className="segmented-control" role="group" aria-label="统计周期">
                    {([["today", "今天"], ["week", "近 7 天"], ["month", "近 30 天"]] as const).map(([value, label]) =>
                      <button type="button" key={value} className={period === value ? "selected" : ""} aria-pressed={period === value} onClick={() => setPeriod(value)}>{label}</button>)}
                  </div>
                </div>
                <div className="distribution-total"><strong>{distributionTotal}</strong><span>次复习</span></div>
                <div className="distribution-track" aria-hidden="true">
                  {distribution.map((count, i) => count > 0 && <span key={RATING_NAMES[i]} className={RATING_NAMES[i].toLowerCase()} style={{ flexGrow: count }} />)}
                </div>
                <div className="distribution-legend">
                  {RATING_NAMES.map((name, i) => <div key={name} className={`distribution-item ${name.toLowerCase()}`}>
                    <span className="distribution-dot" /><span>{RATING_LABELS[i]}<small>{name}</small></span><strong>{distribution[i]}<small> 次</small></strong>
                  </div>)}
                </div>
                {distributionTotal === 0 && <p className="hint">这个时间段还没有复习记录。</p>}
                <details className="stats-breakdown"><summary>查看各周期明细</summary>
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th>档位</th>
                      <th>今天</th>
                      <th>最近 7 天</th>
                      <th>最近 30 天</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RATING_NAMES.map((name, i) => (
                      <tr key={name}>
                        <th>{name}</th>
                        <td>{stats.ratingsToday[i]}</td>
                        <td>{stats.ratings7d[i]}</td>
                        <td>{stats.ratings30d[i]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </details>
                <p className="hint stats-data-note">这里展示自评次数，不代表记忆率。</p>
              </section>
            </>
          )}
          <section className="stats-section library-overview">
            <div className="section-heading"><h3>知识库概览</h3><span className="subtle-label">当前状态</span></div>
            <div className="stats-grid library-grid">
              <Stat label="已到期" value={stats.due.learning + stats.due.review + stats.due.newTotal} />
              <Stat label="参与复习" value={stats.enabled} />
              <Stat label="已暂停" value={stats.paused} />
              <Stat label="已排除" value={stats.excluded} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
