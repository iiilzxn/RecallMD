// M6 简版统计（§16 Statistics）：原始分布，不做记忆率推断或图表。
// 空态：无历史时提示完成首次复习。

import { useCallback, useEffect, useState } from "react";
import type { HostErrorShape } from "../editor/ipc";
import type { ReviewStatsResultDto } from "../review/ipc";
import type { ReviewService } from "../review/service";

const RATING_NAMES = ["Again", "Hard", "Good", "Easy"] as const;

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat-cell">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function StatsPage({ service }: { service: ReviewService }) {
  const [stats, setStats] = useState<ReviewStatsResultDto | null>(null);
  const [error, setError] = useState<HostErrorShape | null>(null);

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

  return (
    <div className="stats-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">学习足迹</span>
          <h2>统计</h2>
          <p className="page-description">回顾每一次练习，了解当前的复习状态。</p>
        </div>
        <button type="button" className="btn" onClick={refresh}>
          刷新
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
              <section className="stats-section">
                <h3>评分次数（仅记录评分动作）</h3>
                <div className="stats-grid">
                  <Stat label="今天" value={stats.ratedToday} />
                  <Stat label="最近 7 天" value={stats.rated7d} />
                  <Stat label="最近 30 天" value={stats.rated30d} />
                  <Stat label="7 天内复习过的不同块" value={stats.distinctBlocks7d} />
                </div>
              </section>
              <section className="stats-section">
                <h3>四档自评分布（原始次数，不代表记忆率）</h3>
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
              </section>
            </>
          )}
          <section className="stats-section">
            <h3>当前状态</h3>
            <div className="stats-grid">
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
