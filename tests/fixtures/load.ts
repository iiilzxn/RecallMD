// fixtures 装载与子集断言助手（vitest node 环境）。
// 子集断言：expect.json 里写出的字段必须与实际一致，未写字段不比对——
// 精确 offset 只钉在边界语义关键的样例上，其余语义断言。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_ROOT = dirname(fileURLToPath(import.meta.url));

export function readFixture(rel: string): string {
  const text = readFileSync(join(FIXTURE_ROOT, rel), "utf8");
  // 风险清单 #1：引擎坐标系统一 LF，fixtures 被 CRLF 污染即失败
  if (text.includes("\r")) throw new Error(`fixture ${rel} 含 CR（CRLF 污染）`);
  return text;
}

export function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, rel), "utf8")) as T;
}

/** 返回 null=通过；否则返回首个不一致点描述。_ 前缀键为注释字段，跳过。 */
export function subsetMismatch(actual: unknown, expected: unknown, path = "$"): string | null {
  if (expected === null || expected === undefined) {
    return (actual ?? null) === expected ? null : `${path}: 期望 ${String(expected)}，实际 ${String(actual)}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: 期望数组，实际 ${typeof actual}`;
    if (actual.length !== expected.length) {
      return `${path}: 期望长度 ${expected.length}，实际 ${actual.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const m = subsetMismatch(actual[i], expected[i], `${path}[${i}]`);
      if (m) return m;
    }
    return null;
  }
  if (typeof expected === "object") {
    if (actual === null || typeof actual !== "object") {
      return `${path}: 期望对象，实际 ${String(actual)}`;
    }
    for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
      if (k.startsWith("_")) continue;
      const m = subsetMismatch((actual as Record<string, unknown>)[k], v, `${path}.${k}`);
      if (m) return m;
    }
    return null;
  }
  return actual === expected
    ? null
    : `${path}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`;
}
