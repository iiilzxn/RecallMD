import { useCallback, useEffect, useRef, useState } from "react";
import { indexIpc, type RegisteredBlockDto } from "../index/ipc";
import type { HostErrorShape } from "../editor/ipc";
import type { ReviewService } from "../review/service";

/** Restore participation through existing commands; never reset learning history. */
export function ParticipationManager({ service, onChanged }: {
  service: ReviewService;
  onChanged: () => void;
}) {
  const [blocks, setBlocks] = useState<RegisteredBlockDto[]>([]);
  const [filter, setFilter] = useState<"PAUSED" | "EXCLUDED">("PAUSED");
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(30);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const requestRef = useRef(0);
  const submittingRef = useRef(false);
  const mountedRef = useRef(false);
  const feedbackRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (message) feedbackRef.current?.focus({ preventScroll: true });
  }, [message]);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const snapshot = await indexIpc.registryRead();
      if (request !== requestRef.current) return;
      setBlocks(snapshot.blocks.filter((b) => b.participation === "PAUSED" || b.participation === "EXCLUDED"));
    } catch (e) {
      if (request === requestRef.current) setError((e as HostErrorShape).message ?? "读取失败，请重试。");
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => { mountedRef.current = false; requestRef.current++; };
  }, [refresh]);

  const restore = async (block: RegisteredBlockDto) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(block.blockId);
    setMessage(null);
    setError(null);
    try {
      await service.setParticipation([block.blockId], block.participation === "PAUSED" ? "RESUME" : "INCLUDE");
      onChanged();
      if (!mountedRef.current) return;
      setBlocks((items) => items.filter((item) => item.blockId !== block.blockId));
      setMessage(`「${block.title ?? "前言"}」已恢复参与复习，学习进度已保留。是否进入今日队列由到期时间与内容状态决定。`);
      await refresh();
    } catch (e) {
      if (mountedRef.current) setError((e as HostErrorShape).message ?? "恢复失败，请重试。");
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  };

  const normalized = query.trim().toLocaleLowerCase();
  const filtered = blocks.filter((b) => b.participation === filter && `${b.title ?? "前言"} ${b.relativePath}`.toLocaleLowerCase().includes(normalized));

  return (
    <section className="stats-section participation-manager" aria-labelledby="participation-title" aria-busy={loading}>
      <div className="section-heading">
        <h3 id="participation-title">复习内容管理</h3>
        <button type="button" className="btn small" disabled={loading || busy !== null} onClick={() => void refresh()}>刷新列表</button>
      </div>
      <p className="hint">找回已暂停或已排除的内容。恢复会保留原有学习进度，不会重新开始。</p>
      <div className="participation-filters" role="group" aria-label="参与状态筛选">
        {([ ["PAUSED", "已暂停"], ["EXCLUDED", "已排除"] ] as const).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? "selected" : ""} onClick={() => { setFilter(value); setVisibleCount(30); }}>
            {label} <span>{blocks.filter((b) => b.participation === value).length}</span>
          </button>
        ))}
      </div>
      <input className="text-input" aria-label="查找复习内容" placeholder="按标题或文件路径查找" value={query} onChange={(e) => { setQuery(e.target.value); setVisibleCount(30); }} />
      {message && <p className="review-toast" role="status" tabIndex={-1} ref={feedbackRef}>{message}</p>}
      {error && <p className="review-error" role="alert">{error}</p>}
      {loading ? <p className="hint" role="status">正在读取复习内容…</p> : !error && filtered.length === 0 ? (
        <p className="participation-empty">{query.trim() ? "没有匹配的内容，试试其他标题或路径。" : filter === "PAUSED" ? "没有已暂停的内容。" : "没有已排除的内容。"}</p>
      ) : (
        <ul className="participation-list">
          {filtered.slice(0, visibleCount).map((block) => (
            <li key={block.blockId}>
              <div className="participation-item-info">
                <strong>{block.title ?? "前言"}</strong>
                <span title={block.relativePath}>{block.relativePath}</span>
                {block.status !== "ACTIVE" && <small>原文暂不可用于复习；恢复参与后仍需处理文件或标记问题。</small>}
              </div>
              <button type="button" disabled={busy !== null || loading} onClick={() => void restore(block)}>
                {busy === block.blockId ? "恢复中…" : filter === "PAUSED" ? "恢复复习" : "重新纳入"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!loading && filtered.length > visibleCount && <button type="button" className="text-button" onClick={() => setVisibleCount((n) => n + 30)}>显示更多（已显示 {visibleCount} / {filtered.length}）</button>}
    </section>
  );
}
