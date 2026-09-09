// Block Engine 核心 DTO（M3）。字段对照设计 §8.2（范围/指纹）、§9.3（诊断/reconcile）、
// §12.3（Document/KnowledgeBlock 字段词典）：M4 将把本层输出直接落 SQLite 消费。
//
// 诊断纪律（§9.3 L337）：Diagnostic 只含位置/ID/错误码，即 diagnostics_json 的落库形状；
// 用户可读文案由 UI 层映射，防止正文性内容混入落库字段。
//
// 引擎坐标系统一为「内部 LF 文本的 UTF-16 半开区间」（§8.2 L272）：
// 输入必须已 LF 化、去 BOM（read_document / CM6 buffer 均已保证）。

export type BlockKind = "SECTION" | "PREAMBLE";

/** KnowledgeBlock.status（DDL L655）。DELETED 由 M4 在稳定确认后晋升，M3 不产出。 */
export type BlockStatus = "ACTIVE" | "MISSING" | "DELETED" | "ID_CONFLICT";

export type Participation = "ENABLED" | "PAUSED" | "EXCLUDED";

export type DiagnosticCode =
  | "ID_DUPLICATED" // 同一合法 ID 在本文件出现多处（跨文件重复由 reconcile 判定）
  | "ID_MISPLACED" // 协议注释出现在正文中间/尾部等非法锚位（§9.2 L310 位置异常）
  | "ID_EXTRA" // 同一候选锚区内出现第二枚及以后协议注释（合并冲突线索）
  | "ID_MALFORMED" // 注释形似协议但 UUID 不合法
  | "GIT_CONFLICT" // 非代码区出现 Git 冲突标记：文档暂停索引提交与复习（§8.3 L285）
  | "BLOCK_OVERSIZED"; // 单块 >8000 可见字符或 >200 行，提示级，不阻断（§8.3 L283）

export interface Diagnostic {
  code: DiagnosticCode;
  blockId: string | null;
  startOffset: number;
  endOffset: number;
}

/** 合格 Block（或无锚点 Candidate）的完整定位与指纹。 */
export interface BlockInfo {
  /** 合法锚点 UUID；null = 无锚点候选（BlockCandidate，不进复习队列，§4 L66）。 */
  blockId: string | null;
  kind: BlockKind;
  title: string | null; // PREAMBLE 为 null
  headingLevel: number; // 0–6；PREAMBLE=0
  headingPath: string[]; // 祖先+自身标题文本；PREAMBLE=[]
  ordinal: number; // 文件内顺序，0 起，仅合格块
  startOffset: number; // 含自身标题/注释/直属正文；PREAMBLE 不含 frontmatter
  bodyStartOffset: number; // 答案起点；排除 ID 注释与 reference definition
  endOffset: number;
  sourceHash: string; // 切片去自身合法 ID 注释行后 SHA-256；不用于自动认领（§8.2 L261）
  bodyHash: string; // 答案 AST 的 fingerprint-v1 序列化 SHA-256
  oversized: boolean;
}

// --- 锚点扫描（anchors.ts 产出，analyze/reconcile 共用）---

export type AnchorPlacement = "LEGAL_ANCHOR" | "MISPLACED";

export interface AnchorOccurrence {
  /** 合法 UUID；形似协议但 UUID 非法时为 null（malformed=true）。 */
  blockId: string | null;
  malformed: boolean;
  /** 注释文本的精确范围 [start,end)，不含换行。 */
  commentStart: number;
  commentEnd: number;
  placement: AnchorPlacement;
  /** 所属候选下标（按出现位置落入哪个 [start,end)）；用于 ID_EXTRA 归属与 UI 定位。 */
  candidateIndex: number | null;
}

export interface AnchorScan {
  occurrences: AnchorOccurrence[];
  byId: Map<string, AnchorOccurrence[]>;
}

// --- 单文件分析报告（analyze.ts 产出）---

export interface AnchorInsertion {
  blockId: string;
  ordinal: number;
  /** 插入点：SECTION=标题结束（含 Setext 下划线）；PREAMBLE=bodyStartOffset。 */
  insertOffset: number;
  /** SECTION="\n"+注释行；PREAMBLE=注释行+"\n"（前言锚点独占正文首行上方）。 */
  text: string;
  /** 快照中插入点前后各 ≤32 字符，供 CM6 安全映射逐字核对（§13.1 L812）。 */
  contextBefore: string;
  contextAfter: string;
}

export interface UnqualifiedHeading {
  title: string | null;
  startOffset: number;
  endOffset: number;
}

