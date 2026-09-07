// M0 验证：ts-fsrs 调度结果与序列化
import { useMemo, useState } from "react";
import { runFsrsSample } from "./fsrs-sample";

export function FsrsPanel() {
  const [report, setReport] = useState<ReturnType<typeof runFsrsSample> | null>(null);
  const [ms, setMs] = useState<number | null>(null);

  const run = useMemo(
    () => () => {
      const t0 = performance.now();
      const r = runFsrsSample();
      setMs(Math.round((performance.now() - t0) * 100) / 100);
      setReport(r);
    },
    [],
  );

  return (
    <section className="panel">
      <h2>③ ts-fsrs 四 Rating 与序列化往返</h2>
      <div className="actions">
        <button onClick={run}>运行样例</button>
      </div>
      <p className="hint">
        参数按设计 §11.2：retention 0.9 · max interval 3650d · fuzz off · short-term on · learning 1m/10m · relearning 10m
      </p>
      {report && (
        <div className="report">
          <p className="stat">
            库版本 {report.fsrsVersion} · 耗时 {ms} ms
          </p>
          <table>
            <thead>
              <tr>
                <th>Rating</th>
                <th>→ 阶段</th>
                <th>间隔</th>
                <th>S</th>
                <th>D</th>
                <th>repeat≡next</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.grade}>
                  <td>{r.grade}</td>
                  <td>{r.state}</td>
                  <td>
                    {r.dueInMin < 1440 ? `${r.dueInMin} 分钟` : `${(r.dueInMin / 1440).toFixed(1)} 天`}
                  </td>
                  <td>{r.stability.toFixed(2)}</td>
                  <td>{r.difficulty.toFixed(2)}</td>
                  <td className={r.previewMatchesNext ? "ok" : "bad"}>
                    {r.previewMatchesNext ? "一致" : "不一致"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={report.roundtripOk ? "ok" : "bad"}>
            JSON 往返（Date 显式复原）：{report.roundtripOk ? "通过" : "失败"} — {report.roundtripDetail}
          </p>
        </div>
      )}
    </section>
  );
}
