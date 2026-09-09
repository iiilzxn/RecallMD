// 十类操作 + 补充场景（§9.4 L339–360）驱动器：
// registry 由 before 文件分析 + 场景 flags 构造（模拟 M4 注册表），
// reconcile 吃 after 快照集合，对照 expect 场景子集断言。
// 另含：幂等（应用提案后重跑无新增变更且状态稳定，§12.5 L766）。

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeDocument } from "../../src/engine/analyze";
import { applyProposals, reconcileSnapshots, type FileSnapshot } from "../../src/engine/reconcile";
import type { Participation, RegisteredBlock, ReconcileReport } from "../../src/engine/types";
import { FIXTURE_ROOT, readFixture, readJson, subsetMismatch } from "../fixtures/load";

interface FileRef {
  file: string;
  as: string;
}

interface ResultExpect {
  blockId: string;
  action?: string;
  status?: string;
  relativePath?: string | null;
  changeClass?: string | null;
  contentVersionDelta?: number;
  needsRecheck?: boolean;
  next?: unknown;
}

interface ScenarioExpect {
  name: string;
  snapshots: FileRef[];
  chain?: boolean;
  flags?: Record<string, { hasRating?: boolean; participation?: Participation }>;
  results?: ResultExpect[];
  diagnosticCodes?: string[];
}

interface OpExpect {
  registry?: FileRef[];
  scenarios: ScenarioExpect[];
}

const opsRoot = join(FIXTURE_ROOT, "operations");

async function analyzeOp(dirName: string, file: string, as: string) {
  return analyzeDocument({
    relativePath: as,
    text: readFixture(`operations/${dirName}/${file}`),
    rawByteHash: "",
  });
}

function buildRegistry(
  dirName: string,
  files: FileRef[],
  flags: Record<string, { hasRating?: boolean; participation?: Participation }>,
): Promise<RegisteredBlock[]> {
  const reg: RegisteredBlock[] = [];
  return Promise.all(
    files.map(async (f) => {
      const rep = await analyzeOp(dirName, f.file, f.as);
      for (const b of rep.blocks) {
        if (!b.blockId) continue;
        const fl = flags[b.blockId] ?? {};
        reg.push({
          relativePath: f.as,
          bodyHash: b.bodyHash,
          sourceHash: b.sourceHash,
          startOffset: b.startOffset,
          bodyStartOffset: b.bodyStartOffset,
          endOffset: b.endOffset,
          ordinal: b.ordinal,
          headingPath: b.headingPath,
          title: b.title,
          blockId: b.blockId,
          kind: b.kind,
          headingLevel: b.headingLevel,
          contentVersion: 1,
          status: "ACTIVE",
          hasRating: fl.hasRating ?? false,
          participation: fl.participation ?? "ENABLED",
        });
      }
    }),
  ).then(() => reg);
}

function applyFlags(
  registry: RegisteredBlock[],
  flags?: Record<string, { hasRating?: boolean; participation?: Participation }>,
): RegisteredBlock[] {
  if (!flags) return registry;
  return registry.map((b) => {
    const f = flags[b.blockId];
    return f ? { ...b, hasRating: f.hasRating ?? b.hasRating, participation: f.participation ?? b.participation } : b;
  });
}

const opDirs = readdirSync(opsRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

for (const dirName of opDirs) {
  const exp = readJson<OpExpect>(`operations/${dirName}/expect.json`);
  const registryFiles: FileRef[] = exp.registry ?? [{ file: "before.md", as: "doc.md" }];

  describe(`十类操作：${dirName}`, () => {
    let original: RegisteredBlock[] = [];
    let current: RegisteredBlock[] = [];
    let lastReport: ReconcileReport | null = null;

    beforeAll(async () => {
      original = await buildRegistry(dirName, registryFiles, {});
      current = original.map((b) => ({ ...b }));
    });

    for (const sc of exp.scenarios) {
      it(sc.name, async () => {
        if (sc.chain && lastReport) {
          current = applyProposals(current, lastReport);
        } else if (!sc.chain) {
          current = original.map((b) => ({ ...b }));
        }
        const snapshots: FileSnapshot[] = sc.snapshots.map((s) => ({
          relativePath: s.as,
          text: readFixture(`operations/${dirName}/${s.file}`),
        }));
        const report = await reconcileSnapshots({ snapshots, registry: applyFlags(current, sc.flags) });
        lastReport = report;

        for (const e of sc.results ?? []) {
          const actual = report.blockResults.find((r) => r.blockId === e.blockId);
          if (!actual) throw new Error(`${sc.name}：结果缺少 blockId=${e.blockId}`);
          const m = subsetMismatch(actual, e);
          if (m) throw new Error(`${sc.name} ${m}`);
        }
        for (const c of sc.diagnosticCodes ?? []) {
          expect(report.diagnostics.map((d) => d.code)).toContain(c);
        }
      });
    }

    it("幂等：默认场景应用提案后重跑，无新增变更且状态稳定（§12.5 L766）", async () => {
      const sc = exp.scenarios[0];
      const snapshots: FileSnapshot[] = sc.snapshots.map((s) => ({
        relativePath: s.as,
        text: readFixture(`operations/${dirName}/${s.file}`),
      }));
      const once = applyProposals(original, await reconcileSnapshots({ snapshots, registry: original }));
      const r2 = await reconcileSnapshots({ snapshots, registry: once });
      const r3 = await reconcileSnapshots({ snapshots, registry: once });
      expect(r2).toEqual(r3); // 同输入输出确定
      const stableActions = new Set(["NOOP", "KEEP_MISSING", "DEFER_VERIFY_OLD_FILE", "MARK_CONFLICT"]);
      for (const r of r2.blockResults) {
        expect(stableActions.has(r.action)).toBe(true);
      }
      expect(applyProposals(once, r2)).toEqual(once); // 重放无副作用
    });
  });
}

// 专项断言（fixture _note 声明的附加行为）
describe("操作专项断言", () => {
  it("op06：拆分后新段的插入计划指向 ordinal 1", async () => {
    const rep = await analyzeDocument(
      { relativePath: "doc.md", text: readFixture("operations/op06-split/after.md"), rawByteHash: "" },
      { insertionPolicy: "missing" },
    );
    expect(rep.blocks).toHaveLength(2);
    expect(rep.insertionPlan).toHaveLength(1);
    expect(rep.insertionPlan[0].ordinal).toBe(1);
  });

  it("op08：改标题后 body_hash 不变而 source_hash 变", async () => {
    const before = await analyzeOp("op08-rename-heading", "before.md", "doc.md");
    const after = await analyzeOp("op08-rename-heading", "after.md", "doc.md");
    expect(after.blocks[0].bodyHash).toBe(before.blocks[0].bodyHash);
    expect(after.blocks[0].sourceHash).not.toBe(before.blocks[0].sourceHash);
  });

  it("extra-lost-id：新 Candidate 无自动认领，但显式恢复路径（插入计划）存在", async () => {
    const rep = await analyzeDocument(
      { relativePath: "doc.md", text: readFixture("operations/extra-lost-id-new-candidate/after.md"), rawByteHash: "" },
      { insertionPolicy: "missing" },
    );
    expect(rep.blocks).toHaveLength(1);
    expect(rep.blocks[0].blockId).toBeNull();
    expect(rep.insertionPlan).toHaveLength(1);
  });
});
