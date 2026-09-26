import type { HostErrorShape } from "../editor/ipc";
import { JEV_CONFIDENCE_THRESHOLD, pointVerdict, type JevGrade } from "../review/jev";

export function JevFeedback({ answer, grading, result, error, onRetry, retryDisabled }: {
  answer: string;
  grading: boolean;
  result: JevGrade | null;
  error: HostErrorShape | null;
  onRetry: () => void;
  retryDisabled: boolean;
}) {
  const uncertainCount = result?.points.filter((point) => point.confidence < JEV_CONFIDENCE_THRESHOLD).length ?? 0;
  return <section className="jev-feedback" aria-label="Jev 评分结果" aria-busy={grading}>
    <div className="jev-section-heading"><h3>Jev 回忆评分</h3>
      {result && (uncertainCount > 0
        ? <span className="jev-total jev-total-uncertain">待核对</span>
        : <span className="jev-total">{Math.round(result.score)}<small> / 100</small></span>)}
    </div>
    <details className="jev-answer-snapshot"><summary>查看揭示前提交的答案</summary><p>{answer}</p></details>
    {grading && <p role="status" className="hint">正在按关键得分点批改…可以继续核对原文，也可以手动选择复习评级。</p>}
    {error && <div className="review-error" role="alert"><span>{error.message}</span>
      <button type="button" className="btn small" disabled={retryDisabled || grading} onClick={onRetry}>用原答案重试</button>
    </div>}
    {result && <>
      {result.preview && <p className="hint">浏览器预览：以下为固定示例分数，未调用 Jev。</p>}
      {uncertainCount > 0 && <p className="jev-uncertainty-note" role="status">有 {uncertainCount} 个得分点判断不确定，暂不显示总分。请对照原文核对这些点，再选择复习评级。</p>}
      <ol className="jev-point-results">{result.points.map((point, i) => <li key={i}>
        <p>{point.point}</p>
        <div className="jev-point-detail"><strong>{point.confidence < JEV_CONFIDENCE_THRESHOLD ? "待核对" : `${point.score.toFixed(1)} / 2`}</strong><span>{pointVerdict(point)}</span><span className="hint">置信度 {Math.round(point.confidence * 100)}%</span></div>
      </li>)}</ol>
      <p className="hint">各点满分 2 分，总分按等权换算。置信度表示模型判断的确定程度；分数供核对参考，请结合是否借助提示、回忆是否费力选择下方评级。</p>
    </>}
  </section>;
}
