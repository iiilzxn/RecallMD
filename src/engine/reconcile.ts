// reconcile（设计 §9.3 L316–337）：跨快照身份核对，纯函数。
// 输入 = 快照集合 + 已登记 ID 注册表；输出 = 逐 ID 裁决提案（M4 在单 SQLite 事务提交）。
//
// 关键裁决（L318–335 伪码）：
// - 出现次数 >1 → ID_CONFLICT：保留最后映射、禁复习、不自动改写任一文档
// - 恰一处且旧位置核实已变 → 更新位置/内容；MISSING → RESTORE（tombstone 复现，L358）
// - 消失 → MISSING（DELETED 晋升属 M4 的稳定确认，M3 保守停在 MISSING）
// - 疑似跨文件移动而旧持有文件不在快照集合 → DEFER，不下结论（L316）

import { analyzeDocument } from "./analyze";
import { classifyBlockChange } from "./diff";
import type {
  BlockReconcileResult,
  Diagnostic,
  Occurrence,
  ReconcileReport,
  RegisteredBlock,
  SingleFileReport,
  BlockInfo,
} from "./types";

export interface FileSnapshot {
  relativePath: string;
  /** null = 该文件当前不存在（已显式核实）。 */
  text: string | null;
}

export interface ReconcileInput {
  snapshots: FileSnapshot[];
  registry: RegisteredBlock[];
}

interface CurrentBlock {
  report: SingleFileReport;
  block: BlockInfo;
}

export async function reconcileSnapshots({ snapshots, registry }: ReconcileInput): Promise<ReconcileReport> {
  // 并行分析所有存在的快照（reconcile 不关心 rawByteHash，传空）
  const reports = new Map<string, SingleFileReport>();
  await Promise.all(
    snapshots
      .filter((s) => s.text != null)
      .map(async (s) => {
        reports.set(s.relativePath, await analyzeDocument({ relativePath: s.relativePath, text: s.text!, rawByteHash: "" }));
      }),
  );

  // id → 当前全部出现位置（含错位出现：L335 "including unresolved diagnostics"）
  const occById = new Map<string, Occurrence[]>();
  const currentById = new Map<string, CurrentBlock>();
  for (const [path, rep] of reports) {
    for (const o of rep.anchorOccurrences) {
      if (!o.blockId) continue;
      const blk = o.placement === "LEGAL_ANCHOR" ? rep.blocks.find((b) => b.blockId === o.blockId) : undefined;
      const occ: Occurrence = {
        relativePath: path,
        ordinal: blk ? blk.ordinal : null,
        commentStart: o.commentStart,
        commentEnd: o.commentEnd,
        placement: o.placement,
        inQualifiedBlock: blk !== undefined,
      };
      const list = occById.get(o.blockId);
      if (list) list.push(occ);
      else occById.set(o.blockId, [occ]);
      // 冲突时数据归属无意义（action=CONFLICT），首个仅作占位
      if (blk && !currentById.has(o.blockId)) currentById.set(o.blockId, { report: rep, block: blk });
    }
  }

  const registryIds = new Set(registry.map((b) => b.blockId));
  const snapshotPaths = new Set(snapshots.map((s) => s.relativePath));

  // 合并冲突簇（§9.4 操作 7）：ID_EXTRA 诊断指向的非首枚 ID，连同其所在块的持有 ID，
  // 全部进入身份冲突——用户裁决前不产生任何赢家
  const conflictIds = new Set<string>();
  for (const rep of reports.values()) {
    for (const d of rep.diagnostics) {
      if (d.code !== "ID_EXTRA" || !d.blockId) continue;
      conflictIds.add(d.blockId);
      const holder = rep.blocks.find((b) => d.startOffset >= b.startOffset && d.startOffset < b.endOffset);
      if (holder?.blockId) conflictIds.add(holder.blockId);
    }
  }

  const results: BlockReconcileResult[] = [];

  // --- 已登记 ID ---
  for (const prev of [...registry].sort(byId)) {
    results.push(judgeRegistered(prev, snapshots, snapshotPaths, occById, currentById, conflictIds));
  }

  // --- 未登记 ID：恰一处且在合格块 → CREATE（含跨库注释：新登记、不读取他库历史，L359）---
  // 多处出现的未登记重复 ID 只留在文档诊断里，不创建任何“赢家”（L337）；
  // 卷入合并冲突簇的 ID 同样不 CREATE（裁决前不新登记）
  for (const [id, occs] of [...occById.entries()].sort(byKey)) {
    if (registryIds.has(id) || occs.length !== 1 || conflictIds.has(id)) continue;
    const cur = currentById.get(id);
    if (!cur) continue;
    const next = cur.block;
    results.push({
      blockId: id,
      action: "CREATE",
      status: "ACTIVE",
      relativePath: cur.report.relativePath,
      next: { ...next, relativePath: cur.report.relativePath, contentVersion: 1, needsRecheck: false },
      changeClass: null,
      contentVersionDelta: 0,
      needsRecheck: false,
      prev: null,
      reason: "快照中新出现且未登记：新登记（跨库注释不读取他库历史）",
      occurrences: occs,
    });
  }

  results.sort(byIdOfResult);
  const diagnostics: Diagnostic[] = [];
  for (const s of snapshots) {
    const rep = s.text != null ? reports.get(s.relativePath) : undefined;
    if (rep) diagnostics.push(...rep.diagnostics);
  }
  return { blockResults: results, diagnostics, snapshotPaths: snapshots.map((s) => s.relativePath) };
}

