// 受控 Markdown 渲染组件（设计 §161/§207；M9 扩展渲染能力）。
// 复用引擎 parseMarkdown（remark-parse+gfm+frontmatter），预览/复习与划块同方言（§8）；
// 安全性：html 节点默认零渲染（含 ID 锚点注释）与 frontmatter 不渲染；
// 全程不使用 dangerouslySetInnerHTML——唯一例外见 MermaidBlock（DOMPurify 消毒后注入 SVG，§161 修订）。
// M9 起：mermaid 图表 / 预览代码高亮（均为 lazy 按需加载）、本地图片（asset 协议，由
// 宿主注入 resolveImage，渲染层保持 UI 无关可测）、==高亮==、脚注编号跳转、文内锚点、
// 受限 HTML 白名单（sub/sup/kbd/br 行内 + details/summary 块级，反解析为受控元素，不放开任意 HTML）。
// 链接策略（§161）：相对 .md 链接在应用内打开；http(s)/mailto 只提示不在 WebView 内导航；
// javascript: 等其余协议渲染为不可点文本。远程图片不自动加载（离线原则）；
// data:image 与工作区相对路径图片可显示。
//
// 所有扩展均为渲染层实现（不改动 mdast / 引擎指纹）：mermaid 是 code 围栏的呈现方式，
// ==高亮== 是 text 节点的呈现拆分——block 划界与 body_hash 语义完全不变。

import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useId,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { buildDefinitionMap, normalizeTextValue } from "../engine/fingerprint";
import { extractText, parseMarkdown, type MdNode, type MdRoot } from "../engine/segment";

// 按需加载（不进主包；node 测试只创建 lazy 元素不触发 import）
const MermaidBlock = lazy(() => import("./MermaidBlock"));
const CodeHighlight = lazy(() => import("./CodeHighlight"));

// --- 链接策略（纯函数，测试覆盖） ---

export type LinkTarget =
  | { kind: "external"; url: string } // http/https/mailto：拦截点击，仅提示
  | { kind: "md"; rel: string; anchor: string | null } // 工作区内 .md：应用内打开
  | { kind: "relative"; href: string } // 相对非 .md 资源：仅提示
  | { kind: "anchor"; frag: string } // 文内 #锚点：容器内滚动（无导航器时不可点）
  | { kind: "blocked" }; // javascript: 等其余协议：不可点

/** 相对路径归一（baseDir 为当前文件所在目录，"" 表示根） */
export function resolveRelativePath(baseDir: string, href: string): string {
  const joined = href.startsWith("/") ? href.slice(1) : baseDir ? `${baseDir}/${href}` : href;
  const out: string[] = [];
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

export function classifyLinkUrl(url: string, baseDir: string): LinkTarget {
  const u = url.trim();
  if (u.startsWith("#")) return { kind: "anchor", frag: u.slice(1) };
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s === "http" || s === "https" || s === "mailto") return { kind: "external", url: u };
    return { kind: "blocked" };
  }
  const hashIdx = u.indexOf("#");
  const path = hashIdx >= 0 ? u.slice(0, hashIdx) : u;
  const anchor = hashIdx >= 0 ? u.slice(hashIdx + 1) : null;
  if (!path) return { kind: "anchor", frag: u.slice(1) };
  const rel = resolveRelativePath(baseDir, path);
  if (rel.toLowerCase().endsWith(".md")) return { kind: "md", rel, anchor };
  return { kind: "relative", href: u };
}

// --- 标题锚点 slug（GitHub 风格：小写、去标点、空白折叠为 -，去重加 -2/-3） ---

export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string): string => {
    let s = slugify(text);
    if (!s) s = "section";
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    return n === 0 ? s : `${s}-${n + 1}`;
  };
}

// --- ==高亮==（Obsidian 风格，text 节点呈现层拆分；== 内侧不能贴空白/等号） ---

export interface MarkPiece {
  text: string;
  mark: boolean;
}

const MARK_RE = /==(?=[^\s=])([\s\S]*?[^\s=])==/g;

