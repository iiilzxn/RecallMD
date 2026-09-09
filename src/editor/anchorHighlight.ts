// ID 注释弱色高亮（设计 §7.3 L211）：源码中正常可见、以弱色呈现；预览不显示（M6 渲染层处理）。
//
// 用 ViewPlugin 在视口内逐行匹配协议正则（正则单一来源：engine/ids），
// 不用 StateField 存引擎范围：报告只对已保存版本有效，StateField 会随按键立即失真、
// 需要维护 ChangeSet 映射；视口正则扫描局部自洽，Undo/继续输入零维护，
// 符合“Undo 恢复内容后须重解析，不能盲用旧范围”。

import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { PROTOCOL_LINE_RE } from "../engine/ids";

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: ReturnType<ReturnType<typeof Decoration.line>["range"]>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      if (PROTOCOL_LINE_RE.test(line.text)) {
        ranges.push(Decoration.line({ class: "cm-recall-anchor" }).range(line.from));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges); // 视口升序扫描，range 天然有序
}

export const anchorHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
