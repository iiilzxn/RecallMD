// MarkdownView 受控渲染契约（设计 §161/§207）：
// 1) 原始 HTML（含 ID 锚点注释、内联事件属性）零渲染路径；
// 2) 链接策略纯函数（external/md/relative/anchor/blocked）与相对路径归一；
// 3) GFM（表格/任务列表/删除线）与引用定义解析；
// 4) 与引擎同方言（parseMarkdown 直用），frontmatter 不显示。
// node 环境：只创建 React 元素（无 DOM 渲染），结构断言走元素树。

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  classifyLinkUrl,
  extractHeadings,
  renderMarkdown,
  resolveRelativePath,
} from "../../src/ui/MarkdownView";

type AnyEl = {
  type: unknown;
  props: { children?: ReactNode; [k: string]: unknown };
};

function walk(n: ReactNode, fn: (el: AnyEl) => void): void {
  if (Array.isArray(n)) {
    n.forEach((c) => walk(c, fn));
    return;
  }
  if (!isValidElement(n)) return;
  const el = n as unknown as AnyEl;
  fn(el);
  walk(el.props.children, fn);
}

/** DFS 元素类型序列（宿主元素 type 为标签字符串） */
function tagsOf(nodes: ReactNode[]): string[] {
  const out: string[] = [];
  walk(nodes, (el) => {
    if (typeof el.type === "string") out.push(el.type);
  });
  return out;
}

/** 全文可见文本（元素 children 里的字符串拼接） */
function textOf(nodes: ReactNode[]): string {
  let s = "";
  const collect = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      n.forEach(collect);
      return;
    }
    if (typeof n === "string" || typeof n === "number") {
      s += n;
      return;
    }
    if (isValidElement(n)) collect((n as unknown as AnyEl).props.children);
  };
  collect(nodes);
  return s;
}

function find(nodes: ReactNode[], type: string): AnyEl[] {
  const out: AnyEl[] = [];
  walk(nodes, (el) => {
    if (el.type === type) out.push(el);
  });
  return out;
}

describe("链接策略 classifyLinkUrl", () => {
  it("http/https/mailto → external", () => {
    expect(classifyLinkUrl("https://a.b/c", "")).toEqual({ kind: "external", url: "https://a.b/c" });
    expect(classifyLinkUrl("HTTP://A.B", "")).toEqual({ kind: "external", url: "HTTP://A.B" });
    expect(classifyLinkUrl("mailto:x@y.z", "")).toEqual({ kind: "external", url: "mailto:x@y.z" });
  });

  it("javascript:/file: 等其余协议 → blocked", () => {
    expect(classifyLinkUrl("javascript:alert(1)", "")).toEqual({ kind: "blocked" });
    expect(classifyLinkUrl("JAVASCRIPT:x", "")).toEqual({ kind: "blocked" });
    expect(classifyLinkUrl("file:///c:/x", "")).toEqual({ kind: "blocked" });
    expect(classifyLinkUrl("vbscript:x", "")).toEqual({ kind: "blocked" });
  });

  it("相对 .md → 应用内打开（按当前文件所在目录归一，支持 ./ ../ 与锚点）", () => {
    expect(classifyLinkUrl("./b.md", "a/c")).toEqual({ kind: "md", rel: "a/c/b.md", anchor: null });
    expect(classifyLinkUrl("../b.md#sec", "a/c")).toEqual({ kind: "md", rel: "a/b.md", anchor: "sec" });
    expect(classifyLinkUrl("note.md", "")).toEqual({ kind: "md", rel: "note.md", anchor: null });
    expect(classifyLinkUrl("/root/x.md", "a")).toEqual({ kind: "md", rel: "root/x.md", anchor: null });
  });

  it("相对非 .md 资源 → relative；纯锚点 → anchor", () => {
    expect(classifyLinkUrl("img/pic.png", "a")).toEqual({ kind: "relative", href: "img/pic.png" });
    expect(classifyLinkUrl("#top", "")).toEqual({ kind: "anchor" });
    expect(classifyLinkUrl("x.md#only-anchor", "")).toEqual({
      kind: "md",
      rel: "x.md",
      anchor: "only-anchor",
    });
  });

  it("大小写不敏感的 .MD 后缀同样识别（保留原始大小写）", () => {
    expect(classifyLinkUrl("A/B.MD", "")).toEqual({ kind: "md", rel: "A/B.MD", anchor: null });
  });
});

