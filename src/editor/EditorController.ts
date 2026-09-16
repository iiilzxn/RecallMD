// EditorController：持有 CM 实例与交互边界（设计 §6.1/§7.3 的 M1 实现，M3 增系统事务）。
// React 不逐按键同步全文；全文读取只在保存/解析边界（§15.2）。

import { ChangeSet, EditorState, Transaction, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting } from "@codemirror/language";
import { tagHighlighter, tags } from "@lezer/highlight";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { anchorHighlight } from "./anchorHighlight";

/**
 * 受控语法高亮器（M9）：只下发 tok-* 语义类名，颜色全部由 styles.css 的
 * CSS 变量承担——浅/深两套主题换 data-theme 即换肤，不内联任何色值。
 * （此前用的 defaultHighlightStyle 是 styleModule 内联色，深色下不可控。）
 */
const mdHighlighter = tagHighlighter([
  { tag: tags.heading1, class: "tok-heading tok-heading1" },
  { tag: tags.heading2, class: "tok-heading tok-heading2" },
  { tag: tags.heading3, class: "tok-heading tok-heading3" },
  { tag: tags.heading4, class: "tok-heading tok-heading4" },
  { tag: tags.heading5, class: "tok-heading tok-heading5" },
  { tag: tags.heading6, class: "tok-heading tok-heading6" },
  { tag: tags.emphasis, class: "tok-emphasis" },
  { tag: tags.strong, class: "tok-strong" },
  { tag: tags.link, class: "tok-link" },
  { tag: tags.url, class: "tok-url" },
  { tag: tags.monospace, class: "tok-monospace" },
  { tag: tags.processingInstruction, class: "tok-meta" },
  { tag: tags.keyword, class: "tok-keyword" },
  { tag: tags.atom, class: "tok-atom" },
  { tag: tags.bool, class: "tok-bool" },
  { tag: tags.string, class: "tok-string" },
  { tag: tags.special(tags.string), class: "tok-string2" },
  { tag: tags.number, class: "tok-number" },
  { tag: tags.comment, class: "tok-comment" },
  { tag: tags.operator, class: "tok-operator" },
  { tag: tags.typeName, class: "tok-typeName" },
  { tag: tags.variableName, class: "tok-variableName" },
  { tag: tags.definition(tags.variableName), class: "tok-variableName tok-definition" },
  { tag: tags.propertyName, class: "tok-propertyName" },
  { tag: tags.namespace, class: "tok-namespace" },
  { tag: tags.className, class: "tok-className" },
  { tag: tags.meta, class: "tok-meta" },
  { tag: tags.invalid, class: "tok-invalid" },
]);

export interface CursorInfo {
  line: number; // 1 起
  col: number; // 1 起
  lines: number;
  chars: number;
}

/** 系统编辑（ID 注释插入等）：带快照上下文，映射后逐字核对才应用。 */
export interface SystemEdit {
  from: number;
  to: number;
  insert: string;
  /** 快照中插入点前后文（引擎给的 ≤32 字符），供安全核对（§13.1 L812）。 */
  contextBefore: string;
  contextAfter: string;
}

export interface EditorCallbacks {
  onDocChanged: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onCursor: (info: CursorInfo) => void;
  onSave: () => void;
}

export class EditorController {
  private view: EditorView | null = null;
  private extensions: Extension[] = [];
  private suppressChange = false;
  private cbs: EditorCallbacks;
  /** IME 组合态：组合期间不应用系统编辑（§13.1 L810）。 */
  private composing = false;
  /** 系统编辑基线：edits 坐标系（快照文本）→ 当前 buffer 的累积映射。 */
  private baseline: { text: string; changes: ChangeSet } | null = null;

  constructor(cbs: EditorCallbacks) {
    this.cbs = cbs;
  }