export function splitMarkText(v: string): MarkPiece[] {
  const out: MarkPiece[] = [];
  let last = 0;
  MARK_RE.lastIndex = 0;
  for (let m = MARK_RE.exec(v); m; m = MARK_RE.exec(v)) {
    if (m.index > last) out.push({ text: v.slice(last, m.index), mark: false });
    out.push({ text: m[1], mark: true });
    last = m.index + m[0].length;
  }
  if (last < v.length) out.push({ text: v.slice(last), mark: false });
  return out;
}

// --- 受限 HTML 白名单（§161 修订：白名单反解析为受控元素，仍无任意 HTML 路径） ---

type InlineHtmlMatch = { tag: string; close: boolean } | { br: true } | null;

function matchInlineHtml(v: string): InlineHtmlMatch {
  const t = v.trim();
  if (/^<br\s*\/?>$/i.test(t) || /^<\/br\s*>$/i.test(t)) return { br: true };
  const m = /^<(\/?)(sub|sup|kbd)\s*>$/i.exec(t);
  if (!m) return null;
  return { tag: m[2].toLowerCase(), close: m[1] === "/" };
}

/** details 块开chunk 解析：返回 null 表示不是 details 开头（按普通 html 丢弃） */
interface DetailsOpen {
  openAttr: boolean;
  /** <summary> 内的原始文本（无则 null） */
  summaryText: string | null;
  /** 起始标签之后的原始内容（可能已含闭合标签） */
  inner: string;
  closed: boolean;
}

function parseDetailsOpen(v: string): DetailsOpen | null {
  const t = v.trim();
  if (!/^<details\b/i.test(t)) return null;
  const openAttr = /^<details\b[^>]*\bopen\b/i.test(t);
  let inner = t.replace(/^<details\b[^>]*>/i, "");
  let closed = false;
  if (/<\/details>\s*$/i.test(inner)) {
    inner = inner.replace(/<\/details>\s*$/i, "");
    closed = true;
  }
  const sm = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(inner);
  if (!sm) return { openAttr, summaryText: null, inner, closed };
  return {
    openAttr,
    summaryText: sm[1],
    inner: inner.slice(sm.index + sm[0].length),
    closed,
  };
}

// --- 渲染上下文 ---

export interface MarkdownCtx {
  defs: ReturnType<typeof buildDefinitionMap>;
  baseDir: string;
  /** 容器内锚点 id 前缀（多实例防撞；纯函数调用可传 ""） */
  idPrefix: string;
  /** 根级标题 offset → slug（锚点跳转目标） */
  headingSlugs: Map<number, string>;
  /** 脚注 identifier → 序号（按引用首次出现顺序） */
  fnIndex: Map<string, number>;
  /** 脚注 identifier → 定义节点（含 defsText 携带的全文定义，§7.2 L197） */
  fnDefs: Map<string, MdNode>;
  /** 已标注 fnref 链接 id 的脚注（首引用处放回链目标） */
  fnSeen: Set<string>;
  /** 工作区相对路径图片 → asset URL（宿主注入；无则占位框） */
  resolveImage?: (rel: string) => string | null;
  onOpenRelative?: (rel: string) => void;
  onExternalLink?: (url: string) => void;
  /** 容器内按精确 id 滚动（脚注） */
  navigateId?: (id: string) => void;
  /** 容器内按锚点片段滚动（#锚点，尝试 slug 与原文两种 id） */
  navigateAnchor?: (frag: string) => void;
  renderHeadingActions?: (heading: TocHeading) => ReactNode;
}

/** 外链/相对资源点击：永不放行 WebView 导航；能处理的交给回调 */
function onLinkActivate(e: ReactMouseEvent, target: LinkTarget, ctx: MarkdownCtx): void {
  e.preventDefault();
  if (target.kind === "md" && ctx.onOpenRelative) ctx.onOpenRelative(target.rel);
  else if (target.kind === "external") ctx.onExternalLink?.(target.url);
  else if (target.kind === "relative") ctx.onExternalLink?.(target.href);
}

const keyOf = (n: MdNode, i: number): string => `${n.position?.start?.offset ?? i}`;

// --- 行内节点 ---

