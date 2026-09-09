// 单文件分析编排（M3 引擎入口）：同步核心（parse→segment→anchors→指纹串→插入计划）
// + 异步 finalize（哈希批量补齐，§15.2 Worker 返回紧凑 DTO）。

import { scanAnchors, anchorWindowOf } from "./anchors";
import { buildDefinitionMap, fingerprintBody, FINGERPRINT_VERSION } from "./fingerprint";
import { sha256Hex } from "./hash";
import { newBlockId } from "./ids";
import { buildInsertionPlan, type InsertTarget } from "./insertion";
import { nodeEnd, nodeStart, parseMarkdown, segmentDocument, type MdNode } from "./segment";
import type {
  AnchorInsertion,
  BlockInfo,
  Diagnostic,
  SingleFileReport,
  UnqualifiedHeading,
} from "./types";

export const PARSER_VERSION = `remark-parse@11.0.0+remark-gfm@4.0.1+remark-frontmatter@5.0.0/${FINGERPRINT_VERSION}`;

export interface EngineFileInput {
  relativePath: string;
  /** 已 LF 化、去 BOM 的正文（read_document / CM6 buffer 保证；引擎防御性拒绝违规输入）。 */
  text: string;
  /** 磁盘原始字节哈希（文件级指纹；引擎不回写）。 */
  rawByteHash: string;
}

export interface AnalyzeOptions {
  /** "none"（默认）恒产空计划=无写副作用；"missing" 为无锚合格块生成插入计划（§9.2 L312）。 */
  insertionPolicy?: "none" | "missing";
  /** 测试注入确定性 ID；生产走 crypto.randomUUID。 */
  generateIds?: () => string;
}

const OVERSIZED_VISIBLE_CHARS = 8000;
const OVERSIZED_LINES = 200;

