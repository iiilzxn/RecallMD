// fingerprint-v1（设计 §8.2 L268）：答案 AST 的确定性序列化。
// 规则：显式字段白名单 + 固定键序（即下表顺序）；去 position；data 不序列化；数组保序；
// 字符串值一律 JSON.stringify；顶层子节点以 "\u0000" 连接。
// 排除（跳过但保留其余节点顺序）：纯 HTML 注释节点（覆盖协议注释与用户注释）、definition。
// 未知类型兜底 unknown(type=…)[children]，绝不静默丢弃。
//
// 修改本规则必须升级 FINGERPRINT_VERSION 并连带更新 canonical fixture 与 parser_version。

import { isExcludedFromBody, type MdNode, type MdRoot } from "./segment";

export const FINGERPRINT_VERSION = "fingerprint-v1";

export interface DefinitionEntry {
  url: string;
  title: string | null;
}

export type DefinitionMap = Map<string, DefinitionEntry>;

/**
 * 文件级 reference definition 上下文（§7.2 L197）。key=identifier（mdast 已做
 * 大小写/空白折叠归一），同 identifier 多个定义时首个生效（CommonMark）。
 * 定义 url/title 变化必须改变使用块的 body_hash（L266）——因为这里参与序列化。
 */
export function buildDefinitionMap(root: MdRoot): DefinitionMap {
  const map: DefinitionMap = new Map();
  for (const n of root.children) {
    if (n.type === "definition" && n.identifier && !map.has(n.identifier)) {
      map.set(n.identifier, { url: n.url ?? "", title: n.title ?? null });
    }
  }
  return map;
}

/**
 * 仅 text 节点做软换行归一：行首尾空白加换行折叠为单个空格（正则见实现，
 * 注释里不抄正则字面量——其中的斜杠星号会提前终止块注释）。
 * 段内 re-flow 不虚增 content_version；硬换行是独立 break 节点，不受影响。
 * code/inlineCode/html 逐字符保留，不归一。
 */
export function normalizeTextValue(v: string): string {
  return v.replace(/[ \t]*\n[ \t]*/g, " ");
}

function alignChar(a: "left" | "right" | "center" | null | undefined): string {
  switch (a) {
    case "left":
      return "l";
    case "right":
      return "r";
    case "center":
      return "c";
    default:
      return "n";
  }
}

function serialize(n: MdNode, defs: DefinitionMap): string {
  const J = (s: string | null | undefined) => JSON.stringify(s ?? null);
  const kids = (node: MdNode) => (node.children ?? []).map((c) => serialize(c, defs)).join(",");
  switch (n.type) {
    case "paragraph":
    case "blockquote":
    case "tableRow":
    case "tableCell":
      return `${n.type}[${kids(n)}]`;
    case "heading":
      return `heading(depth=${n.depth ?? 0})[${kids(n)}]`;
    case "text":
      return `text(v=${J(normalizeTextValue(n.value ?? ""))})`;
    case "emphasis":
    case "strong":
    case "delete":
      return `${n.type}[${kids(n)}]`;
    case "inlineCode":
      return `inlineCode(v=${J(n.value)})`;
    case "code":
      // 代码空白逐字符保留（§8.2 L268）
      return `code(lang=${J(n.lang)},meta=${J(n.meta)},v=${J(n.value)})`;
    case "html":
      return `html(v=${J(n.value)})`;
    case "link":
      return `link(url=${J(n.url)},title=${J(n.title)})[${kids(n)}]`;
    case "image":
      return `image(url=${J(n.url)},title=${J(n.title)},alt=${J(n.alt)})`;
    case "linkReference": {
      // 已解析则按 link 序列化；identifier/referenceType 不进指纹
      // （改标签名不改目标 → body_hash 不变，钉 fixture link-label-rename-same-target）
      const def = n.identifier ? defs.get(n.identifier) : undefined;
      if (def) return `link(url=${J(def.url)},title=${J(def.title)})[${kids(n)}]`;
      return `linkReference[${kids(n)}]`;
    }
    case "imageReference": {
      const def = n.identifier ? defs.get(n.identifier) : undefined;
      if (def) return `image(url=${J(def.url)},title=${J(def.title)},alt=${J(n.alt)})`;
      return `imageReference(alt=${J(n.alt)})`;
    }
    case "list":
      return `list(ordered=${n.ordered ? 1 : 0},start=${n.start ?? null},spread=${n.spread ? 1 : 0})[${kids(n)}]`;
    case "listItem":
      return `listItem(checked=${n.checked === true ? "true" : n.checked === false ? "false" : "null"})[${kids(n)}]`;
    case "table":
      return `table(align=${(n.align ?? []).map(alignChar).join("")})[${kids(n)}]`;
    case "thematicBreak":
      return "thematicBreak";
    default:
      return `unknown(type=${J(n.type)})[${kids(n)}]`;
  }
}

/** 答案 AST → 指定性序列化串（body_hash 的前像）。 */
export function fingerprintBody(bodyChildren: MdNode[], defs: DefinitionMap): string {
  return bodyChildren
    .filter((n) => !isExcludedFromBody(n))
    .map((n) => serialize(n, defs))
    .join("\u0000");
}