function renderText(v: string, key: string): ReactNode {
  const normalized = normalizeTextValue(v);
  const pieces = splitMarkText(normalized);
  if (pieces.length === 1 && !pieces[0].mark) return normalized;
  return pieces.map((p, i) => (p.mark ? <mark key={`${key}-m${i}`}>{p.text}</mark> : p.text));
}

function wrapInlineTag(tag: string, inner: ReactNode[], key: string): ReactNode {
  if (tag === "sub") return <sub key={key}>{inner}</sub>;
  if (tag === "sup") return <sup key={key}>{inner}</sup>;
  return <kbd key={key} className="md-kbd">{inner}</kbd>;
}

function renderInline(n: MdNode, i: number, ctx: MarkdownCtx): ReactNode {
  const key = keyOf(n, i);
  switch (n.type) {
    case "text":
      return renderText(n.value ?? "", key);
    case "emphasis":
      return <em key={key}>{renderSeq(n.children ?? [], ctx)}</em>;
    case "strong":
      return <strong key={key}>{renderSeq(n.children ?? [], ctx)}</strong>;
    case "delete":
      return <del key={key}>{renderSeq(n.children ?? [], ctx)}</del>;
    case "inlineCode":
      return <code key={key}>{n.value ?? ""}</code>;
    case "break":
      return <br key={key} />;
    case "footnoteReference": {
      const ident = n.identifier ?? "";
      const idx = ctx.fnIndex.get(ident);
      if (idx == null) {
        // 引用未被编号（理论上不会发生，防御性兜底）：原样弱化展示
        return (
          <sup key={key} className="md-fnref" title="脚注">
            {n.label ?? ""}
          </sup>
        );
      }
      const id = `${ctx.idPrefix}fnref-${idx}`;
      const first = !ctx.fnSeen.has(ident);
      if (first) ctx.fnSeen.add(ident);
      const href = `#${ctx.idPrefix}fn-${idx}`;
      return (
        <sup key={key} className="md-fnref">
          {ctx.navigateId ? (
            <a
              id={first ? id : undefined}
              href={href}
              title="查看脚注"
              onClick={(e) => {
                e.preventDefault();
                ctx.navigateId?.(`${ctx.idPrefix}fn-${idx}`);
              }}
            >
              {idx}
            </a>
          ) : (
            idx
          )}
        </sup>
      );
    }
    case "html":
      return null; // 行内原始 HTML：白名单标签由 renderSeq 成对处理，其余不渲染（§161）
    case "link":
    case "linkReference": {
      // 注：未定义的引用 micromark 在解析期即回退为字面文本（不产生 linkReference 节点），
      // 此处的 def 缺失分支只是防御性兜底。
      const def = n.type === "linkReference" ? ctx.defs.get(n.identifier ?? "") : null;
      if (n.type === "linkReference" && !def) return <span key={key}>{renderSeq(n.children ?? [], ctx)}</span>;
      const raw = n.type === "link" ? n.url ?? "" : def!.url;
      return renderAnchor(raw, def?.title ?? n.title ?? null, key, renderSeq(n.children ?? [], ctx), ctx);
    }
    case "image":
    case "imageReference": {
      const def = n.type === "imageReference" ? ctx.defs.get(n.identifier ?? "") : null;
      const url = n.type === "image" ? n.url ?? "" : def?.url ?? "";
      const alt = n.alt ?? "";
      return renderImage(url, def?.title ?? n.title ?? null, alt, key, ctx);
    }
    default:
      return n.children ? renderSeq(n.children, ctx) : renderText(n.value ?? "", key);
  }
}

/** 图片：工作区相对路径（宿主注入 resolveImage 时）与 data:image 显示；
 *  远程 http(s) 不自动加载（离线原则）；其余占位框。 */
