// M0 验证：Worker 解析 mdast 并按标题切段
import { useEffect, useRef, useState } from "react";
import AstWorker from "./ast.worker?worker";
import { buildLargeDocument, buildSampleMarkdown } from "./content";
import type { AstReport } from "./ast.worker";

export function AstPanel() {
  const workerRef = useRef<Worker | null>(null);
  const nonceRef = useRef(0);
  const pendingRef = useRef<Map<number, (r: AstReport) => void>>(new Map());
  const [report, setReport] = useState<AstReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const worker = new AstWorker();
    worker.onmessage = (e: MessageEvent<AstReport>) => {
      const resolve = pendingRef.current.get(e.data.nonce);
      pendingRef.current.delete(e.data.nonce);
      resolve?.(e.data);
    };
    // Worker 脚本加载/运行失败必须可见，否则按钮永久停留在 busy
    worker.onerror = (e) => {
      const detail = JSON.stringify(
        {
          message: e.message || null,
          file: e.filename ? e.filename.split("/").pop() : null,
          line: e.lineno ?? null,
          error: e.error?.message ?? null,
        },
      );
      setError(`Worker 加载/运行失败：${detail || "无详细信息"}`);
      console.error("[AstPanel] worker error event:", e);
      pendingRef.current.clear();
      setBusy(false);
    };
    worker.onmessageerror = () => {
      setError("Worker 消息序列化失败（structured clone）");
      pendingRef.current.clear();
      setBusy(false);
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const run = (text: string) => {
    const worker = workerRef.current;
    if (!worker || busy) return;
    setBusy(true);
    setError(null);
    const nonce = ++nonceRef.current;
    const t0 = performance.now();
    pendingRef.current.set(nonce, (r) => {
      setReport({ ...r, totalMs: Math.round((r.parseMs + (performance.now() - t0 - r.parseMs)) * 100) / 100 });
      setBusy(false);
    });
    worker.postMessage({ text, nonce });
  };

  return (
    <section className="panel">
      <h2>② Worker AST 解析（remark + GFM + frontmatter）</h2>
      {error && <p className="bad">{error}</p>}
      <div className="actions">
        <button disabled={busy} onClick={() => run(buildSampleMarkdown())}>
          解析示例文档
        </button>
        <button disabled={busy} onClick={() => run(buildLargeDocument(50_000))}>
          解析 50,000 行
        </button>
      </div>
      {report && (
        <div className="report">
          <p className="stat">
            {report.chars.toLocaleString()} 字符 · Worker 内解析 {report.parseMs} ms · 往返总耗时 {report.totalMs} ms ·
            根级节点 {report.rootChildren} · 标题 {report.headings}（代码块 {report.codeBlocks} 内的不计）
          </p>
          <table>
            <thead>
              <tr>
                <th>kind</th>
                <th>depth</th>
                <th>title</th>
                <th>start</th>
                <th>end</th>
              </tr>
            </thead>
            <tbody>
              {report.segments.map((s, i) => (
                <tr key={i}>
                  <td>{s.kind}</td>
                  <td>{s.depth}</td>
                  <td className="title-cell">{s.title || "（文件前言）"}</td>
                  <td>{s.start.toLocaleString()}</td>
                  <td>{s.end.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">仅显示前 8 段。代码块内 `##`、引用内 `##` 不产生段边界——AST 判定而非逐行正则。</p>
        </div>
      )}
    </section>
  );
}