function judgeRegistered(
  prev: RegisteredBlock,
  snapshots: FileSnapshot[],
  snapshotPaths: Set<string>,
  occById: Map<string, Occurrence[]>,
  currentById: Map<string, CurrentBlock>,
  conflictIds: Set<string>,
): BlockReconcileResult {
  const occs = occById.get(prev.blockId) ?? [];
  const base = {
    blockId: prev.blockId,
    contentVersionDelta: 0 as 0 | 1,
    prev: { relativePath: prev.relativePath, status: prev.status },
    occurrences: occs,
  };

  if (conflictIds.has(prev.blockId)) {
    return {
      ...base,
      action: "MARK_CONFLICT",
      status: "ID_CONFLICT",
      relativePath: prev.relativePath,
      next: null,
      changeClass: null,
      needsRecheck: false,
      reason: "多枚 ID 落入同一候选（合并）：等待用户裁决保留哪个 ID",
    };
  }

  if (occs.length > 1) {
    return {
      ...base,
      action: "MARK_CONFLICT",
      status: "ID_CONFLICT",
      relativePath: prev.relativePath,
      next: null,
      changeClass: null,
      needsRecheck: false,
      reason: `ID 当前出现 ${occs.length} 处：保留最后映射并禁用复习，不自动改写任一文档`,
    };
  }

  if (occs.length === 0) {
    // 旧持有文件不在快照集合：本轮对它的消失同样不下结论（与 L316 同理）
    if (!snapshotPaths.has(prev.relativePath)) {
      return {
        ...base,
        action: "DEFER_VERIFY_OLD_FILE",
        status: prev.status,
        relativePath: prev.relativePath,
        next: null,
        changeClass: null,
        needsRecheck: false,
        reason: "旧持有文件不在快照集合：无法核实消失，本轮不下结论",
      };
    }
    const wasMissing = prev.status === "MISSING";
    return {
      ...base,
      action: wasMissing ? "KEEP_MISSING" : "MARK_MISSING",
      status: "MISSING",
      relativePath: prev.relativePath,
      next: null,
      changeClass: null,
      needsRecheck: false,
      reason: wasMissing ? "仍缺失：等待 M4 稳定确认后晋升 DELETED" : "首次消失（剪切未粘贴/删除同型）",
    };
  }

  // 恰一处
  const cur = currentById.get(prev.blockId);
  if (!cur) {
    // 唯一出现未落在合格块（无正文标题下保留锚点 / 错位）：身份在、暂不可复习（§9.2 L310）
    return {
      ...base,
      action: "NOOP",
      status: prev.status,
      relativePath: prev.relativePath,
      next: null,
      changeClass: null,
      needsRecheck: false,
      reason: "唯一出现未落在合格块（无正文标题或错位），暂不可复习",
    };
  }

  // 跨文件：核实旧持有文件（L316 不能因索引未处理删除就判复制）
  if (cur.report.relativePath !== prev.relativePath) {
    const oldSnap = snapshots.find((s) => s.relativePath === prev.relativePath);
    if (oldSnap === undefined) {
      return {
        ...base,
        action: "DEFER_VERIFY_OLD_FILE",
        status: prev.status,
        relativePath: prev.relativePath,
        next: null,
        changeClass: null,
        needsRecheck: false,
        reason: "旧持有文件不在快照集合且未显式标记不存在：本轮不下结论",
      };
    }
    // oldSnap 在集合内：text=null（已核实消失）或其报告已并入 occById（若仍含此 id 上面已判 >1）→ 移动成立
  }

  const nextBlock = cur.block;
  const nextFacts = {
    relativePath: cur.report.relativePath,
    bodyHash: nextBlock.bodyHash,
    sourceHash: nextBlock.sourceHash,
    startOffset: nextBlock.startOffset,
    bodyStartOffset: nextBlock.bodyStartOffset,
    endOffset: nextBlock.endOffset,
    ordinal: nextBlock.ordinal,
    headingPath: nextBlock.headingPath,
    title: nextBlock.title,
  };
  const changeClass = classifyBlockChange(prev, nextFacts, {
    hasRating: prev.hasRating,
    participation: prev.participation,
  });
  const delta: 0 | 1 = nextBlock.bodyHash !== prev.bodyHash ? 1 : 0;
  const needsRecheck = changeClass === "CONTENT_REVIEWED" || changeClass === "CONTENT_PAUSED";
  const restored = prev.status === "MISSING";
  const action = restored
    ? "RESTORE"
    : changeClass === "AST_IDENTICAL"
      ? "NOOP"
      : changeClass === "META_ONLY"
        ? "UPDATE_META"
        : "UPDATE_CONTENT";

  return {
    ...base,
    action,
    status: "ACTIVE",
    relativePath: cur.report.relativePath,
    next: {
      ...nextBlock,
      relativePath: cur.report.relativePath,
      contentVersion: prev.contentVersion + delta,
      needsRecheck,
    },
    changeClass,
    contentVersionDelta: delta,
    needsRecheck,
    reason: restored
      ? delta === 1
        ? "唯一旧 ID 重新出现：恢复原历史；正文已变，触发内容变更"
        : "唯一旧 ID 重新出现：恢复原历史"
      : action === "UPDATE_META"
        ? "正文相同，仅位置/路径/标题变化：更新索引，不动版本"
        : action === "UPDATE_CONTENT"
          ? "答案 AST 已改变：content_version +1"
          : "完全一致：幂等 no-op",
  };
}

