// 代码高亮纯函数（M9）：lowlight → hast → 受控 React 元素。
// 不测 DOM 渲染，只测：语言识别、hljs 类名下发、未知语言回退纯文本。

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { highlightToNodes } from "../../src/ui/CodeHighlight";

type AnyEl = {
  type: unknown;
  props: { children?: ReactNode; className?: unknown };
};

function classNamesOf(nodes: ReactNode[]): string[] {
  const out: string[] = [];
  const collect = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      n.forEach(collect);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as unknown as AnyEl;
    if (typeof el.props.className === "string") out.push(el.props.className);
    collect(el.props.children);
  };
  collect(nodes);
  return out;
}

function textOf(nodes: ReactNode[]): string {
  let s = "";
  const collect = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      n.forEach(collect);
      return;
    }
    if (typeof n === "string") {
      s += n;
      return;
    }
    if (isValidElement(n)) collect((n as unknown as AnyEl).props.children);
  };
  collect(nodes);
  return s;
}

describe("highlightToNodes", () => {
  it("识别常用语言并下发 hljs-* 类名（js → keyword）", () => {
    const { nodes, known } = highlightToNodes("const a = 1;", "js");
    expect(known).toBe(true);
    const cls = classNamesOf(nodes);
    expect(cls).toContain("hljs-keyword");
    expect(textOf(nodes)).toBe("const a = 1;"); // 文本零损耗
  });

  it("别名归一：大写/空白语言名可识别", () => {
    expect(highlightToNodes("let x", "  TS ").known).toBe(true);
    expect(highlightToNodes("let x", "JavaScript").known).toBe(true);
  });

  it("未注册语言回退纯文本（known=false，无类名）", () => {
    const { nodes, known } = highlightToNodes("任意文本", "not-a-lang");
    expect(known).toBe(false);
    expect(classNamesOf(nodes)).toHaveLength(0);
    expect(textOf(nodes)).toBe("任意文本");
  });

  it("空语言名回退纯文本", () => {
    const { known } = highlightToNodes("x", "");
    expect(known).toBe(false);
    expect(highlightToNodes("x", null).known).toBe(false);
  });

  it("多行代码逐行结构保留换行", () => {
    const { nodes } = highlightToNodes("if (a) {\n  return;\n}", "js");
    expect(textOf(nodes)).toBe("if (a) {\n  return;\n}");
  });
});
