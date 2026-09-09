import { defineConfig } from "vitest/config";

// 性能样例（设计 §15.2）单独入口：RUN_PERF=1 才跑 50k 行 / 500 块大样例，
// 常规 pnpm test 不受拖累；本机内存紧张，大样例只在需要时手动跑。
export default defineConfig({
  test: {
    include: ["tests/engine/perf.spec.ts"],
    environment: "node",
    env: { RUN_PERF: "1" },
  },
});
