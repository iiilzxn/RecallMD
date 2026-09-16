// Mermaid 图表渲染（M9）：```mermaid 围栏 → SVG，预览与复习共用。
// 通过 React.lazy 按需加载：文档没有图表时零成本（mermaid ~1MB 不进主包）。
// 安全（§161 修订）：mermaid 以 securityLevel:"strict" 运行（其内部先行消毒），
// 产出 SVG 再过一遍 DOMPurify 后注入——这是全仓库唯一允许
// dangerouslySetInnerHTML 的路径。
// 注意：mermaid 11 的节点标签在 <foreignObject> 内是 HTML（div/span/table），
// 且实测忽略 flowchart.htmlLabels:false——DOMPurify 的 svg-only profile 会把
// foreignObject 整块剥掉导致节点文字消失（2026-09-17 探针页实测 foreignObject 4→0）。
// 故用 DOMPurify 默认安全配置（html+svg+mathml 白名单，仍剥离 script、
// 事件属性、javascript: URL），与 mermaid strict 内部消毒同源。
// 主题：自订阅 theme.ts（含跟随系统变化），切换后自动重绘。

import { useEffect, useRef, useState } from "react";
import { currentTheme, THEMEChangeEvent, watchSystemTheme, type ResolvedTheme } from "./theme";

type MermaidApi = typeof import("mermaid").default;
type DomPurifyApi = typeof import("dompurify").default;

let mermaidPromise: Promise<MermaidApi> | null = null;
let dompurifyPromise: Promise<DomPurifyApi> | null = null;
/** 渲染 id 全局自增：mermaid 会把 id 写进 SVG，两个块同时渲染不能撞名 */
let renderSeq = 0;

function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid").then((m) => m.default);
  return mermaidPromise;
}

function loadDompurify(): Promise<DomPurifyApi> {
  dompurifyPromise ??= import("dompurify").then((m) => m.default);
  return dompurifyPromise;
}

function sanitizeSvg(raw: string, DOMPurify: DomPurifyApi): string {
  // DOMPurify 默认双重封杀 mermaid 标签所依赖的 foreignObject：
  // ① svgDisallowed/DEFAULT_FORBID_CONTENTS 剥标签本体 → ADD_TAGS 放行；
  // ② HTML_INTEGRATION_POINTS 默认仅 annotation-xml（刻意不含 foreignObject 的
  //    加固，严于 HTML 规范）→ 其内 div/span 被命名空间检查杀掉，需把
  //    foreignobject 声明为 HTML 集成点（对象映射整体替换，键小写，带上默认项）。
  // 放行后内容仍按白名单走查：script/事件属性/javascript: 照常剥离。
  return DOMPurify.sanitize(raw, {
    ADD_TAGS: ["foreignObject"],
    ADD_ATTR: ["viewBox"],
    HTML_INTEGRATION_POINTS: { "annotation-xml": true, foreignobject: true },
  });
}

export default function MermaidBlock({ code }: { code: string }) {
  const [theme, setTheme] = useState<ResolvedTheme>(currentTheme);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 竞态防护：只认最后一次 effect 发起的结果 */
  const seqRef = useRef(0);

  // 主题订阅：设置页切换 / 系统深浅变化都触发重绘
  useEffect(() => {
    const sync = () => setTheme(currentTheme());
    window.addEventListener(THEMEChangeEvent, sync);
    const unwatch = watchSystemTheme(sync);
    return () => {
      window.removeEventListener(THEMEChangeEvent, sync);
      unwatch();
    };
  }, []);

  useEffect(() => {
    const seq = ++seqRef.current;
    setError(null);
    let cancelled = false;
    Promise.all([loadMermaid(), loadDompurify()])
      .then(([mermaid, DOMPurify]) => {
        if (cancelled || seq !== seqRef.current) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "dark" ? "dark" : "default",
        });
        return mermaid
          .render(`rmd-mmd-${++renderSeq}`, code)
          .then((r) => {
            if (cancelled || seq !== seqRef.current) return;
            setSvg(sanitizeSvg(r.svg, DOMPurify));
          })
          .catch((e: unknown) => {
            if (cancelled || seq !== seqRef.current) return;
            setError(e instanceof Error ? e.message : String(e));
          });
      })
      .catch((e: unknown) => {
        if (cancelled || seq !== seqRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [code, theme]);

  if (error) {
    return (
      <div className="md-mermaid-error">
        <p className="md-mermaid-msg">Mermaid 渲染失败：{error}</p>
        <pre data-lang="mermaid">
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  if (svg === null) {
    // 加载/渲染期间先展示源码，图就绪后无缝替换（渐进增强，无布局跳动）
    return (
      <pre className="md-mermaid-pending" data-lang="mermaid">
        <code>{code}</code>
      </pre>
    );
  }
  return <div className="md-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
