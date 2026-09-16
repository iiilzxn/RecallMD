# M9 扩展渲染与主题——实现记录

对照设计 §161/§198/§201/§207（M9 修订版）。实现日期：2026-09-16/17。

状态：**实现完成，自动化全绿 + 实机验收通过（2026-09-17）**
（typecheck ✓、vitest 189 过/2 跳过、cargo check ✓ 仅两条既有警告、vite build ✓）。
用户拍板范围：Mermaid + 本地图片 + 预览/复习代码高亮 + 三个小件（`==高亮==`、
脚注与锚点跳转、受限 HTML 白名单）；**明确排除 LaTeX**。追加深色模式（设置页外观
三选：跟随系统/浅色/深色）。预览与复习共用同一渲染组件，所有能力一次实现两端生效。

## 1. 交付范围

| 项 | 实现 |
| --- | --- |
| Mermaid | `MermaidBlock.tsx`（React.lazy 按需）：securityLevel strict + DOMPurify 消毒后注入（全仓库唯一 dangerouslySetInnerHTML 点位）；渲染失败回退源码+错误提示；自订阅主题切换重绘 |
| 本地图片 | Tauri asset 协议：`assetProtocol.enable` + 空静态 scope，workspace_open 时运行时 `allow_directory`、close 时 `forbid_directory` 收回（fs scope 语义 forbid 覆盖 allow）；`data:image` 直接显示；远程 http(s) 仍占位框（离线原则） |
| 代码高亮 | `CodeHighlight.tsx`（React.lazy）：lowlight(highlight.js common 子集) → hast → 受控 React 元素，不走 innerHTML；未就绪先显纯文本 |
| `==高亮==` | text 节点呈现层拆分（`splitMarkText`，Obsidian 语义：`==` 内侧不得贴空白/等号） |
| 脚注 | GFM footnotes：引用按首现顺序编号、可点跳文末定义区、定义带回链；重复引用不重复占回链 id |
| `#锚点` | GitHub 风格 slug（`createSlugger` 去重 -2/-3）；容器内 querySelector 滚动，原文/slug 两种 id 都试 |
| 受限 HTML | 行内 sub/sup/kbd/br + 块级 details/summary 反解析为受控 React 元素；其余照旧零渲染 |
| 深色模式 | `theme.ts`（pref 存 WebView localStorage）+ index.html 内联引导防白闪 + styles.css 全令牌化 `[data-theme="dark"]`；mermaid 跟随主题 |
| 复习定义携带 | 块片段渲染时把全文 definition/footnoteDefinition 原文拼尾重解析（§7.2 L197 兑现，详见 §3） |

## 2. 架构落位

```
src/ui/MarkdownView.tsx  受控渲染重写：全部 M9 能力为渲染层实现，
                         mdast/引擎指纹零改动（block 划界与 body_hash 不变）
src/ui/MermaidBlock.tsx  懒加载图表（mermaid+dompurify 动态 import）
src/ui/CodeHighlight.tsx 懒加载高亮（lowlight 动态 import；hastToReact 纯函数）
src/ui/theme.ts          主题偏好/解析/应用/订阅（THEMEChangeEvent + matchMedia）
src/ui/M2App.tsx         主题初始化、resolveImage（convertFileSrc）、
                         TOC 跳转改 data-offset 容器内查询、ReviewPage 注入
src/ui/ReviewPage.tsx    揭示时存全文传 defsText（反泄露纪律：揭示后才传入）；
                         baseRelative 修正片段内相对链接/图片基准
src/editor/EditorController.ts  defaultHighlightStyle → tagHighlighter（tok-* 类，
                         CSS 令牌控色；顺带激活 M8 写死未生效的标题分级样式）
src-tauri/               tauri.conf.json assetProtocol；Cargo.toml +protocol-asset；
                         lib.rs workspace_open/close 运行时 scope 放行/收回
```

## 3. 关键决策与坑

1. **渲染层扩展，引擎零改动**：mermaid 是 code 围栏的呈现方式、`==高亮==` 是
   text 节点的呈现拆分、details 是 html 节点的白名单反解析——mdast 与
   fingerprint 序列化完全不变，既有笔记的 body_hash/content_version 不受影响。
2. **复习片段定义携带的正解是"拼尾重解析"**：引用式链接与脚注引用在解析期就
   回退字面文本（CommonMark/GFM 语义，node 探针实测），事后合并 defs map 救不
   回——必须把全文 definition/footnoteDefinition **原文按 position 切片拼到片段
   尾部**重新解析；尾部拼接不改变片段内偏移，定义节点渲染层零输出。
   （v0.1.1 起复习片段的引用式链接一直是字面文本，本次一并修复。）