export async function analyzeDocument(input: EngineFileInput, opts: AnalyzeOptions = {}): Promise<SingleFileReport> {
  const { text } = input;
  const ast = parseMarkdown(text);
  const candidates = segmentDocument(text, ast);
  const scan = scanAnchors(text, ast, candidates);
  const diagnostics: Diagnostic[] = [];

  // --- Git 冲突标记（§8.3 L285）：非代码区出现 → 暂停索引提交与复习 ---
  // 只认行首 `<<<<<<<`（冲突起点标记，无合法 Markdown 构形歧义；
  // `=======` 单独出现可能是 Setext 下划线，不作触发条件）
  const conflictAt = detectGitConflictStart(text, ast);
  const indexable = conflictAt === null;
  if (conflictAt !== null) {
    const nl = text.indexOf("\n", conflictAt);
    const end = nl === -1 ? text.length : nl;
    diagnostics.push({ code: "GIT_CONFLICT", blockId: null, startOffset: conflictAt, endOffset: end });
  }

  // --- 锚点归属与候选占用 ---
  // anchorOf：候选的合法锚点（窗口内首个合法 UUID 注释）；
  // occupied：候选范围内存在任何协议形出现（合法/额外/畸形/错位）——
  // 插入只服务干净的未锚块，有协议痕迹的候选留给显式“解决 ID 问题”操作（§9.4 L360）
  const anchorOf = new Map<number, string>();
  const occupied = new Set<number>();
  for (const o of scan.occurrences) {
    if (o.candidateIndex == null) continue;
    occupied.add(o.candidateIndex);
    const w = anchorWindowOf(candidates[o.candidateIndex]);
    if (
      o.placement === "LEGAL_ANCHOR" &&
      o.blockId &&
      o.commentStart >= w.from &&
      o.commentStart < w.upper &&
      !anchorOf.has(o.candidateIndex)
    ) {
      anchorOf.set(o.candidateIndex, o.blockId);
    }
  }

  // --- 协议注释诊断 ---
  // 合并冲突线索（§9.2 L310）：同一候选内出现多枚不同合法 ID（删除边界后落入同一候选，
  // 位置不限——合并后第二枚往往悬在正文中部）。此类候选的非首枚报 ID_EXTRA；
  // 单枚且错位才报位置异常 ID_MISPLACED。
  const distinctIdsByCandidate = new Map<number, Set<string>>();
  for (const o of scan.occurrences) {
    if (!o.blockId || o.candidateIndex == null) continue;
    let s = distinctIdsByCandidate.get(o.candidateIndex);
    if (!s) {
      s = new Set();
      distinctIdsByCandidate.set(o.candidateIndex, s);
    }
    s.add(o.blockId);
  }
  for (const o of scan.occurrences) {
    if (o.malformed) {
      diagnostics.push({ code: "ID_MALFORMED", blockId: null, startOffset: o.commentStart, endOffset: o.commentEnd });
      continue;
    }
    if (!o.blockId || o.placement !== "MISPLACED") continue;
    const ids = o.candidateIndex != null ? distinctIdsByCandidate.get(o.candidateIndex) : undefined;
    diagnostics.push(
      ids && ids.size >= 2
        ? { code: "ID_EXTRA", blockId: o.blockId, startOffset: o.commentStart, endOffset: o.commentEnd }
        : { code: "ID_MISPLACED", blockId: o.blockId, startOffset: o.commentStart, endOffset: o.commentEnd },
    );
  }
  for (const [id, occs] of scan.byId) {
    if (occs.length > 1) {
      for (const o of occs) {
        diagnostics.push({ code: "ID_DUPLICATED", blockId: id, startOffset: o.commentStart, endOffset: o.commentEnd });
      }
    }
  }

  // --- 合格块 + 哈希前像 ---
  const defs = buildDefinitionMap(ast);
  const blocks: BlockInfo[] = [];
  const ordinalByCandidate: (number | null)[] = candidates.map(() => null);
  const unqualifiedHeadings: UnqualifiedHeading[] = [];
  const sourcePreimages: string[] = [];
  const bodyPreimages: string[] = [];

  candidates.forEach((c, i) => {
    if (!c.qualified) {
      unqualifiedHeadings.push({ title: c.title, startOffset: c.startOffset, endOffset: c.endOffset });
      return;
    }
    const blockId = anchorOf.get(i) ?? null;
    const slice = text.slice(c.startOffset, c.endOffset);

    // source_hash 前像：切片去自身合法 ID 注释行（含行尾换行，若属本块）
    let src = slice;
    if (blockId) {
      const occ = (scan.byId.get(blockId) ?? []).find(
        (o) => o.placement === "LEGAL_ANCHOR" && o.candidateIndex === i,
      );
      if (occ) {
        const lineStartAbs = text.lastIndexOf("\n", Math.max(0, occ.commentStart - 1)) + 1;
        const nlAbs = text.indexOf("\n", occ.commentStart);
        const lineEndAbs = nlAbs === -1 ? text.length : nlAbs;
        const stripS = Math.max(lineStartAbs, c.startOffset) - c.startOffset;
        const stripE = Math.min(lineEndAbs, c.endOffset) - c.startOffset + (nlAbs !== -1 && nlAbs < c.endOffset ? 1 : 0);
        src = slice.slice(0, stripS) + slice.slice(stripE);
      }
    }

    const visibleChars = slice.replace(/\s+/g, "").length;
    const lineCount = slice.split("\n").length;
    const oversized = visibleChars > OVERSIZED_VISIBLE_CHARS || lineCount > OVERSIZED_LINES;
    if (oversized) {
      diagnostics.push({ code: "BLOCK_OVERSIZED", blockId, startOffset: c.startOffset, endOffset: c.endOffset });
    }

    ordinalByCandidate[i] = blocks.length;
    blocks.push({
      blockId,
      kind: c.kind,
      title: c.title,
      headingLevel: c.headingLevel,
      headingPath: c.headingPath,
      ordinal: blocks.length,
      startOffset: c.startOffset,
      bodyStartOffset: c.bodyStartOffset,
      endOffset: c.endOffset,
      sourceHash: "",
      bodyHash: "",
      oversized,
    });
    sourcePreimages.push(src);
    bodyPreimages.push(fingerprintBody(c.bodyChildren, defs));
  });

  // --- 插入计划（policy "none" 恒空：扫描无写副作用的引擎侧保证）---
  let insertionPlan: AnchorInsertion[] = [];
  if ((opts.insertionPolicy ?? "none") === "missing" && indexable) {
    const targets: InsertTarget[] = [];
    candidates.forEach((c, i) => {
      if (!c.qualified || anchorOf.has(i) || occupied.has(i)) return;
      targets.push({
        kind: c.kind,
        ordinal: ordinalByCandidate[i]!,
        insertOffset: c.kind === "SECTION" ? c.headingEnd : c.bodyStartOffset,
      });
    });
    insertionPlan = buildInsertionPlan(text, targets, opts.generateIds ?? newBlockId);
  }

  // --- finalize：哈希一轮补齐（引擎唯一 await 面）---
  const [sourceHashes, bodyHashes] = await Promise.all([
    Promise.all(sourcePreimages.map(sha256Hex)),
    Promise.all(bodyPreimages.map(sha256Hex)),
  ]);
  blocks.forEach((b, i) => {
    b.sourceHash = sourceHashes[i];
    b.bodyHash = bodyHashes[i];
  });

  return {
    relativePath: input.relativePath,
    rawByteHash: input.rawByteHash,
    revision: input.rawByteHash,
    parserVersion: PARSER_VERSION,
    charCount: text.length,
    lineCount: text === "" ? 0 : text.split("\n").length,
    indexable,
    blocks,
    unqualifiedHeadings,
    anchorOccurrences: scan.occurrences,
    diagnostics,
    insertionPlan,
  };
}

/** 收集全部 code/inlineCode 覆盖范围（Git 冲突检测的“代码区域”白名单）。 */
function collectCodeRanges(nodes: MdNode[], out: [number, number][]): void {
  for (const n of nodes) {
    if (n.type === "code" || n.type === "inlineCode") {
      out.push([nodeStart(n), nodeEnd(n)]);
    }
    if (n.children) collectCodeRanges(n.children, out);
  }
}

/** 返回首个非代码区冲突标记行起点；无则 null。 */
function detectGitConflictStart(text: string, ast: ReturnType<typeof parseMarkdown>): number | null {
  const codeRanges: [number, number][] = [];
  collectCodeRanges(ast.children, codeRanges);
  const inCode = (off: number) => codeRanges.some(([s, e]) => off >= s && off < e);

  let pos = 0;
  for (const line of text.split("\n")) {
    const lineStart = pos;
    pos += line.length + 1;
    if (line.startsWith("<<<<<<<") && !inCode(lineStart)) return lineStart;
  }
  return null;
}
