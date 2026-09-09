import { defineConfig } from "vitest/config";

// 引擎测试跑在 node 环境。不继承 vite.config.ts：那是浏览器构建配置，
// 其 resolve.conditions:["worker"] 专为 WebView Worker 解决 decode-named-character-reference
// 的 document 依赖；node 条件下该包取安全入口，无需也不应套用（M0_NOTES §3.2）。
export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
  },
});