export interface SingleFileReport {
  relativePath: string;
  rawByteHash: string;
  /** 过时结果丢弃用（§15.2 L1010）：等于 rawByteHash，调用方比对后决定弃用。 */
  revision: string;
  /** 与哈希规则共同版本化（§8.2 L268），改指纹规则必须连带升级。 */
  parserVersion: string;
  charCount: number;
  lineCount: number;
  /** GIT_CONFLICT 时 false：暂停索引提交与复习，保留旧索引直到用户解决（§8.3 L285）。 */
  indexable: boolean;
  blocks: BlockInfo[]; // ordinal 升序，仅合格块
  unqualifiedHeadings: UnqualifiedHeading[];
  anchorOccurrences: AnchorOccurrence[];
  diagnostics: Diagnostic[];
  /** 仅 insertionPolicy="missing" 时非空（无写副作用：policy "none" 恒为空数组）。 */
  insertionPlan: AnchorInsertion[];
}

// --- 变更分类（§10.3 五行表）---

export type ContentChangeClass =
  | "META_ONLY" // 位置/路径/标题变、正文同 → 更新索引，不动版本
  | "AST_IDENTICAL" // 答案 AST 相同（如只改空行）→ 完全不动
  | "CONTENT_NEW" // 正文变、尚未首评 → +content_version
  | "CONTENT_REVIEWED" // 正文变、已有评分 → needs_recheck（调度行为属 M5）
  | "CONTENT_PAUSED"; // PAUSED/EXCLUDED 段正文变 → 记录修订不自动恢复

/** 参与 diff/reconcile 的块事实（M4 落库列的子集，测试以 fixtures 提供）。 */
export interface BlockFacts {
  relativePath: string;
  bodyHash: string;
  sourceHash: string;
  startOffset: number;
  bodyStartOffset: number;
  endOffset: number;
  ordinal: number;
  headingPath: string[];
  title: string | null;
}

// --- reconcile（§9.3）---

/** 已登记 Block（快照注册表输入；M4 起来自 SQLite，M3 由测试构造）。 */
export interface RegisteredBlock extends BlockFacts {
  blockId: string;
  /** 移动中稳定的身份（relativePath 会变）；Rust 恒提供，测试 fixtures 可省 */
  documentId?: string;
  kind: BlockKind;
  headingLevel: number;
  contentVersion: number;
  status: BlockStatus;
  hasRating: boolean;
  participation: Participation;
  /** 上次内容变更确认标记（Rust 恒提供，测试 fixtures 可省） */
  needsRecheck?: boolean;
}

export type ReconcileAction =
  | "CREATE" // 快照中出现未登记 ID（含跨库新登记：不读取他库历史，§9.4 L359）
  | "UPDATE_META" // 仅位置/路径/标题变
  | "UPDATE_CONTENT" // 正文变（+content_version）
  | "MARK_MISSING" // 首次消失
  | "KEEP_MISSING" // 仍缺失（DELETED 晋升属 M4 的稳定确认）
  | "RESTORE" // 唯一旧 ID 重新出现，恢复原历史（tombstone 复现，L358）
  | "MARK_CONFLICT" // 出现次数 >1：保留最后映射、禁复习、不改写任一文档（L335）
  | "DEFER_VERIFY_OLD_FILE" // 旧持有文件不在快照集合且未显式标记不存在：不下结论（L316）
  | "NOOP";

export interface Occurrence {
  relativePath: string;
  ordinal: number | null;
  commentStart: number;
  commentEnd: number;
  placement: AnchorPlacement;
  /** 是否落在合格块的合法锚位（决定能否给出 next 定位）。 */
  inQualifiedBlock: boolean;
}

export interface BlockReconcileResult {
  blockId: string;
  action: ReconcileAction;
  status: BlockStatus;
  relativePath: string | null;
  /** UPSERT/RESTORE 的完整行数据；CONFLICT/DEFER/MISSING 为 null。 */
  next: (BlockInfo & { relativePath: string; contentVersion: number; needsRecheck: boolean }) | null;
  changeClass: ContentChangeClass | null;
  contentVersionDelta: 0 | 1;
  needsRecheck: boolean;
  prev: { relativePath: string; status: BlockStatus } | null;
  /** status_reason 候选：一句话裁决依据，供 M4 落库与 UI 展示。 */
  reason: string;
  occurrences: Occurrence[];
}

export interface ReconcileReport {
  /** blockId 字典序，保证同输入输出确定（幂等核验的前提）。 */
  blockResults: BlockReconcileResult[];
  diagnostics: Diagnostic[];
  snapshotPaths: string[];
}

/** 引擎层错误（Worker 协议与测试共用；不混入 HostError 协议）。 */
export class EngineError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
