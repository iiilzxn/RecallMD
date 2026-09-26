// MarkdownView 受控渲染契约（设计 §161/§207；M9 扩展渲染）：
// 1) 原始 HTML（含 ID 锚点注释、内联事件属性）零渲染路径——白名单标签
//    （sub/sup/kbd/br 行内、details/summary 块级）反解析为受控元素属唯一例外；
// 2) 链接策略纯函数（external/md/relative/anchor/blocked）与相对路径归一；
// 3) GFM（表格/任务列表/删除线/脚注）与引用定义解析；
// 4) 与引擎同方言（parseMarkdown 直用），frontmatter 不显示；
// 5) M9：==高亮==、脚注编号跳转、文内锚点 slug、本地图片（resolveImage 注入）、
//    defsText 携带全文定义（复习场景 §7.2 L197）、mermaid/代码高亮走懒加载组件。
// node 环境：只创建 React 元素（无 DOM 渲染），结构断言走元素树；懒加载组件
// 只创建 lazy 元素不触发 import。

import { createElement, isValidElement, Suspense, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  classifyLinkUrl,
  createSlugger,
  extractHeadings,
  renderMarkdown,
  resolveRelativePath,
  slugify,
  splitMarkText,
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

function find(nodes: ReactNode[] | AnyEl[], type: string): AnyEl[] {
  const out: AnyEl[] = [];
  walk(nodes as ReactNode[], (el) => {
    if (el.type === type) out.push(el);
  });
  return out;
}

/** 按类名找元素（精确匹配） */
function findByClass(nodes: ReactNode[] | AnyEl[], cls: string): AnyEl[] {
  const out: AnyEl[] = [];
  walk(nodes as ReactNode[], (el) => {
    if (typeof el.type === "string" && el.props.className === cls) {
      out.push(el);
    }
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

  it("相对非 .md 资源 → relative；纯锚点 → anchor（携带片段）", () => {
    expect(classifyLinkUrl("img/pic.png", "a")).toEqual({ kind: "relative", href: "img/pic.png" });
    expect(classifyLinkUrl("#top", "")).toEqual({ kind: "anchor", frag: "top" });
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

describe("标题锚点 slug", () => {
  it("slugify：小写、去标点、空白折叠为 -，中文保留", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("二级 标题!")).toBe("二级-标题");
    expect(slugify("C++ 与 C#")).toBe("c-与-c");
    expect(slugify("  多  空白  ")).toBe("多-空白");
  });

  it("createSlugger：同文去重加 -2/-3", () => {
    const slugger = createSlugger();
    expect(slugger("标题")).toBe("标题");
    expect(slugger("标题")).toBe("标题-2");
    expect(slugger("标题")).toBe("标题-3");
    expect(slugger("其他")).toBe("其他");
  });

  it("extractHeadings 携带 slug", () => {
    const hs = extractHeadings("# Hello World\n\n## 标题\n\n## 标题\n");
    expect(hs.map((h) => h.slug)).toEqual(["hello-world", "标题", "标题-2"]);
  });

  it("标题元素 id = 前缀 + slug（多实例防撞）", () => {
    const nodes = renderMarkdown("# Hello World\n", { baseDir: "", idPrefix: "t9" });
    const h1 = find(nodes, "h1")[0];
    expect(h1.props.id).toBe("t9hello-world");
  });

  it("文内锚点链接：无导航器时为不可点 span；有导航器时为可点 a", () => {
    const plain = renderMarkdown("见 [下文](#hello-world)\n", { baseDir: "" });
    expect(find(plain, "a")).toHaveLength(0);
    expect(findByClass(plain, "md-link-anchor")).toHaveLength(1);

    const nav = renderMarkdown("见 [下文](#hello-world)\n", {
      baseDir: "",
      idPrefix: "p",
      navigateAnchor: () => {},
    });
    const anchors = find(nav, "a");
    expect(anchors).toHaveLength(1);
    expect(typeof anchors[0].props.onClick).toBe("function");
  });
});

describe("==高亮==（text 节点呈现层拆分）", () => {
  it("splitMarkText：成对高亮、不成对保留原样、内侧空白不成对", () => {
    expect(splitMarkText("a ==考点== b")).toEqual([
      { text: "a ", mark: false },
      { text: "考点", mark: true },
      { text: " b", mark: false },
    ]);
    expect(splitMarkText("a == b")).toEqual([{ text: "a == b", mark: false }]);
    expect(splitMarkText("== 两端空白 ==")).toEqual([{ text: "== 两端空白 ==", mark: false }]);
    expect(splitMarkText("==a==")).toEqual([{ text: "a", mark: true }]);
  });

  it("渲染为 <mark>，等号不残留", () => {
    const nodes = renderMarkdown("普通 ==重点句== 后续\n", { baseDir: "" });
    const marks = find(nodes, "mark");
    expect(marks).toHaveLength(1);
    expect(textOf([marks[0].props.children as ReactNode])).toBe("重点句");
    expect(textOf(nodes)).not.toContain("==");
  });

  it("行内代码里的 == 不受影响", () => {
    const nodes = renderMarkdown("`a == b`\n", { baseDir: "" });
    expect(find(nodes, "mark")).toHaveLength(0);
    expect(textOf(nodes)).toContain("a == b");
  });
});

describe("脚注（GFM footnotes）", () => {
  const md = "正文一[^a] 与正文二[^b]，再次[^a]。\n\n[^a]: 第一条脚注\n[^b]: 第二条**加粗**脚注\n";

  it("引用按首次出现顺序编号；定义集中到文末脚注区", () => {
    const nodes = renderMarkdown(md, { baseDir: "", idPrefix: "q" });
    const sups = findByClass(nodes, "md-fnref");
    // 无导航器：sup 内是编号文本
    expect(sups.map((s) => textOf([s.props.children as ReactNode]))).toEqual(["1", "2", "1"]);
    const section = findByClass(nodes, "md-footnotes");
    expect(section).toHaveLength(1);
    const lis = find(section, "li");
    expect(lis).toHaveLength(2);
    expect(lis[0].props.id).toBe("qfn-1");
    expect(textOf(nodes)).toContain("第一条脚注");
    expect(textOf(nodes)).not.toContain("[^a]");
  });

  it("有导航器时引用可点跳转，首引用携带回链目标 id，脚注区有回链", () => {
    const nodes = renderMarkdown(md, { baseDir: "", idPrefix: "q", navigateId: () => {} });
    const refs = find(nodes, "a").filter((a) => (a.props.href as string).startsWith("#qfn-"));
    expect(refs).toHaveLength(3);
    expect(refs[0].props.id).toBe("qfnref-1"); // 首次出现
    expect(refs[2].props.id).toBeUndefined(); // 重复引用不重复占 id
    const backrefs = findByClass(nodes, "md-backref");
    expect(backrefs).toHaveLength(2);
    expect(backrefs[0].props.href).toBe("#qfnref-1");
  });

  it("复习片段：定义不在片段内 → 未携带 defsText 时回退字面文本，携带后编号补齐（§7.2 L197）", () => {
    const frag = "只有引用[^x] 的片段\n";
    // GFM 语义：未定义的脚注引用解析期即回退字面文本（无编号/无脚注区）
    const missing = renderMarkdown(frag, { baseDir: "" });
    expect(findByClass(missing, "md-fnref")).toHaveLength(0);
    expect(textOf(missing)).toContain("[^x]");

    const carried = renderMarkdown(frag, {
      baseDir: "",
      defsText: frag + "\n[^x]: 片段外的定义\n",
    });
    expect(findByClass(carried, "md-fnref")).toHaveLength(1);
    expect(textOf(carried)).toContain("片段外的定义");
    expect(textOf(carried)).not.toContain("[^x]");
  });

  it("defsText 同样携带引用式链接定义", () => {
    const frag = "见 [文字][ref]\n";
    const carried = renderMarkdown(frag, { baseDir: "", defsText: "[ref]: https://example.com/x\n" });
    const anchors = find(carried, "a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].props.href).toBe("https://example.com/x");
  });
});

describe("受限 HTML 白名单", () => {
  it("行内 sub/sup/kbd 成对反解析；br 生效", () => {
    const nodes = renderMarkdown("H<sub>2</sub>O 与 x<sup>n</sup> 与 <kbd>Ctrl</kbd> 行尾<br>下一行\n", {
      baseDir: "",
    });
    expect(find(nodes, "sub")).toHaveLength(1);
    expect(find(nodes, "sup")).toHaveLength(1);
    const kbd = find(nodes, "kbd");
    expect(kbd).toHaveLength(1);
    expect(kbd[0].props.className).toBe("md-kbd");
    expect(find(nodes, "br")).toHaveLength(1);
    expect(textOf(nodes)).toContain("H2O");
    expect(textOf(nodes)).not.toContain("<sub>");
  });

  it("未闭合的白名单标签按不存在处理，内容不丢", () => {
    const nodes = renderMarkdown("H<sub>2 未闭合\n", { baseDir: "" });
    expect(find(nodes, "sub")).toHaveLength(0);
    expect(textOf(nodes)).toContain("H2 未闭合");
  });

  it("块级 details/summary：单块与跨块（空行分隔）都成折叠块，内部 Markdown 渲染", () => {
    const single = renderMarkdown(
      "<details><summary>提示</summary>**加粗** 内容</details>\n",
      { baseDir: "" },
    );
    const d1 = find(single, "details");
    expect(d1).toHaveLength(1);
    expect(textOf([d1[0].props.children as ReactNode])).toContain("加粗");
    expect(find(single, "strong")).toHaveLength(1);
    const s1 = find(single, "summary");
    expect(textOf([s1[0].props.children as ReactNode])).toBe("提示");

    const multi = renderMarkdown(
      "<details>\n<summary>多块</summary>\n\n- 列表项\n\n</details>\n",
      { baseDir: "" },
    );
    const d2 = find(multi, "details");
    expect(d2).toHaveLength(1);
    expect(find(multi, "li")).toHaveLength(1);
  });

  it("details 的 open 属性透传；其余属性丢弃", () => {
    const nodes = renderMarkdown(
      '<details open onclick="x()"><summary>a</summary>b</details>\n',
      { baseDir: "" },
    );
    const d = find(nodes, "details")[0];
    expect(d.props.open).toBe(true);
  });

  it("白名单外标签照旧零渲染：script/iframe/div/事件属性不出现", () => {
    const md = [
      "<script>alert(1)</script>",
      "",
      '段落 <img src=x onerror=alert(2)> 与 <iframe src=//e></iframe>',
      "",
      '<div onclick="go()">块级</div>',
    ].join("\n");
    const nodes = renderMarkdown(md, { baseDir: "" });
    const tags = tagsOf(nodes);
    for (const t of ["script", "iframe", "div", "img"]) expect(tags).not.toContain(t);
    expect(textOf(nodes)).not.toContain("alert");
    expect(textOf(nodes)).not.toContain("块级");
  });
});

describe("图片（M9 本地图片策略）", () => {
  it("无 resolveImage 时相对路径仍为占位框（不产生 <img>）", () => {
    const nodes = renderMarkdown("![替代](pic.png)\n", { baseDir: "docs" });
    expect(find(nodes, "img")).toHaveLength(0);
    expect(findByClass(nodes, "md-img")).toHaveLength(1);
    expect(textOf(nodes)).toContain("docs/pic.png"); // 归一后的工作区相对路径
  });

  it("注入 resolveImage 后渲染 <img>（相对路径按 baseDir 归一）", () => {
    const nodes = renderMarkdown("![替代](./img/pic.png)\n", {
      baseDir: "docs",
      resolveImage: (rel) => `asset://${rel}`,
    });
    const imgs = find(nodes, "img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].props.src).toBe("asset://docs/img/pic.png");
    expect(imgs[0].props.alt).toBe("替代");
    expect(imgs[0].props.loading).toBe("lazy");
  });

  it("data:image 直接显示；http(s) 远程图不加载（占位框提示）", () => {
    const nodes = renderMarkdown(
      "![i](data:image/png;base64,AAAA) ![r](https://cdn.example/x.png)\n",
      { baseDir: "", resolveImage: () => null },
    );
    const imgs = find(nodes, "img");
    expect(imgs).toHaveLength(1); // 仅 data:
    expect(imgs[0].props.src).toContain("data:image/png");
    expect(findByClass(nodes, "md-img")).toHaveLength(1); // 远程占位
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

  it("代码块保留语言标记；mermaid 围栏走懒加载组件（fallback 承载源码）", () => {
    const md = "```js\nconst a = 1;\n```\n\n```mermaid\ngraph TD\nA-->B\n```\n";
    const nodes = renderMarkdown(md, { baseDir: "" });
    // js 块：真实 pre[data-lang]，内部是 Suspense 包裹的懒加载高亮组件
    const pres = find(nodes, "pre");
    expect(pres.map((p) => p.props["data-lang"])).toEqual(["js"]);
    // mermaid 块：Suspense 在外层，主树无 pre；fallback（加载中）与懒组件 props 携带源码
    const suspenses: AnyEl[] = [];
    walk(nodes, (el) => {
      if (el.type === Suspense) suspenses.push(el);
    });
    expect(suspenses).toHaveLength(2);
    const mermaidSuspense = suspenses[1];
    const fallback = mermaidSuspense.props.fallback as AnyEl;
    expect(fallback.props["data-lang"]).toBe("mermaid");
    const lazyChild = mermaidSuspense.props.children as AnyEl;
    expect(lazyChild.props.code).toBe("graph TD\nA-->B");
  });

  it("段内软换行折叠为空格", () => {
    const nodes = renderMarkdown("第一行\n第二行\n", { baseDir: "" });
    expect(textOf(nodes)).toContain("第一行 第二行");
  });

  it("相对 .md 链接携带归一后的工作区路径", () => {
    const nodes = renderMarkdown("见 [下一篇](./sub/next.md#a)\n", { baseDir: "docs" });
    const anchors = find(nodes, "a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].props.href).toBe("docs/sub/next.md");
  });
});

describe("目录提取 extractHeadings", () => {
  it("标题操作按原文位置区分同名小节，并保留锚点；引用和代码中的标题不附加操作", () => {
    const text = "## 同名\n\n第一段\n\n> ## 引用\n\n```md\n## 代码\n```\n\n## 同名\n\n第二段\n";
    const seen: number[] = [];
    const nodes = renderMarkdown(text, { baseDir: "", renderHeadingActions: (heading) => {
      seen.push(heading.offset);
      return createElement("button", { type: "button" }, "+");
    } });
    expect(seen).toEqual([0, text.lastIndexOf("## 同名")]);
    expect(findByClass(nodes, "md-heading-with-actions")).toHaveLength(2);
    expect(find(nodes, "button")).toHaveLength(2);
    const headings = find(nodes, "h2");
    expect(headings.filter((h) => h.props.id).map((h) => h.props.id)).toEqual(["同名", "同名-2"]);
    expect(headings.filter((h) => h.props.id).map((h) => h.props["data-offset"])).toEqual(seen);
    // 复习渲染不提供此回调，因此不会附带加号、标签或答案。
    expect(find(renderMarkdown(text, { baseDir: "" }), "button")).toHaveLength(0);
  });
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
