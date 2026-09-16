// 受控 Markdown 渲染组件（设计 §161/§207）：mdast → React 元素直渲染。
// 复用引擎 parseMarkdown（remark-parse+gfm+frontmatter），预览/复习与划块同方言（§8）；
// 安全性由构造保证：html 节点（含 ID 锚点注释）与 frontmatter 一律不渲染，
// 全程不使用 dangerouslySetInnerHTML，原始 HTML / 事件属性 / iframe 无执行路径。
// 链接策略（§161）：相对 .md 链接在应用内打开；http(s)/mailto 只提示不在 WebView 内导航；
// javascript: 等其余协议渲染为不可点文本。图片一律占位框（默认无自动网络请求）。

import { memo, useMemo, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { buildDefinitionMap, normalizeTextValue } from "../engine/fingerprint";
import { extractText, parseMarkdown, type MdNode, type MdRoot } from "../engine/segment";

// --- 链接策略（纯函数，测试覆盖） ---

export type LinkTarget =
  | { kind: "external"; url: string } // http/https/mailto：拦截点击，仅提示
  | { kind: "md"; rel: string; anchor: string | null } // 工作区内 .md：应用内打开
  | { kind: "relative"; href: string } // 相对非 .md 资源：仅提示
  | { kind: "anchor" } // 文内 #锚点：本版不可跳转
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
  if (u.startsWith("#")) return { kind: "anchor" };
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s === "http" || s === "https" || s === "mailto") return { kind: "external", url: u };
    return { kind: "blocked" };
  }
  const hashIdx = u.indexOf("#");
  const path = hashIdx >= 0 ? u.slice(0, hashIdx) : u;
  const anchor = hashIdx >= 0 ? u.slice(hashIdx + 1) : null;
  if (!path) return { kind: "anchor" };
  const rel = resolveRelativePath(baseDir, path);
  if (rel.toLowerCase().endsWith(".md")) return { kind: "md", rel, anchor };
  return { kind: "relative", href: u };
}

// --- 渲染上下文 ---