describe("resolveRelativePath", () => {
  it("./、../、根锚与越界上溯", () => {
    expect(resolveRelativePath("a/b", "./c/d.md")).toBe("a/b/c/d.md");
    expect(resolveRelativePath("a/b", "../../x.md")).toBe("x.md");
    expect(resolveRelativePath("", "/r.md")).toBe("r.md");
    expect(resolveRelativePath("a", "../../../x.md")).toBe("x.md"); // 越界不穿越工作区根
  });
});

describe("受控渲染", () => {
  it("块级与行内原始 HTML 均零渲染：script/事件属性/ID 注释不出现在输出", () => {
    const md = [
      "<!-- rcmd: 018f2a61-9c7d-7b3e-9f11-3f2a6b9d0000 -->",
      "# 标题",
      "",
      "<script>alert(1)</script>",
      "",
      "段落 <img src=x onerror=alert(2)> 内联 <iframe src=//e></iframe> HTML",
      "",
      "<div onclick=\"go()\">块级</div>",
    ].join("\n");
    const nodes = renderMarkdown(md, { baseDir: "" });
    const tags = tagsOf(nodes);
    expect(tags).not.toContain("script");
    expect(tags).not.toContain("iframe");
    expect(tags).not.toContain("div");
    const text = textOf(nodes);
    expect(text).not.toContain("alert");
    expect(text).not.toContain("rcmd");
    expect(text).not.toContain("onerror");
    expect(text).not.toContain("块级");
    expect(text).toContain("标题");
    expect(text).toContain("内联");
  });

  it("frontmatter 与引用定义不渲染（§8.2 L258 渲染语义）", () => {
    const md = "---\ntitle: x\n---\n\n[文字][ref]\n\n[ref]: https://example.com/t \"提示\"\n";
    const nodes = renderMarkdown(md, { baseDir: "" });
    const text = textOf(nodes);
    expect(text).not.toContain("title:");
    expect(text).not.toContain("https://example.com/t"); // 定义行本体不出现（链接 title 属性另计）
    const anchors = find(nodes, "a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].props.href).toBe("https://example.com/t");
  });

  it("未定义的引用在解析期回退为字面文本（CommonMark 语义，无 <a>）", () => {
    const nodes = renderMarkdown("[文字][nope]\n", { baseDir: "" });
    expect(find(nodes, "a")).toHaveLength(0);
    expect(textOf(nodes)).toBe("[文字][nope]");
  });

  it("javascript: 链接渲染为 blocked 文本，外链渲染为拦截式 a", () => {
    const md = "[坏][1] [好][2]\n\n[1]: javascript:alert(1)\n[2]: https://ok.example/x\n";
    const nodes = renderMarkdown(md, { baseDir: "" });
    const anchors = find(nodes, "a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].props.href).toBe("https://ok.example/x");
    expect(typeof anchors[0].props.onClick).toBe("function");
    expect(textOf(nodes)).toContain("坏");
  });

  it("GFM 表格：thead/tbody、对齐样式", () => {
    const md = "| a | b | c |\n| --- | :---: | ---: |\n| 1 | 2 | 3 |\n";
    const nodes = renderMarkdown(md, { baseDir: "" });
    const tags = tagsOf(nodes);
    expect(tags).toContain("table");
    expect(tags).toContain("thead");
    expect(tags).toContain("tbody");
    const ths = find(nodes, "th");
    expect(ths).toHaveLength(3);
    expect(ths[1].props.style).toEqual({ textAlign: "center" });
    expect(ths[2].props.style).toEqual({ textAlign: "right" });
    expect(ths[0].props.style).toBeUndefined();
    const tds = find(nodes, "td");
    expect(textOf([tds[0].props.children as ReactNode])).toBe("1");
  });

  it("GFM 任务列表与删除线；紧凑列表不包 <p>", () => {
    const md = "- [x] ~~没了~~ 完成\n- [ ] 待办\n";
    const nodes = renderMarkdown(md, { baseDir: "" });
    const boxes = find(nodes, "input");
    expect(boxes).toHaveLength(2);
    expect(boxes[0].props.checked).toBe(true);
    expect(boxes[1].props.checked).toBe(false);
    expect(boxes[0].props.disabled).toBe(true);
    const tags = tagsOf(nodes);
    expect(tags).toContain("del");
    expect(tags).toContain("span"); // 紧凑列表项 md-plain（不包 <p>，否则此处会出 p）
    expect(tags).not.toContain("p");
    expect(textOf(nodes)).toContain("没了");
  });

  it("代码块保留原文与语言标记；段内软换行折叠为空格", () => {
    const md = "```js\nconst a = 1;\nif (a) {}\n```\n\n第一行\n第二行\n";
    const nodes = renderMarkdown(md, { baseDir: "" });
    const pres = find(nodes, "pre");
    expect(pres).toHaveLength(1);
    expect(pres[0].props["data-lang"]).toBe("js");
    expect(textOf([pres[0].props.children as ReactNode])).toBe("const a = 1;\nif (a) {}");
    const text = textOf(nodes);
    expect(text).toContain("第一行 第二行");
  });

  it("图片一律占位框：不产生 <img>，地址不入网络", () => {
    const md = "![替代文字](local/pic.png)\n\n![远程][r]\n\n[r]: https://cdn.example/x.png\n";
    const nodes = renderMarkdown(md, { baseDir: "" });
    expect(tagsOf(nodes)).not.toContain("img");
    const text = textOf(nodes);
    expect(text).toContain("替代文字");
    expect(text).toContain("local/pic.png");
    expect(text).toContain("https://cdn.example/x.png");
  });

  it("相对 .md 链接携带归一后的工作区路径", () => {
    const nodes = renderMarkdown("见 [下一篇](./sub/next.md#a)\n", { baseDir: "docs" });
    const anchors = find(nodes, "a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].props.href).toBe("docs/sub/next.md");
  });

  it("标题渲染携带文档偏移锚点（TOC 滚动定位用）", () => {
    const md = "# 一级\n\n## 二级\n";
    const nodes = renderMarkdown(md, { baseDir: "" });
    const h1 = find(nodes, "h1")[0];
    expect(h1.props.id).toBe(`h-${md.indexOf("# 一级")}`);
    const h2 = find(nodes, "h2")[0];
    expect(h2.props.id).toBe(`h-${md.indexOf("## 二级")}`);
  });
});

describe("目录提取 extractHeadings", () => {
  it("层级/文本/偏移；Setext 标题（=== 为 h1）计入；偏移指向标题文本起点", () => {
    const md = "---\nt: 1\n---\n\n# 一级\n\n正文\n\n## 二级\n\nSetext 标题\n===\n\n### 三级\n";
    const hs = extractHeadings(md);
    expect(hs.map((h) => [h.level, h.text])).toEqual([
      [1, "一级"],
      [2, "二级"],
      [1, "Setext 标题"],
      [3, "三级"],
    ]);
    expect(hs[0].offset).toBe(md.indexOf("# 一级"));
    expect(hs[2].offset).toBe(md.indexOf("Setext 标题"));
  });

  it("代码围栏与行内代码里的 # 不入目录（真实 AST，非行正则）", () => {
    const md = "# 真\n\n```js\n# 围栏假\n// 注释\n```\n\n`inline # 假`\n\n## 也真\n";
    const hs = extractHeadings(md);
    expect(hs.map((h) => h.text)).toEqual(["真", "也真"]);
  });

  it("空文档与无标题文档返回空数组", () => {
    expect(extractHeadings("")).toEqual([]);
    expect(extractHeadings("只有正文\n没有标题\n")).toEqual([]);
  });

  it("标题内行内标记（加粗/代码）只取纯文本", () => {
    const hs = extractHeadings("## 带 **加粗** 与 `code` 的标题\n");
    expect(hs).toHaveLength(1);
    expect(hs[0].text).toBe("带 加粗 与 code 的标题");
  });
});
