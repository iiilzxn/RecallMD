// 划块（设计 §8.1 L215–251）：remark 完整 mdast，按根级节点切片。
// 边界由 AST 判定，绝不逐行正则识别 `#`；父子答案互不重叠（ADR-003）。

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import { EngineError, type BlockKind } from "./types";

// --- mdast 结构类型（自描述，避免依赖传递包的 @types/mdast 在 pnpm 严格布局下不可靠）---

export interface MdPoint {
  line: number;
  column: number;
  offset?: number | null;
}

export interface MdPosition {
  start: MdPoint;
  end: MdPoint;
}

export interface MdNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  spread?: boolean | null;
  checked?: boolean | null;
  align?: ("left" | "right" | "center" | null)[] | null;
  url?: string;
  title?: string | null;
  alt?: string | null;
  identifier?: string;
  label?: string | null;
  referenceType?: "full" | "collapsed" | "shortcut";
  lang?: string | null;
  meta?: string | null;
  children?: MdNode[];
  position?: MdPosition;
}

export interface MdRoot {
  type: "root";
  children: MdNode[];
}

// remark-parse 无状态，模块级单例即可（M0 已验证该栈在 Worker 与 node 均可加载）
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ["yaml"]);

export function parseMarkdown(text: string): MdRoot {
  // 引擎坐标系统一为内部 LF 文本（§8.2 L272）；上游 read_document / CM6 buffer 已保证，
  // 此处防御性拒绝，防止 CRLF/BOM 偷偷混入破坏 offset 语义
  if (text.includes("\r")) throw new EngineError("NON_LF_INPUT", "引擎输入包含 CR，必须先 LF 化");
  if (text.startsWith("﻿")) throw new EngineError("BOM_INPUT", "引擎输入包含 BOM，必须先剥离");
  return parser.parse(text) as unknown as MdRoot;
}

export function nodeStart(n: MdNode): number {
  return n.position?.start?.offset ?? 0;
}

export function nodeEnd(n: MdNode): number {
  return n.position?.end?.offset ?? 0;
}

/** HTML 注释（块级或行内）。宽松头尾空白以吸收 remark 对 html 值的行尾处理差异。 */
export function isHtmlCommentNode(n: MdNode): boolean {
  if (n.type !== "html") return false;
  return /^\s*<!--[\s\S]*-->\s*$/.test(n.value ?? "");
}

/** reference definition：文件级解析上下文，不作为独立答案（§7.2 L197）。 */
export function isDefinitionNode(n: MdNode): boolean {
  return n.type === "definition";
}

/** 从 bodyChildren 里排除 ID 注释与 definition 的起点（§8.2 L258 渲染语义）。 */
export function isExcludedFromBody(n: MdNode): boolean {
  return isHtmlCommentNode(n) || isDefinitionNode(n);
}

/** 合格正文判定（§8.1 规则 5）：至少一项有效内容。 */
const QUALIFYING_TYPES = new Set(["paragraph", "list", "blockquote", "table", "code", "image"]);

export type UnqualifiedReason = "EMPTY" | "COMMENTS_ONLY" | "HR_ONLY" | "DEFINITIONS_ONLY" | "HTML_ONLY";

function classifyBody(nodes: MdNode[]): { qualified: boolean; reason?: UnqualifiedReason } {
  if (nodes.length === 0) return { qualified: false, reason: "EMPTY" };
  if (nodes.some((n) => QUALIFYING_TYPES.has(n.type))) return { qualified: true };
  // 不合格时的定性按固定优先级，保证同输入输出确定
  if (nodes.every((n) => isHtmlCommentNode(n))) return { qualified: false, reason: "COMMENTS_ONLY" };
  if (nodes.some((n) => n.type === "thematicBreak")) return { qualified: false, reason: "HR_ONLY" };
  if (nodes.some((n) => isDefinitionNode(n))) return { qualified: false, reason: "DEFINITIONS_ONLY" };
  if (nodes.every((n) => n.type === "html")) return { qualified: false, reason: "HTML_ONLY" };
  return { qualified: false, reason: "EMPTY" };
}

/** 提取节点纯文本（标题题面用；语义展示，不参与哈希）。 */
export function extractText(n: MdNode): string {
  if (n.type === "text" || n.type === "inlineCode") return n.value ?? "";
  if (n.type === "image") return n.alt ?? "";
  if (n.type === "break") return " ";
  if (!n.children) return "";
  return n.children.map(extractText).join("");
}

