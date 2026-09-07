/// <reference lib="webworker" />
// M0 验证：Worker 中构建完整 mdast 并按根级标题切段（设计 §8.1 的最小子集，正式 BlockEngine 在 M3）
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";

export type AstSegment = {
  kind: "PREAMBLE" | "SECTION";
  title: string;
  depth: number;
  start: number;
  end: number;
};

export type AstReport = {
  nonce: number;
  chars: number;
  parseMs: number;
  totalMs: number;
  rootChildren: number;
  headings: number;
  codeBlocks: number;
  segments: AstSegment[];
};

type Pos = { start: { offset?: number | null }; end: { offset?: number | null } };
type MdNode = { type: string; depth?: number; position?: Pos };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

console.log("[ast.worker] booted, loading remark…");

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ["yaml"]);

console.log("[ast.worker] remark ready");

ctx.onmessage = (e: MessageEvent<{ text: string; nonce: number }>) => {
  const { text, nonce } = e.data;
  const t0 = performance.now();
  const ast = parser.parse(text) as unknown as { children: MdNode[] };
  const parseMs = performance.now() - t0;

  const offset = (n: MdNode, edge: "start" | "end"): number => n.position?.[edge]?.offset ?? 0;
  const headings = ast.children.filter((n) => n.type === "heading");
  const codeBlocks = ast.children.filter((n) => n.type === "code").length;

  const bodyStart = ast.children[0]?.type === "yaml" ? offset(ast.children[0], "end") : 0;
  const segments: AstSegment[] = [];

  const firstHeadingStart = headings.length ? offset(headings[0], "start") : text.length;
  if (text.slice(bodyStart, firstHeadingStart).trim().length > 0) {
    segments.push({ kind: "PREAMBLE", title: "", depth: 0, start: bodyStart, end: firstHeadingStart });
  }
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const start = offset(h, "start");
    const end = i + 1 < headings.length ? offset(headings[i + 1], "start") : text.length;
    segments.push({
      kind: "SECTION",
      title: text.slice(start, offset(h, "end")),
      depth: h.depth ?? 0,
      start,
      end,
    });
  }

  const report: AstReport = {
    nonce,
    chars: text.length,
    parseMs: Math.round(parseMs * 100) / 100,
    totalMs: Math.round((performance.now() - t0) * 100) / 100,
    rootChildren: ast.children.length,
    headings: headings.length,
    codeBlocks,
    // 大文档只回传前 8 段摘要，避免 IPC 洪泛
    segments: segments.slice(0, 8),
  };
  ctx.postMessage(report);
};
