// M7 ExternalSync 编排测试（fake ipc/engine）：防抖合并、自写跳过、
// 60s quick 的可疑/消失检测、rolling hash 捕获同 mtime/size 修改、
// overflow 分窗全量核对。

import { describe, expect, it, vi } from "vitest";
import { ExternalSync, type FsChangedPathPayload } from "../../src/index/externalSync";
import type { AuditHashWindowDto, AuditStatDto, RegistrySnapshot } from "../../src/index/ipc";
import type { EngineClient } from "../../src/engine/workerClient";

// vi.mock 工厂被提升到顶部——共享状态必须 vi.hoisted
const h = vi.hoisted(() => {
  const calls: Array<[string, string[]]> = [];
  const state: { quick: AuditStatDto[]; windows: AuditHashWindowDto[] } = {
    quick: [],
    windows: [],
  };
  const registrySnapshot = (): RegistrySnapshot => ({
    documents: [
      {
        documentId: "d1",
        relativePath: "a.md",
        status: "PRESENT",
        indexStatus: "READY",
        indexRevision: 3,
        observedHash: "aaa",
        contentHash: "hA1",
        parserVersion: "p",
        byteSize: 10,
        diskMtimeAt: 100,
        lineEnding: "LF",
        hasBom: false,
        lastSeenAt: 1,
      },
      {
        documentId: "d2",
        relativePath: "gone.md",
        status: "PRESENT",
        indexStatus: "READY",
        indexRevision: 1,
        observedHash: "bbb",
        contentHash: "hG",
        parserVersion: "p",
        byteSize: 5,
        diskMtimeAt: 50,
        lineEnding: "LF",
        hasBom: false,
        lastSeenAt: 1,
      },
    ],
    blocks: [],
    recoveryMode: null,
  });
  return { calls, state, registrySnapshot };
});

vi.mock("../../src/index/sync", () => ({
  // 记录调用并返回最小结果（真实 STALE 重试逻辑已有 m4/m5 覆盖）
  runIndexSync: vi.fn(async (_engine: unknown, files: string[]) => {
    h.calls.push(["sync", [...files] as string[]]);
    return { outcome: null, registry: h.registrySnapshot() };
  }),
}));

vi.mock("../../src/index/ipc", () => ({
  indexIpc: {
    registryRead: async () => h.registrySnapshot(),
    auditQuick: async () => h.state.quick,
    auditHashBatch: async () => h.state.windows.shift() ?? { total: 0, offset: 0, files: [] },
  },
}));

function makeSync() {
  const engine = { dead: false } as unknown as EngineClient;
  const onSynced = vi.fn();
  const onOpen = vi.fn(async () => true);
  const ext = new ExternalSync({
    engine: () => engine,
    onOpenFileChanged: onOpen,
    onSynced,
    onError: vi.fn(),
  });
  return { ext, onSynced, onOpen };
}

function ev(rel: string, hash: string | null, own = false, dir = false): FsChangedPathPayload {
  return { rel, hash, size: null, mtimeMs: null, own, dir };
}

describe("M7 ExternalSync", () => {
  it("自写且索引已提交 → 跳过重扫；自写但索引落后 → 重扫", async () => {
    const { ext, onSynced } = makeSync();
    h.calls.length = 0;
    ext.handleFsChanged(ev("a.md", "hA1", true)); // registry contentHash=hA1 相等 → 跳过
    await new Promise((r) => setTimeout(r, 1200));
    expect(h.calls.length).toBe(0);
    ext.handleFsChanged(ev("a.md", "hOTHER", true)); // hash 不等 → 索引未跟上
    await vi.waitFor(() => {
      expect(h.calls.some((c) => c[0] === "sync" && c[1].includes("a.md"))).toBe(true);
    });
    expect(onSynced).toHaveBeenCalled();
    ext.stopTimers();
  });

  it("60s quick：mtime/size 变化的文件与消失的文档都进重扫", async () => {
    const { ext } = makeSync();
    h.calls.length = 0;
    h.state.quick = [
      { rel: "a.md", byteSize: 999, mtimeMs: 100, fileIdentity: null }, // size 变
      { rel: "new.md", byteSize: 1, mtimeMs: 1, fileIdentity: null }, // 未登记
    ];
    await ext.quick(true);
    const sync = h.calls.find((c) => c[0] === "sync")![1];
    expect(sync).toContain("a.md");
    expect(sync).toContain("new.md");
    expect(sync).toContain("gone.md");
    ext.stopTimers();
  });

  it("rolling hash 捕获同 mtime/size 的内容篡改（§13.3 L885）", async () => {
    const { ext } = makeSync();
    h.calls.length = 0;
    h.state.quick = [
      { rel: "a.md", byteSize: 10, mtimeMs: 100, fileIdentity: null }, // stat 与 registry 全等 → quick 漏
      { rel: "gone.md", byteSize: 5, mtimeMs: 50, fileIdentity: null },
    ];
    await ext.quick(true);
    // quick 对同 mtime/size 篡改无感
    expect(h.calls.length).toBe(0);
    h.state.windows = [
      { total: 2, offset: 0, files: [{ rel: "a.md", hash: "TAMPERED", byteSize: 10, mtimeMs: 100 }] },
      { total: 2, offset: 1, files: [{ rel: "gone.md", hash: "hG", byteSize: 5, mtimeMs: 50 }] },
    ];
    await ext.rollingTick();
    const sync = h.calls.find((c) => c[0] === "sync")![1];
    // 只有 hash 变化的文件重扫
    expect(sync).toEqual(["a.md"]);
    ext.stopTimers();
  });

  it("overflow → 分窗推完一整圈", async () => {
    const { ext } = makeSync();
    h.calls.length = 0;
    h.state.windows = [
      { total: 2, offset: 0, files: [{ rel: "gone.md", hash: "hG", byteSize: 5, mtimeMs: 50 }] },
      { total: 2, offset: 1, files: [{ rel: "a.md", hash: "T2", byteSize: 10, mtimeMs: 100 }] },
      { total: 0, offset: 0, files: [] },
    ];
    await ext.fullVerify();
    const syncCalls = h.calls.filter((c) => c[0] === "sync");
    expect(syncCalls.length).toBeGreaterThanOrEqual(1);
    expect(syncCalls[0][1]).toEqual(["a.md"]);
    ext.stopTimers();
  });

  it("目录事件触发 quick（空 stat → 消失文档重扫）", async () => {
    const { ext } = makeSync();
    h.calls.length = 0;
    h.state.quick = [];
    ext.handleFsChanged(ev("sub", null, false, true));
    await vi.waitFor(() => {
      const sync = h.calls.find((c) => c[0] === "sync");
      expect(sync).toBeTruthy();
      expect(sync![1]).toContain("gone.md");
    });
    ext.stopTimers();
  });
});
