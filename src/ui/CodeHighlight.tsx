// 代码块语法高亮（M9）：lowlight（highlight.js 常用语言子集）→ hast → 受控 React 元素。
// 不走 innerHTML：hast 树逐节点映射为 React 元素，仅下发 className（hljs-*），
// 颜色全部由 CSS 令牌承担（styles.css 浅/深两套，与编辑器 tok-* 同源配色）。
// 通过 React.lazy 按需加载：highlight.js 子集不进主包；未就绪前展示纯文本。

import { createElement, useMemo, type ReactNode } from "react";
import { createLowlight, common } from "lowlight";

/** lowlight 产出的 hast 节点（只取用到的字段；类型不透传 highlight.js） */
interface HLNode {
  type: "text" | "element";
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HLNode[];
}

const lowlight = createLowlight(common);

function classOf(n: HLNode): string | undefined {
  const c = n.properties?.className;
  if (Array.isArray(c)) return c.filter((x): x is string => typeof x === "string").join(" ");
  return undefined;
}

/** hast 子树 → React 元素（纯函数，node 测试覆盖） */
function hastToReact(n: HLNode, i: number): ReactNode {
  if (n.type === "text") return n.value ?? "";
  const Tag = n.tagName ?? "span";
  const cls = classOf(n);
  return createElement(
    Tag,
    cls ? { key: i, className: cls } : { key: i },
    (n.children ?? []).map(hastToReact),
  );
}

export interface HighlightResult {
  nodes: ReactNode[];
  /** 语言是否被识别；false = 原样纯文本（pre[data-lang] 仍保留语言名） */
  known: boolean;
}

/** 代码 + 语言 → 高亮 React 节点（纯函数；未注册语言/解析失败回退纯文本） */
export function highlightToNodes(code: string, lang: string | null | undefined): HighlightResult {
  const name = (lang ?? "").trim().toLowerCase();
  if (!name || !lowlight.registered(name)) return { nodes: [code], known: false };
  try {
    const tree = lowlight.highlight(name, code);
    return { nodes: (tree.children as HLNode[]).map(hastToReact), known: true };
  } catch {
    return { nodes: [code], known: false };
  }
}

export default function CodeHighlight({ code, lang }: { code: string; lang: string | null }) {
  const { nodes, known } = useMemo(() => highlightToNodes(code, lang), [code, lang]);
  if (!known) return <code>{code}</code>;
  return <code className="hljs">{nodes}</code>;
}