function renderImage(
  url: string,
  title: string | null,
  alt: string,
  key: string,
  ctx: MarkdownCtx,
): ReactNode {
  const u = url.trim();
  if (u.toLowerCase().startsWith("data:image/")) {
    // 内联数据不产生网络请求；img 上下文不执行脚本/SVG 动画外资源
    return <img key={key} src={u} alt={alt} title={title ?? undefined} className="md-img-real" />;
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
  if (!scheme) {
    // 相对路径 → 工作区内解析
    const rel = resolveRelativePath(ctx.baseDir, u);
    const src = ctx.resolveImage?.(rel);
    if (src) {
      return (
        <img
          key={key}
          src={src}
          alt={alt}
          title={title ?? rel}
          loading="lazy"
          className="md-img-real"
        />
      );
    }
    return (
      <span key={key} className="md-img" title={`图片（未提供本地解析）：${rel || "（空地址）"}`}>
        <span aria-hidden>🖼</span>
        {alt || "（无描述图片）"}
        {rel && <code>{rel}</code>}
      </span>
    );
  }
  if (scheme[1].toLowerCase() === "http" || scheme[1].toLowerCase() === "https") {
    return (
      <span key={key} className="md-img" title={`远程图片（默认不自动加载）：${u}`}>
        <span aria-hidden>🖼</span>
        {alt || "（无描述图片）"}
        <code>{u}</code>
      </span>
    );
  }
  return (
    <span key={key} className="md-img" title={`图片协议不支持：${u}`}>
      <span aria-hidden>🖼</span>
      {alt || "（无描述图片）"}
      {u && <code>{u}</code>}
    </span>
  );
}

/**
 * 行内子节点序列渲染：处理白名单标签的跨节点成对（<sub>2</sub> 在 mdast 里是
 * html("<sub>") + text("2") + html("</sub>") 三个兄弟节点）。
 * 未闭合的白名单标签按“标签不存在”处理，子内容原样渲染。
 */
function renderSeq(nodes: MdNode[], ctx: MarkdownCtx): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < nodes.length) {
    const c = nodes[i];
    if (c.type === "html") {
      const m = matchInlineHtml(c.value ?? "");
      if (m) {
        if ("br" in m) {
          out.push(<br key={keyOf(c, i)} />);
          i += 1;
          continue;
        }
        if (!m.close) {
          const inner: MdNode[] = [];
          let j = i + 1;
          let closed = false;
          while (j < nodes.length) {
            const d = nodes[j];
            if (d.type === "html") {
              const dm = matchInlineHtml(d.value ?? "");
              if (dm && !("br" in dm) && dm.close && dm.tag === m.tag) {
                closed = true;
                break;
              }
            }
            inner.push(d);
            j += 1;
          }
          if (closed) {
            out.push(wrapInlineTag(m.tag, renderSeq(inner, ctx), keyOf(c, i)));
            i = j + 1;
            continue;
          }
        }
      }
    }
    out.push(renderInline(c, i, ctx));
    i += 1;
  }
  return out;
}

function inlines(n: MdNode, ctx: MarkdownCtx): ReactNode[] {
  return renderSeq(n.children ?? [], ctx);
}

function renderAnchor(
  raw: string,
  title: string | null,
  key: string,
  children: ReactNode,
  ctx: MarkdownCtx,
): ReactNode {
  const target = classifyLinkUrl(raw, ctx.baseDir);
  if (target.kind === "blocked") {
    return (
      <span key={key} className="md-link-blocked" title="链接协议被禁用">
        {children}
      </span>
    );
  }
  if (target.kind === "anchor") {
    if (!ctx.navigateAnchor) {
      return (
        <span key={key} className="md-link-anchor" title="文内锚点（本容器不可跳转）">
          {children}
        </span>
      );
    }
    return (
      <a
        key={key}
        href={`#${slugify(target.frag)}`}
        className="md-link-anchor"
        title={`跳转到 ${target.frag}`}
        onClick={(e) => {
          e.preventDefault();
          ctx.navigateAnchor?.(target.frag);
        }}
      >
        {children}
      </a>
    );
  }
  if (target.kind === "md") {
    return (
      <a
        key={key}
        href={target.rel}
        className="md-int"
        title={`打开 ${target.rel}${target.anchor ? "#"+target.anchor : ""}`}
        onClick={(e) => onLinkActivate(e, target, ctx)}
      >
        {children}
      </a>
    );
  }
  // external / relative：统一拦截，不在 WebView 内导航
  const hint =
    target.kind === "external"
      ? `${target.url}（外链：请在系统浏览器打开）`
      : `${target.href}（相对资源：本版不打开）`;
  return (
    <a
      key={key}
      href={target.kind === "external" ? target.url : target.href}
      className="md-ext"
      title={title ?? hint}
      onClick={(e) => onLinkActivate(e, target, ctx)}
    >
      {children}
    </a>
  );
}

