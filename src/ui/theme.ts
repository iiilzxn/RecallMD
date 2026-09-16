// 主题（M9）：浅色 / 深色 / 跟随系统。
// 偏好存 WebView localStorage（UI 层偏好，不属于知识库数据，无需进工作区库）；
// 应用态挂在 <html data-theme="light|dark">，styles.css 按 CSS 变量出两套色。
// index.html 有一段同步的内联引导脚本在 React 挂载前设好 data-theme，避免深色用户启动白闪。

export type ThemePref = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const LS_KEY = "recallmd.theme";
export const THEMEChangeEvent = "recallmd-theme-changed";

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(LS_KEY);
  return v === "light" || v === "dark" ? v : "auto";
}

export function setThemePref(pref: ThemePref): void {
  if (pref === "auto") localStorage.removeItem(LS_KEY);
  else localStorage.setItem(LS_KEY, pref);
  applyTheme();
  window.dispatchEvent(new CustomEvent(THEMEChangeEvent));
}

/** auto → 跟随系统 prefers-color-scheme */
export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref !== "auto") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(): ResolvedTheme {
  const resolved = resolveTheme(getThemePref());
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

/** 当前生效主题（mermaid/代码高亮等非 CSS 渲染器取色用） */
export function currentTheme(): ResolvedTheme {
  const v = document.documentElement.dataset.theme;
  return v === "dark" ? "dark" : "light";
}

/** 系统主题变化时重算（仅 auto 有感）。返回取消函数。 */
export function watchSystemTheme(fn: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const h = () => {
    applyTheme();
    fn();
  };
  mq.addEventListener("change", h);
  return () => mq.removeEventListener("change", h);
}