/** 模拟 M4 的单事务提交（测试幂等断言与 M4 实现共用）。返回新数组，不改入参。 */
export function applyProposals(registry: RegisteredBlock[], report: ReconcileReport): RegisteredBlock[] {
  const next = registry.map((b) => ({ ...b }));
  for (const r of report.blockResults) {
    const idx = next.findIndex((b) => b.blockId === r.blockId);
    if (r.action === "CREATE" && idx === -1 && r.next) {
      next.push({
        blockId: r.blockId,
        relativePath: r.next.relativePath,
        bodyHash: r.next.bodyHash,
        sourceHash: r.next.sourceHash,
        startOffset: r.next.startOffset,
        bodyStartOffset: r.next.bodyStartOffset,
        endOffset: r.next.endOffset,
        ordinal: r.next.ordinal,
        headingPath: r.next.headingPath,
        title: r.next.title,
        kind: r.next.kind,
        headingLevel: r.next.headingLevel,
        contentVersion: r.next.contentVersion,
        status: "ACTIVE",
        hasRating: false,
        participation: "ENABLED",
      });
    } else if (idx !== -1 && r.next) {
      const b = next[idx];
      // 只落 RegisteredBlock 声明的字段（丢弃 next 携带的 oversized/needsRecheck 等展示字段，
      // 保证重放幂等：同提案两次应用产生逐字段相等的注册表）
      next[idx] = {
        relativePath: r.next.relativePath,
        bodyHash: r.next.bodyHash,
        sourceHash: r.next.sourceHash,
        startOffset: r.next.startOffset,
        bodyStartOffset: r.next.bodyStartOffset,
        endOffset: r.next.endOffset,
        ordinal: r.next.ordinal,
        headingPath: r.next.headingPath,
        title: r.next.title,
        blockId: r.blockId,
        kind: r.next.kind,
        headingLevel: r.next.headingLevel,
        contentVersion: r.next.contentVersion,
        status: "ACTIVE",
        // 登记侧的历史/参与策略不随定位更新覆写（来源是注册表，M4 起来自 ReviewState）
        hasRating: b.hasRating,
        participation: b.participation,
      };
    } else if (idx !== -1) {
      const b = next[idx];
      if (r.action === "MARK_MISSING" || r.action === "KEEP_MISSING") b.status = "MISSING";
      else if (r.action === "MARK_CONFLICT") b.status = "ID_CONFLICT";
      // DEFER / NOOP：不动
    }
  }
  return next;
}

function byId(a: RegisteredBlock, b: RegisteredBlock): number {
  return a.blockId < b.blockId ? -1 : 1;
}

function byKey(a: [string, Occurrence[]], b: [string, Occurrence[]]): number {
  return a[0] < b[0] ? -1 : 1;
}

function byIdOfResult(a: BlockReconcileResult, b: BlockReconcileResult): number {
  return a.blockId < b.blockId ? -1 : 1;
}