export interface SegmentCandidate {
  kind: BlockKind;
  title: string | null; // PREAMBLE 为 null
  headingLevel: number; // 0–6；PREAMBLE=0
  headingPath: string[]; // 祖先+自身；PREAMBLE=[]
  headingStart: number;
  /** 标题结束（Setext 含下划线行末；§9.2 L308 跨度定义）。PREAMBLE=首根子节点起点。 */
  headingEnd: number;
  /** SECTION=标题起点；PREAMBLE=frontmatter 结束（不含 frontmatter，§8.2 L257）。 */
  startOffset: number;
  endOffset: number;
  bodyChildren: MdNode[];
  bodyStartOffset: number; // 无非排除节点时 = endOffset
  qualified: boolean;
  unqualifiedReason?: UnqualifiedReason;
  hasFrontmatter: boolean;
}

/** mdast → 切片候选序列（文档顺序）。 */
export function segmentDocument(text: string, ast: MdRoot): SegmentCandidate[] {
  const children = ast.children;

  // frontmatter 只认文件首节点（remark-frontmatter 语义）
  let fmEnd = 0;
  let hasFrontmatter = false;
  let i = 0;
  if (children.length > 0 && children[0].type === "yaml") {
    hasFrontmatter = true;
    fmEnd = nodeEnd(children[0]);
    i = 1;
  }

  // 根级分组：首组为 preamble（heading=null），其后每个标题领起一组直属正文
  const groups: { heading: MdNode | null; nodes: MdNode[] }[] = [];
  let current: { heading: MdNode | null; nodes: MdNode[] } = { heading: null, nodes: [] };
  for (; i < children.length; i++) {
    const n = children[i];
    if (n.type === "heading") {
      groups.push(current);
      current = { heading: n, nodes: [] };
    } else {
      current.nodes.push(n);
    }
  }
  groups.push(current); // 无标题文件：唯一一组 preamble

  const candidates: SegmentCandidate[] = [];
  const depthStack: { depth: number; title: string }[] = [];

  groups.forEach((g, gi) => {
    const nextHeadingStart =
      gi + 1 < groups.length && groups[gi + 1].heading
        ? nodeStart(groups[gi + 1].heading!)
        : text.length;

    if (g.heading === null) {
      // 前言：区域 [fmEnd, 首标题起点)。纯空白（无节点）不生成候选
      if (g.nodes.length === 0) return;
      const first = nodeStart(g.nodes[0]);
      candidates.push(makeCandidate("PREAMBLE", null, 0, [], first, first, fmEnd, nextHeadingStart, g.nodes, hasFrontmatter));
      return;
    }

    const h = g.heading;
    const depth = h.depth ?? 1;
    const title = extractText(h);
    // 深度栈：遇深度 ≤ 栈顶先出栈；允许跳级，不虚构中间标题（§8.1 规则 3）
    while (depthStack.length > 0 && depthStack[depthStack.length - 1].depth >= depth) {
      depthStack.pop();
    }
    const headingPath = [...depthStack.map((e) => e.title), title];
    depthStack.push({ depth, title });
    candidates.push(
      makeCandidate("SECTION", title, depth, headingPath, nodeStart(h), nodeEnd(h), nodeStart(h), nextHeadingStart, g.nodes, hasFrontmatter),
    );
  });

  return candidates;
}

function makeCandidate(
  kind: BlockKind,
  title: string | null,
  headingLevel: number,
  headingPath: string[],
  headingStart: number,
  headingEnd: number,
  startOffset: number,
  endOffset: number,
  bodyChildren: MdNode[],
  hasFrontmatter: boolean,
): SegmentCandidate {
  const { qualified, reason } = classifyBody(bodyChildren);
  const firstBody = bodyChildren.find((n) => !isExcludedFromBody(n));
  return {
    kind,
    title,
    headingLevel,
    headingPath,
    headingStart,
    headingEnd,
    startOffset,
    endOffset,
    bodyChildren,
    bodyStartOffset: firstBody ? nodeStart(firstBody) : endOffset,
    qualified,
    unqualifiedReason: reason,
    hasFrontmatter,
  };
}
