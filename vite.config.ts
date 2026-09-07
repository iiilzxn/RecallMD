import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    // mdast 解析运行在 Web Worker：优先命中包的 worker 条件导出。
    // decode-named-character-reference 的 browser 入口在模块顶层访问 document（Worker 中不存在），
    // 其 worker/default 入口是纯 JS 查表实现（character-entities），Worker 安全。
    conditions: ["worker"],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
