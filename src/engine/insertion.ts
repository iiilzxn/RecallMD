// 锚点插入计划（设计 §9.2 L312、§13.1 L821–823）：
// 只按 offset 插入独立一行的协议注释，绝不经过 AST stringify 重写（§8.1 L217）。
// 插入文本两种形态：SECTION="\n"+注释行（紧随标题行，含 Setext 下划线之后）；
// PREAMBLE=注释行+"\n"（前言锚点位于第一项正文上方独占一行）。

import { makeAnchorLine } from "./ids";
import { EngineError, type AnchorInsertion } from "./types";

/** analyze 计算好的插入目标（引擎内部不重复做合格性/锚定判断）。 */
export interface InsertTarget {
  kind: "SECTION" | "PREAMBLE";
  ordinal: number;
  /** SECTION=headingEnd；PREAMBLE=bodyStartOffset。 */
  insertOffset: number;
}

const CONTEXT_CHARS = 32;

export function buildInsertionPlan(text: string, targets: InsertTarget[], generateIds: () => string): AnchorInsertion[] {
  return targets.map((t) => {
    const blockId = generateIds();
    const insertText = t.kind === "SECTION" ? `\n${makeAnchorLine(blockId)}` : `${makeAnchorLine(blockId)}\n`;
    const off = t.insertOffset;
    return {
      blockId,
      ordinal: t.ordinal,
      insertOffset: off,
      text: insertText,
      contextBefore: text.slice(Math.max(0, off - CONTEXT_CHARS), off),
      contextAfter: text.slice(off, off + CONTEXT_CHARS),
    };
  });
}

/** 纯函数应用插入计划（保存流计算最终文本用；Worker/UI 不直接用）。 */
export function applyInsertions(text: string, plan: AnchorInsertion[]): { text: string; applied: AnchorInsertion[] } {
  // 快照内逐条核对上下文；全部通过才应用——保证不重排、只新增注释行
  for (const e of plan) {
    if (text.slice(e.insertOffset - e.contextBefore.length, e.insertOffset) !== e.contextBefore) {
      throw new EngineError("INSERTION_CONTEXT_MISMATCH", `插入点 ${e.insertOffset} 前文不符`);
    }
    if (text.slice(e.insertOffset, e.insertOffset + e.contextAfter.length) !== e.contextAfter) {
      throw new EngineError("INSERTION_CONTEXT_MISMATCH", `插入点 ${e.insertOffset} 后文不符`);
    }
  }
  let out = text;
  for (const e of [...plan].sort((a, b) => b.insertOffset - a.insertOffset)) {
    out = out.slice(0, e.insertOffset) + e.text + out.slice(e.insertOffset);
  }
  return { text: out, applied: plan };
}

/** applyInsertions 的精确逆（测试断言“仅新增注释行”用）。 */
export function stripInsertions(text: string, plan: AnchorInsertion[]): string {
  let out = text;
  for (const e of [...plan].sort((a, b) => b.insertOffset - a.insertOffset)) {
    if (out.slice(e.insertOffset, e.insertOffset + e.text.length) !== e.text) {
      throw new EngineError("INSERTION_CONTEXT_MISMATCH", `位置 ${e.insertOffset} 处无预期插入文本`);
    }
    out = out.slice(0, e.insertOffset) + out.slice(e.insertOffset + e.text.length);
  }
  return out;
}