// --- 块级节点 ---

function renderBlock(n: MdNode, i: number, ctx: MarkdownCtx): ReactNode {
  const key = keyOf(n, i);
  switch (n.type) {
    case "yaml":
    case "definition":
      return null; // frontmatter / 引用定义不渲染（§161/§211/§8.2 L258）
    case "html":
      return null; // 原始 HTML 块（含 ID 注释）不渲染；details/summary 由 renderBlockSeq 成对处理
    case "footnoteDefinition":
      return null; // 脚注定义统一渲染到文末脚注区（见 renderMarkdown）
    case "heading": {
      const Tag = `h${Math.min(Math.max(n.depth ?? 1, 1), 6)}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      const off = n.position?.start?.offset;
      const slug = off != null ? ctx.headingSlugs.get(off) : undefined;
      const heading = (
        <Tag key={key} id={slug ? `${ctx.idPrefix}${slug}` : undefined} data-offset={off != null ? off : undefined}>
          {inlines(n, ctx)}
        </Tag>
      );
      const actions = slug != null && off != null
        ? ctx.renderHeadingActions?.({ offset: off, level: n.depth ?? 1, text: extractText(n).trim(), slug })
        : null;
      return actions ? <div key={key} className="md-heading-with-actions" data-level={n.depth ?? 1}>
        {heading}{actions}
      </div> : heading;
    }
    case "paragraph":
      return <p key={key}>{inlines(n, ctx)}</p>;
    case "thematicBreak":
      return <hr key={key} />;
    case "blockquote":
      return <blockquote key={key}>{renderBlockSeq(n.children ?? [], ctx)}</blockquote>;
    case "list": {
      const items = n.children ?? [];
      const isTask = items.some((li) => li.checked != null);
      const Tag = n.ordered ? "ol" : "ul";
      const start = n.ordered && n.start != null && n.start !== 1 ? n.start : undefined;
      return (
        <Tag key={key} className={isTask ? "md-task-list" : undefined} start={start}>
          {items.map((li, j) => (
            <li key={keyOf(li, j)}>
              {li.checked != null && (
                <input type="checkbox" checked={li.checked} disabled readOnly />
              )}
              {/* 紧凑列表不包 <p>，避免行距虚高（CommonMark spread 语义） */}
              {li.spread === false
                ? (li.children ?? []).map((c, k) =>
                    c.type === "paragraph" ? (
                      <span key={keyOf(c, k)} className="md-plain">
                        {inlines(c, ctx)}
                      </span>
                    ) : (
                      renderBlock(c, k, ctx)
                    ),
                  )
                : renderBlockSeq(li.children ?? [], ctx)}
            </li>
          ))}
        </Tag>
      );
    }
    case "code": {
      const lang = (n.lang ?? "").trim();
      const value = n.value ?? "";
      if (lang.toLowerCase() === "mermaid") {
        return (
          <Suspense
            key={key}
            fallback={
              <pre data-lang="mermaid">
                <code>{value}</code>
              </pre>
            }
          >
            <MermaidBlock code={value} />
          </Suspense>
        );
      }
      return (
        <pre key={key} data-lang={lang || undefined}>
          <Suspense fallback={<code>{value}</code>}>
            <CodeHighlight code={value} lang={lang || null} />
          </Suspense>
        </pre>
      );
    }
    case "table": {
      const rows = n.children ?? [];
      const align = n.align ?? [];
      const cellStyle = (a: "left" | "right" | "center" | null | undefined) =>
        a ? ({ textAlign: a } as const) : undefined;
      const [head, ...body] = rows;
      return (
        <table key={key}>
          {head && (
            <thead>
              <tr>
                {(head.children ?? []).map((c, j) => (
                  <th key={keyOf(c, j)} style={cellStyle(align[j])}>
                    {inlines(c, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          {body.length > 0 && (
            <tbody>
              {body.map((r, j) => (
                <tr key={keyOf(r, j)}>
                  {(r.children ?? []).map((c, k) => (
                    <td key={keyOf(c, k)} style={cellStyle(align[k])}>
                      {inlines(c, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          )}
        </table>
      );
    }
    default:
      return n.children ? <div key={key}>{renderBlockSeq(n.children, ctx)}</div> : null;
  }
}

/**
 * 块级子节点序列渲染：处理 details/summary 跨块成对。CommonMark 的 HTML 块
 * （类型 6）在空行处截断——<details> 块、其中的 Markdown 段落、</details> 块
 * 是三个兄弟节点。起始块 <summary> 之后 / 闭合块 </details> 之前的原始内容
 * 以 Markdown 重新解析渲染（与 GitHub 行为一致）；未闭合时按已收集内容渲染。
 */
function renderBlockSeq(nodes: MdNode[], ctx: MarkdownCtx): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < nodes.length) {
    const c = nodes[i];
    if (c.type === "html") {
      const open = parseDetailsOpen(c.value ?? "");
      if (open) {
        let bodyRaw = open.inner;
        let closed = open.closed;
        const kids: MdNode[] = [];
        let j = i + 1;
        while (!closed && j < nodes.length) {
          const d = nodes[j];
          if (d.type === "html" && /<\/details>/i.test(d.value ?? "")) {
            bodyRaw += (d.value ?? "").split(/<\/details>/i)[0];
            closed = true;
            break;
          }
          kids.push(d);
          j += 1;
        }
        out.push(renderDetails(open, bodyRaw, kids, keyOf(c, i), ctx));
        i = closed ? j + 1 : j;
        continue;
      }
    }
    out.push(renderBlock(c, i, ctx));
    i += 1;
  }
  return out;
}

function summaryInline(text: string, ctx: MarkdownCtx): ReactNode {
  // summary 原文按 Markdown 行内语法解析（支持加粗/代码等）
  const parsed = parseMarkdown(text);
  const first = parsed.children.find((c) => c.type === "paragraph");
  return first ? renderSeq(first.children ?? [], ctx) : text;
}

function renderDetails(
  open: DetailsOpen,
  bodyRaw: string,
  kids: MdNode[],
  key: string,
  ctx: MarkdownCtx,
): ReactNode {
  const bodyNodes: ReactNode[] = [];
  if (bodyRaw.trim()) {
    // 原始内容重解析为受控 Markdown（嵌套 details 由递归自然支持）
    const parsed = parseMarkdown(bodyRaw);
    bodyNodes.push(...renderBlockSeq(parsed.children, ctx));
  }
  bodyNodes.push(...kids.map((k, idx) => renderBlock(k, idx, ctx)));
  return (
    <details key={key} className="md-details" open={open.openAttr || undefined}>
      <summary className="md-summary">{open.summaryText != null ? summaryInline(open.summaryText, ctx) : "详情"}</summary>
      {bodyNodes.length > 0 ? bodyNodes : null}
    </details>
  );
}

// --- 脚注收集（引用顺序编号 + 定义映射，含 defsText 携带的全文定义 §7.2 L197） ---

function collectFootnotes(
  root: MdRoot,
  defsRoot: MdRoot | null,
): { fnIndex: Map<string, number>; fnDefs: Map<string, MdNode> } {
  const fnIndex = new Map<string, number>();
  const fnDefs = new Map<string, MdNode>();
  const visit = (n: MdNode): void => {
    if (n.type === "footnoteReference" && n.identifier && !fnIndex.has(n.identifier)) {
      fnIndex.set(n.identifier, fnIndex.size + 1);
    }
    for (const c of n.children ?? []) visit(c);
  };
  for (const n of root.children) visit(n);
  for (const src of [root, defsRoot]) {
    if (!src) continue;
    for (const n of src.children) {
      if (n.type === "footnoteDefinition" && n.identifier && !fnDefs.has(n.identifier)) {
        fnDefs.set(n.identifier, n);
      }
    }
  }
  return { fnIndex, fnDefs };
}

function renderFootnoteSection(ctx: MarkdownCtx): ReactNode {
  if (ctx.fnIndex.size === 0) return null;
  return (
    <section key="footnotes" className="md-footnotes" aria-label="脚注">
      <hr />
      <ol>
        {[...ctx.fnIndex.entries()].map(([ident, idx]) => {
          const def = ctx.fnDefs.get(ident);
          return (
            <li key={ident} id={`${ctx.idPrefix}fn-${idx}`}>
              {def ? (
                renderBlockSeq(def.children ?? [], ctx)
              ) : (
                <span className="md-fndef-missing">（脚注定义不在本文段）</span>
              )}
              {ctx.navigateId && (
                <a
                  className="md-backref"
                  href={`#${ctx.idPrefix}fnref-${idx}`}
                  title="返回引用处"
                  onClick={(e) => {
                    e.preventDefault();
                    ctx.navigateId?.(`${ctx.idPrefix}fnref-${idx}`);
                  }}
                >
                  ↩
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// --- 对外：文本 → React 节点数组（组件与测试共用入口） ---

export interface RenderOpts {
  baseDir: string;
  onOpenRelative?: (rel: string) => void;
  onExternalLink?: (url: string) => void;
  /** 工作区相对路径图片 → 可显示 URL（asset 协议；无则占位框） */
  resolveImage?: (rel: string) => string | null;
  /** 复习场景：块片段之外的全文——仅用于携带引用定义与脚注定义（§7.2 L197） */
  defsText?: string | null;
  /** 容器内锚点 id 前缀（默认 ""；多实例渲染时防撞） */
  idPrefix?: string;
  /** 容器内滚动导航（脚注/锚点可点性由其存在决定） */
  navigateId?: (id: string) => void;
  navigateAnchor?: (frag: string) => void;
  /** 仅为根级标题添加操作，不改变 Markdown 文本、锚点或指纹。 */
  renderHeadingActions?: (heading: TocHeading) => ReactNode;
}

export function renderMarkdown(text: string, opts: RenderOpts): ReactNode[] {
  // 复习场景（§7.2 L197）：块片段单独解析时，引用式链接/脚注引用在解析期就
  // 回退为字面文本（CommonMark/GFM 语义），事后合并映射救不回——必须把全文里的
  // definition / footnoteDefinition 原文拼到片段尾部重新解析。拼接只在尾部，
  // 片段内所有节点偏移不变（data-offset 锚点/标题 slug 均不受影响）；
  // 两类定义节点渲染层零输出。
  const defsRoot = opts.defsText ? parseMarkdown(opts.defsText) : null;
  let parsedText = text;
  if (defsRoot) {
    const defsRaw = defsRoot.children
      .filter((n) => n.type === "definition" || n.type === "footnoteDefinition")
      .map((n) => {
        const s = n.position?.start?.offset ?? 0;
        const e = n.position?.end?.offset ?? 0;
        return s < e ? opts.defsText!.slice(s, e) : "";
      })
      .filter(Boolean)
      .join("\n");
    if (defsRaw) parsedText = `${text}\n\n${defsRaw}`;
  }
  const root: MdRoot = parseMarkdown(parsedText);
  const { fnIndex, fnDefs } = collectFootnotes(root, defsRoot);
  const slugger = createSlugger();
  const headingSlugs = new Map<number, string>();
  for (const n of root.children) {
    if (n.type === "heading") {
      const off = n.position?.start?.offset;
      if (off != null) headingSlugs.set(off, slugger(extractText(n).trim()));
    }
  }
  const ctx: MarkdownCtx = {
    defs: buildDefinitionMap(root),
    baseDir: opts.baseDir,
    idPrefix: opts.idPrefix ?? "",
    headingSlugs,
    fnIndex,
    fnDefs,
    fnSeen: new Set(),
    resolveImage: opts.resolveImage,
    onOpenRelative: opts.onOpenRelative,
    onExternalLink: opts.onExternalLink,
    navigateId: opts.navigateId,
    navigateAnchor: opts.navigateAnchor,
    renderHeadingActions: opts.renderHeadingActions,
  };
  return [...renderBlockSeq(root.children, ctx), renderFootnoteSection(ctx)].filter(
    (x): x is ReactNode => x !== null,
  );
}

// --- 目录（TOC）：与渲染同源的真实解析，代码围栏/引言中的 # 不会误入 ---

export interface TocHeading {
  level: number; // 1–6
  text: string;
  /** 标题在文档内的起始偏移（预览滚动锚点 / 编辑态光标跳转） */
  offset: number;
  /** GitHub 风格 slug（文内 #锚点 目标） */
  slug: string;
}

export function extractHeadings(text: string): TocHeading[] {
  const root: MdRoot = parseMarkdown(text);
  const slugger = createSlugger();
  const out: TocHeading[] = [];
  for (const n of root.children) {
    if (n.type !== "heading") continue;
    const t = extractText(n).trim();
    out.push({
      level: Math.min(Math.max(n.depth ?? 1, 1), 6),
      text: t,
      offset: n.position?.start?.offset ?? 0,
      slug: slugger(t),
    });
  }
  return out;
}

export interface MarkdownViewProps {
  /** LF 化正文（编辑器缓冲/已保存版本，与引擎同输入约束） */
  text: string;
  /** 当前文件的工作区相对路径（解析相对 .md 链接/图片的基准；复习页等无树上下文可省略） */
  baseRelative?: string | null;
  /** 复习场景：全文文本，仅用于携带引用/脚注定义（§7.2 L197；反泄露纪律：揭示后才传入） */
  defsText?: string | null;
  /** 工作区相对路径图片 → asset URL（由持有 workspace 根的宿主注入） */
  resolveImage?: (rel: string) => string | null;
  /** 相对 .md 链接 → 应用内打开（工作区相对路径） */
  onOpenRelative?: (rel: string) => void;
  /** 外链/相对资源 → 提示（无 opener 插件，不在 WebView 内导航） */
  onExternalLink?: (url: string) => void;
  className?: string;
  renderHeadingActions?: (heading: TocHeading) => ReactNode;
}

/** 只读受控渲染：memo 后 text 不变不重解析（预览快照仅在切换/系统边界刷新，§15.2） */
export const MarkdownView = memo(function MarkdownView({
  text,
  baseRelative,
  defsText,
  resolveImage,
  onOpenRelative,
  onExternalLink,
  className,
  renderHeadingActions,
}: MarkdownViewProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // React useId 含 ":"（querySelector 需转义），换成安全字符集
  const idPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const escId = useCallback(
    (id: string): string => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id),
    [],
  );
  const navigateId = useCallback(
    (id: string) => {
      rootRef.current?.querySelector(`[id="${escId(id)}"]`)?.scrollIntoView({ block: "center" });
    },
    [escId],
  );
  const navigateAnchor = useCallback(
    (frag: string) => {
      const root = rootRef.current;
      if (!root) return;
      // 用户写的锚点可能是原文（#二级）或 slug（#some-heading）：两种 id 都试
      for (const id of [`${idPrefix}${slugify(frag)}`, `${idPrefix}${frag}`]) {
        const el = root.querySelector(`[id="${escId(id)}"]`);
        if (el) {
          el.scrollIntoView({ block: "center" });
          return;
        }
      }
    },
    [idPrefix, escId],
  );
  const nodes = useMemo(
    () => {
      // 文件路径 → 所在目录（"" = 根）；相对 .md 链接/图片以此为基准解析
      const slash = baseRelative ? baseRelative.lastIndexOf("/") : -1;
      const baseDir = slash >= 0 ? baseRelative!.slice(0, slash) : "";
      return renderMarkdown(text, {
        baseDir,
        defsText,
        resolveImage,
        onOpenRelative,
        onExternalLink,
        idPrefix,
        navigateId,
        navigateAnchor,
        renderHeadingActions,
      });
    },
    [text, baseRelative, defsText, resolveImage, onOpenRelative, onExternalLink, idPrefix, navigateId, navigateAnchor, renderHeadingActions],
  );
  return (
    <div ref={rootRef} className={className}>
      {nodes}
    </div>
  );
});