  mount(parent: HTMLElement) {
    this.extensions = [
      lineNumbers(),
      highlightActiveLine(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorView.lineWrapping,
      rectangularSelection(),
      highlightSelectionMatches(),
      anchorHighlight,
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(mdHighlighter),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (this.cbs.onSave(), true) },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        // 基线映射必须先于 suppressChange 早退：系统事务自身的改动也要进入映射，
        // 否则基线后续映射缺一段（M3 风险清单 #9）
        if (this.baseline && u.docChanged) {
          this.baseline = {
            text: this.baseline.text,
            changes: this.baseline.changes.compose(u.changes),
          };
        }
        // 闭包读实例字段，replaceDoc 的 suppress 生效于事件时点
        if (u.docChanged && !this.suppressChange) this.cbs.onDocChanged();
        if (u.selectionSet || u.docChanged) this.reportCursor();
      }),
      EditorView.domEventHandlers({
        compositionstart: () => {
          this.composing = true;
          this.cbs.onCompositionStart();
        },
        compositionend: () => {
          this.composing = false;
          this.cbs.onCompositionEnd();
        },
      }),
    ];
    this.view = new EditorView({
      parent,
      state: EditorState.create({ doc: "", extensions: this.extensions }),
    });
  }

  destroy() {
    this.view?.destroy();
    this.view = null;
  }

  getView(): EditorView | null {
    return this.view;
  }

  getText(): string {
    return this.view ? this.view.state.doc.toString() : "";
  }

  /**
   * 程序化替换全文（打开/重载/磁盘版恢复）。
   * 重建 state → 旧撤销栈随之丢弃，不能 Undo 回外部改写前的内容（§13.4）。
   * 尽量保持旧行位置。
   */
  replaceDoc(text: string) {
    const view = this.view;
    if (!view) return;
    this.baseline = null; // 全文重建后旧基线作废
    const oldLine = view.state.doc.lineAt(view.state.selection.main.head).number;
    this.suppressChange = true;
    try {
      view.setState(EditorState.create({ doc: text, extensions: this.extensions }));
      const lines = view.state.doc.lines;
      const targetLine = Math.min(oldLine, lines);
      const pos = view.state.doc.line(targetLine).from;
      view.dispatch({ selection: { anchor: pos } });
    } finally {
      this.suppressChange = false;
    }
    this.reportCursor();
  }

  isComposing(): boolean {
    return this.composing;
  }

  /**
   * 建立系统编辑基线：edits 以该快照文本的坐标计算，此后到应用之间的一切
   * 文档变更（用户输入/其他系统事务）都会累积进映射。
   * 必须在 await 引擎分析之前调用——compose 只覆盖基线创建之后的变更。
   */
  markBaseline(text: string) {
    this.baseline = { text, changes: ChangeSet.empty(text.length) };
  }

  clearBaseline() {
    this.baseline = null;
  }

  /**
   * 应用系统编辑（§7.3 L211）：独立系统事务，不进用户撤销历史。
   * 返回 false = 不可安全应用（组合中/无基线/上下文核对失败），buffer 未做任何修改。
   * 从不 setState 重建——选区与撤销栈原样保留，光标随事务自动映射。
   */
  applySystemEdits(edits: SystemEdit[]): boolean {
    const view = this.view;
    if (!view) return edits.length === 0;
    if (edits.length === 0) return true;
    if (this.composing) return false;
    if (!this.baseline) return false;

    const mapped: { from: number; to: number; insert: string }[] = [];
    for (const e of edits) {
      // assoc=1：与插入点重合的用户输入排前，注释落其后的正文前（锚区内空白处均合法）
      const from = this.baseline.changes.mapPos(e.from, 1);
      const to = this.baseline.changes.mapPos(e.to, 1);
      // 安全核对（§13.1 L812）：映射点前后文与快照上下文逐字一致才应用
      if (view.state.doc.sliceString(Math.max(0, from - e.contextBefore.length), from) !== e.contextBefore) {
        return false;
      }
      if (view.state.doc.sliceString(to, to + e.contextAfter.length) !== e.contextAfter) {
        return false;
      }
      mapped.push({ from, to, insert: e.insert });
    }

    this.suppressChange = true;
    try {
      view.dispatch({
        changes: mapped, // 同事务内位置均以事务前文档解释
        annotations: Transaction.addToHistory.of(false),
      });
    } finally {
      this.suppressChange = false;
    }
    // 用后即弃：Undo 恢复内容后必须重解析，绝不盲用旧范围（§7.3 L211）
    this.baseline = null;
    return true;
  }

  focus() {
    this.view?.focus();
  }

  private reportCursor() {
    const view = this.view;
    if (!view) return;
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    this.cbs.onCursor({
      line: line.number,
      col: sel.head - line.from + 1,
      lines: view.state.doc.lines,
      chars: view.state.doc.length,
    });
  }
}