3. **DOMPurify × mermaid foreignObject（验收第一坑）**：mermaid 11 节点标签在
   `<foreignObject>` 内是 HTML div，且实测**忽略** `flowchart.htmlLabels:false`。
   DOMPurify 双重封杀 foreignObject：① `svgDisallowed`/`DEFAULT_FORBID_CONTENTS`
   剥标签本体 → `ADD_TAGS:["foreignObject"]` 放行；② `HTML_INTEGRATION_POINTS`
   默认仅 `annotation-xml`（刻意严于 HTML 规范的加固）→ 内部 div 被命名空间检查
   杀掉 → 需 `{ "annotation-xml": true, foreignobject: true }`。**键必须小写**
   （查找用小写 tagName，`_resolveObjectOption` 只 clone 不归一大小写）；对象映射
   **整体替换**默认值，必须带回 annotation-xml。修复后消毒输出与原始 SVG 逐字节
   一致。排查方法论：vite dev + 探针页（raw/sanitized 并排 + querySelector 计数）+
   无头 Edge 截图 + qread-image 读图。
4. **CM6 类名是 tok-\* 不是 cm-\***：M8 在 styles.css 写的 `.cm-header-*` 规则自始
   是死代码（classHighlighter 用 tok-heading 系列，且当时根本没装 class 系
   highlighter）。本次改用自定义 `tagHighlighter` 下发 tok-*（含 heading1-6 分级），
   编辑器与预览（hljs-*）共用 `--syn-*` 双主题调色。
5. **主题持久化偏离 §184 原构想**：主题存 WebView localStorage 而非 Tauri 应用
   配置目录——它是纯 UI 偏好，且需要在未打开知识库的启动屏阶段生效。已在设计
   文档记录偏离。
6. **asset 协议必须加 `protocol-asset` feature**：不加则 `asset_protocol_scope()`
   不编译、协议处理器根本不存在；静态 scope 留空 + 运行时按激活工作区放行，
   未打开工作区的进程不暴露任何文件，关闭时 forbid 收回。
7. **多实例 id 防撞**：heading id = useId 前缀 + slug；TOC 改走 `data-offset`
   容器内查询（隐藏 DOM 里另一份渲染不会抢 getElementById）。脚注/锚点跳转全部
   容器内 querySelector。

## 4. 安全模型修订（设计 §161 已同步）

- 白名单反解析（sub/sup/kbd/br/details/summary）产出受控 React 元素，不放开
  任意标签/属性，仍无 innerHTML 路径；`<details open>` 仅透传 open，其余属性丢弃。
- Mermaid SVG 注入是全仓库唯一 `dangerouslySetInnerHTML` 点位：mermaid strict
  内部消毒 + 我们的 DOMPurify 第二道（默认白名单 + foreignObject 显式放行）；
  script/事件属性/`javascript:` URL 照常剥离（白名单走查路径源码核对）。
- 本地图片经 asset 协议（scope 限激活工作区）；SVG 图片走 `<img>` 上下文不执行
  脚本；远程图片不自动加载。

## 5. 验证与验收

- 自动化：`tests/ui/markdownView.spec.ts` 重写扩展（白名单/脚注/锚点/图片/
  defsText/懒加载结构断言）+ 新增 `tests/ui/codeHighlight.spec.ts`（hastToReact
  纯函数）；vitest 189 过/2 跳、typecheck/cargo check/vite build 全绿。
- 分包实测：主包 0 处 DOMPurify/hljs（1MB/335KB gzip，与 M8 持平量级）；
  CodeHighlight 163KB 与 mermaid 全家（含 katex/cytoscape 等图型子包）均按需。
- 实机验收（2026-09-17）：用户确认通过；mermaid 修复前后探针页对照验证
  （foreignObject 4→0→7，消毒输出与原文逐字节一致）。

## 6. 未做 / 后续候选

- LaTeX（KaTeX）：用户明确排除，未实现。
- 远程图片"单次授权加载"（§161 原构想）：本版直接不加载，保持离线原则。
- mermaid 恶意载荷注入的探针页实证（Edge headless 挂死未完成）：安全结论基于
  DOMPurify 源码走查 + mermaid strict 内部消毒，出包前可补自动化测试。
- 0.2.0 发行说明与安装包：待出包时回填（沿用 v0.1.1 流程）。
