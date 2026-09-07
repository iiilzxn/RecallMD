// M0 验证：CodeMirror 6 大文档装载与输入基线（IME 输入质量需人工在窗口中实测）
import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine, drawSelection, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { buildLargeDocument, buildSampleMarkdown } from "./content";

type LoadStat = { label: string; lines: number; chars: number; ms: number };

const extensions = [
  lineNumbers(),
  highlightActiveLine(),
  history(),
  drawSelection(),
  EditorView.lineWrapping,
  markdown(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
];

export function EditorPanel() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [stat, setStat] = useState<LoadStat | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({ doc: "", extensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  const load = (label: string, text: string) => {
    const view = viewRef.current;
    if (!view) return;
    const t0 = performance.now();
    view.setState(EditorState.create({ doc: text, extensions }));
    const ms = performance.now() - t0;
    setStat({ label, lines: text.split("\n").length, chars: text.length, ms: Math.round(ms * 100) / 100 });
  };

  return (
    <section className="panel">
      <h2>① CodeMirror 6 编辑器</h2>
      <div className="actions">
        <button onClick={() => load("示例文档", buildSampleMarkdown())}>载入示例文档</button>
        <button onClick={() => load("50,000 行大文档", buildLargeDocument(50_000))}>载入 50,000 行</button>
      </div>
      <p className="hint">在此输入中文验证 IME（组合输入过程不应打断、不应丢失字符）</p>
      <div ref={hostRef} className="editor-host" />
      {stat && (
        <p className="stat">
          {stat.label}：{stat.lines.toLocaleString()} 行 / {stat.chars.toLocaleString()} 字符 · 替换文档耗时 {stat.ms} ms
        </p>
      )}
    </section>
  );
}
