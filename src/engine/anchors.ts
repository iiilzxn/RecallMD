// 锚点扫描（设计 §9.2 L308–310）：找出全部协议注释出现位置并判定合法锚位。
//
// 扫描对象是 AST 里的 html 节点（根级块注释 + 段落内行内注释——正文中间的协议注释
// 必须被检出为 MISPLACED，所以必须递归 phrasing）。代码块内的示例注释是 code.value
// 字符串、不产生 html 节点，天然不误报。

import { parseProtocolLine } from "./ids";
import { isHtmlCommentNode, nodeEnd, nodeStart, type MdNode, type MdRoot } from "./segment";
import type { AnchorOccurrence, AnchorPlacement, AnchorScan } from "./types";
import type { SegmentCandidate } from "./segment";

/** 候选的锚区：(headingEnd|frontmatterEnd, 第一项正文前)。upper=bodyStartOffset（无正文时=endOffset）。 */
export interface AnchorWindow {
  from: number;
  upper: number;
}

export function anchorWindowOf(c: SegmentCandidate): AnchorWindow {
  return {
    from: c.kind === "SECTION" ? c.headingEnd : c.startOffset,
    upper: c.bodyStartOffset,
  };
}

function collectHtmlNodes(nodes: MdNode[], out: MdNode[]): void {
  for (const n of nodes) {
    if (n.type === "html") out.push(n);
    if (n.children) collectHtmlNodes(n.children, out);
  }
}

export function scanAnchors(text: string, ast: MdRoot, candidates: SegmentCandidate[]): AnchorScan {
  const htmlNodes: MdNode[] = [];
  collectHtmlNodes(ast.children, htmlNodes);

  const occurrences: AnchorOccurrence[] = [];
  for (const n of htmlNodes) {
    if (!isHtmlCommentNode(n)) continue;
    const cs = nodeStart(n);
    const ce = nodeEnd(n);

    // 独立一行判定：整行 trim 后必须恰为协议注释（同行有前后正文 → 当作普通注释忽略）
    const lineStart = text.lastIndexOf("\n", Math.max(0, cs - 1)) + 1;
    const nl = text.indexOf("\n", cs);
    const lineEnd = nl === -1 ? text.length : nl;
    const parsed = parseProtocolLine(text.slice(lineStart, lineEnd).trim());
    if (parsed.kind === "other") continue;

    const ci = candidates.findIndex((c) => cs >= c.startOffset && cs < c.endOffset);
    let placement: AnchorPlacement = "MISPLACED";
    if (ci !== -1) {
      const w = anchorWindowOf(candidates[ci]);
      // 合法锚位：位于锚区内，且标题/前言结束到注释之间只允许空白。
      // 窗口内若已有更早的注释，本枚与标题之间不再纯空白 → 自动判 MISPLACED（首枚语义天然成立）。
      if (cs >= w.from && cs < w.upper && text.slice(w.from, cs).trim() === "") {
        placement = "LEGAL_ANCHOR";
      }
    }

    occurrences.push({
      blockId: parsed.kind === "valid" ? parsed.blockId : null,
      malformed: parsed.kind === "malformed",
      commentStart: cs,
      commentEnd: ce,
      placement,
      candidateIndex: ci === -1 ? null : ci,
    });
  }

  occurrences.sort((a, b) => a.commentStart - b.commentStart);

  const byId = new Map<string, AnchorOccurrence[]>();
  for (const o of occurrences) {
    if (!o.blockId) continue;
    const list = byId.get(o.blockId);
    if (list) list.push(o);
    else byId.set(o.blockId, [o]);
  }
  return { occurrences, byId };
}