export interface MarkdownCtx {
  defs: ReturnType<typeof buildDefinitionMap>;
  baseDir: string;
  onOpenRelative?: (rel: string) => void;
  onExternalLink?: (url: string) => void;
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

function renderInline(n: MdNode, i: number, ctx: MarkdownCtx): ReactNode {
  const key = keyOf(n, i);
  switch (n.type) {
    case "text":
      return normalizeTextValue(n.value ?? "");
    case "emphasis":
      return <em key={key}>{inlines(n, ctx)}</em>;
    case "strong":
      return <strong key={key}>{inlines(n, ctx)}</strong>;
    case "delete":
      return <del key={key}>{inlines(n, ctx)}</del>;
    case "inlineCode":
      return <code key={key}>{n.value ?? ""}</code>;
    case "break":
      return <br key={key} />;
    case "footnoteReference":
      return (
        <sup key={key} className="md-fnref" title="脚注">
          {n.label ?? ""}
        </sup>
      );
    case "html":
      return null; // 行内原始 HTML 不执行（§161）
    case "link":
    case "linkReference": {
      // 注：未定义的引用 micromark 在解析期即回退为字面文本（不产生 linkReference 节点），
      // 此处的 def 缺失分支只是防御性兜底。
      const def = n.type === "linkReference" ? ctx.defs.get(n.identifier ?? "") : null;
      if (n.type === "linkReference" && !def) return <span key={key}>{inlines(n, ctx)}</span>;
      const raw = n.type === "link" ? n.url ?? "" : def!.url;
      return renderAnchor(raw, def?.title ?? n.title ?? null, key, inlines(n, ctx), ctx);
    }
    case "image":
    case "imageReference": {
      const def = n.type === "imageReference" ? ctx.defs.get(n.identifier ?? "") : null;
      const url = n.type === "image" ? n.url ?? "" : def?.url ?? "";
      const alt = n.alt ?? "";
      return (
        <span key={key} className="md-img" title={`图片不加载（默认无网络请求）：${url || "（空地址）"}`}>
          <span aria-hidden>🖼</span>
          {alt || "（无描述图片）"}
          {url && <code>{url}</code>}
        </span>
      );
    }
    default:
      return n.children ? inlines(n, ctx) : normalizeTextValue(n.value ?? "");
  }
}

function inlines(n: MdNode, ctx: MarkdownCtx): ReactNode[] {
  return (n.children ?? []).map((c, i) => renderInline(c, i, ctx));
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
    return (
      <span key={key} className="md-link-anchor" title="文内锚点（本版不可跳转）">
        {children}
      </span>
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
    case "html":
      return null; // frontmatter / 引用定义 / 原始 HTML（含 ID 注释）不渲染（§161/§211/§8.2 L258）
    case "heading": {
      const Tag = `h${Math.min(Math.max(n.depth ?? 1, 1), 6)}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      // 锚点用文档内偏移：与 TOC（extractHeadings）同源，点击目录滚动定位
      const off = n.position?.start?.offset;
      return (
        <Tag key={key} id={off != null ? `h-${off}` : undefined}>
          {inlines(n, ctx)}
        </Tag>
      );
    }
    case "paragraph":
      return <p key={key}>{inlines(n, ctx)}</p>;
    case "thematicBreak":
      return <hr key={key} />;
    case "blockquote":
      return <blockquote key={key}>{blocks(n, ctx)}</blockquote>;
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
                : blocks(li, ctx)}
            </li>
          ))}
        </Tag>
      );
    }
    case "code":
      return (
        <pre key={key} data-lang={n.lang ?? undefined}>
          <code>{n.value ?? ""}</code>
        </pre>
      );
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
    case "footnoteDefinition":
      return <blockquote key={key} className="md-fndef">{blocks(n, ctx)}</blockquote>;
    default:
      return n.children ? <div key={key}>{blocks(n, ctx)}</div> : null;
  }
}

function blocks(n: MdNode, ctx: MarkdownCtx): ReactNode[] {
  return (n.children ?? []).map((c, i) => renderBlock(c, i, ctx));
}

// --- 对外：文本 → React 节点数组（组件与测试共用入口） ---

export function renderMarkdown(text: string, ctx: Pick<MarkdownCtx, "baseDir" | "onOpenRelative" | "onExternalLink">): ReactNode[] {
  const root: MdRoot = parseMarkdown(text);
  const full: MarkdownCtx = { defs: buildDefinitionMap(root), ...ctx };
  return root.children.map((c, i) => renderBlock(c, i, full));
}

// --- 目录（TOC）：与渲染同源的真实解析，代码围栏/引言中的 # 不会误入 ---

export interface TocHeading {
  level: number; // 1–6
  text: string;
  /** 标题在文档内的起始偏移（预览滚动锚点 / 编辑态光标跳转） */
  offset: number;
}

export function extractHeadings(text: string): TocHeading[] {
  const root = parseMarkdown(text);
  const out: TocHeading[] = [];
  for (const n of root.children) {
    if (n.type !== "heading") continue;
    out.push({
      level: Math.min(Math.max(n.depth ?? 1, 1), 6),
      text: extractText(n).trim(),
      offset: n.position?.start?.offset ?? 0,
    });
  }
  return out;
}

export interface MarkdownViewProps {
  /** LF 化正文（编辑器缓冲/已保存版本，与引擎同输入约束） */
  text: string;
  /** 当前文件的工作区相对路径（解析相对 .md 链接的基准；复习页等无树上下文可省略） */
  baseRelative?: string | null;
  /** 相对 .md 链接 → 应用内打开（工作区相对路径） */
  onOpenRelative?: (rel: string) => void;
  /** 外链/相对资源 → 提示（无 opener 插件，不在 WebView 内导航） */
  onExternalLink?: (url: string) => void;
  className?: string;
}

/** 只读受控渲染：memo 后 text 不变不重解析（预览快照仅在切换/系统边界刷新，§15.2） */
export const MarkdownView = memo(function MarkdownView({
  text,
  baseRelative,
  onOpenRelative,
  onExternalLink,
  className,
}: MarkdownViewProps) {
  const nodes = useMemo(
    () => {
      // 文件路径 → 所在目录（"" = 根）；相对 .md 链接以此为基准解析
      const slash = baseRelative ? baseRelative.lastIndexOf("/") : -1;
      const baseDir = slash >= 0 ? baseRelative!.slice(0, slash) : "";
      return renderMarkdown(text, { baseDir, onOpenRelative, onExternalLink });
    },
    [text, baseRelative, onOpenRelative, onExternalLink],
  );
  return <div className={className}>{nodes}</div>;
});
