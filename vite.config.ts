import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 浏览器预览宿主 stub（仅 dev server；见 scripts/dev-host-stub.js 头注释）：
 * 注入假 __TAURI_INTERNALS__，让 UI 可在普通浏览器预览与截图验收。
 * 真实 Tauri 环境下 internals 已存在，stub 自行跳过，零影响；
 * apply: "serve" 保证生产构建绝不包含。
 */
function devHostStub(): Plugin {
  const code = readFileSync(
    fileURLToPath(new URL("./scripts/dev-host-stub.js", import.meta.url)),
    "utf8",
  );
  return {
    name: "recallmd-dev-host-stub",
    apply: "serve",
    transformIndexHtml() {
      return [{ tag: "script", children: code, injectTo: "head-prepend" }];
    },
  };
}

export default defineConfig({
  plugins: [react(), devHostStub()],
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
