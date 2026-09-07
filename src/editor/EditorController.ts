// EditorController：持有 CM 实例与交互边界（设计 §6.1/§7.3 的 M1 实现）。
// React 不逐按键同步全文；全文读取只在保存/解析边界（§15.2）。

import { EditorState, type Extension } from "@codemirror/state";
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
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

export interface CursorInfo {
  line: number; // 1 起
  col: number; // 1 起
  lines: number;
  chars: number;
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
      markdown({ base: markdownLanguage }),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (this.cbs.onSave(), true) },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        // 闭包读实例字段，replaceDoc 的 suppress 生效于事件时点
        if (u.docChanged && !this.suppressChange) this.cbs.onDocChanged();
        if (u.selectionSet || u.docChanged) this.reportCursor();
      }),
      EditorView.domEventHandlers({
        compositionstart: () => this.cbs.onCompositionStart(),
        compositionend: () => this.cbs.onCompositionEnd(),
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
