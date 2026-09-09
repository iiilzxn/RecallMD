// 注释协议 v1（设计 §9.2 L308 + §4 L80）：
// 独立一行 `<!-- recall:block:<uuid-v4> -->`，小写标准连字符格式。
// 本文件是协议正则的唯一来源：编辑器弱高亮、锚点扫描、插入生成全部从这里导入。

/** UUID v4 小写标准格式（§4 L80：不含时间、路径或内容哈希）。 */
export const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 整行内容（不含换行）恰为一个合法协议注释。 */
export const PROTOCOL_LINE_RE =
  /^<!-- recall:block:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) -->$/;

/** 形似协议注释（用于识别 ID_MALFORMED；宽松前缀，不含普通 HTML 注释）。 */
export const PROTOCOL_LIKE_RE = /^<!--\s*recall:block:.*-->$/;

export function newBlockId(): string {
  const id = crypto.randomUUID();
  if (!UUID_V4_RE.test(id)) {
    // randomUUID 规范上恒为小写 v4；此断言防御宿主实现偏差，出错即抛、绝不落盘
    throw new Error(`crypto.randomUUID 产出非 v4 小写格式：${id}`);
  }
  return id;
}

export function makeAnchorLine(blockId: string): string {
  return `<!-- recall:block:${blockId} -->`;
}

export type ParsedProtocolLine =
  | { kind: "valid"; blockId: string }
  | { kind: "malformed" }
  | { kind: "other" };

/** 判定一行内容：合法协议注释 / 形似但 UUID 非法 / 其他（普通注释或正文）。 */
export function parseProtocolLine(line: string): ParsedProtocolLine {
  const m = PROTOCOL_LINE_RE.exec(line);
  if (m) return { kind: "valid", blockId: m[1] };
  if (PROTOCOL_LIKE_RE.test(line)) return { kind: "malformed" };
  return { kind: "other" };
}
