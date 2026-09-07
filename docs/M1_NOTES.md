# M1 安全 Markdown 编辑器——实现记录

日期：2026-09-07 · 执行：Claude（编码 Agent）· 对应设计文档 §18 M1

状态：**M1 完成**。Rust 集成测试 11/11 通过；用户在 WebView2 窗口人工验收通过（中文输入、编辑、自动保存、Ctrl+S、外部冲突、关闭守卫、草稿恢复）。

## 1. 交付范围（对照设计 §18 M1）

| 项 | 实现 |
| --- | --- |
| 单文件打开 | 对话框（tauri-plugin-dialog）选 `.md`；根 = 文件所在目录（§18 M1 注：M2 才有正式 Workspace） |
| UTF-8/换行/BOM | 读：BOM 检测/剥离、CRLF/LF/MIXED 检测、非法 UTF-8 → UNSUPPORTED_ENCODING 只读；写：还原原 EOL + BOM，MIXED 须显式选择规范化（§7.2） |
| CM6 编辑器 | 高亮/行号/折行/撤销重做/搜索替换（Ctrl+F/H）/链接语法/Markdown 语言/光标行列 |
| 手动/自动保存 | Ctrl+S 即时；输入空闲 1000ms 自动、连续输入最多 10s 强制一次；IME 组合输入暂停 |
| dirty/base 状态 | SaveCoordinator 状态机：clean/dirty/saving/conflict/error |
| 恢复草稿 | `.recallmd/recovery/<sha256(relative)>.draft.md` + meta；打开时检测并提示恢复/丢弃；保存成功自动清除 |
| 保存前 hash 核验 | expectedHash（磁盘原始字节 SHA-256）CAS；替换前二次核验；新文件 ABSENT 哨兵 + 不覆盖的 MoveFileExW |
| 基本冲突 UI | 三选一：使用磁盘版本（本地留底）/ 以本地覆盖（协议自动备份磁盘版）/ 另存新文件 |

## 2. 架构落位

- `src-tauri/src/persistence/`：`error.rs`（§14.1 类型化错误协议 + Win32 错误码映射 5/32/112）、`paths.rs`（§6.3 路径边界：`..`、盘符、ADS、保留名、结尾点/空格、reparse point、`.recallmd` 不可作为正文路径）、`document.rs`（读/stat/保存协议/草稿）
- 保存协议八步（§13.2 顺序微调，见 §4 偏差）：**候选先落盘** → expectedHash 核验 → base 副本 → 操作日志 → 同目录临时文件 create-new+flush → 二次核验 → `ReplaceFileW` 带备份（备份入 `.recallmd/recovery`，同卷）→ 回读校验 → 清理
- `src/editor/`：`ipc.ts`（类型化命令客户端，错误统一 HostErrorShape）、`SaveCoordinator.ts`（保存状态机）、`EditorController.ts`（CM 生命周期，程序化全文替换时重建撤销栈防 Undo 回外部改写，§13.4）
- `src/ui/M1App.tsx`：顶栏/状态栏/横幅/模态框（冲突、另存、关闭守卫、草稿恢复）
- capabilities：`core:default` + `dialog:default` + `core:window:allow-destroy`（关闭守卫）

## 3. 验证结论

- Rust 集成测试（`tests/m1_save.rs`，11/11）：
  - 读取检测（BOM/CRLF/MIXED/哈希/字节数）；非法 UTF-8 → 只读错误
  - 路径逃逸拒绝（`..`/绝对/保留名/结尾空格/`.recallmd`/非 md）
  - 快乐路径：字节回读一致、base/backup 副本正确、候选与日志清理、草稿清除
  - CRLF+BOM 往返保持
  - expectedHash 不符 → FILE_CONFLICT，原文不动、**候选保留**
  - 新文件协议：ABSENT 创建、再次 ABSENT 拒绝覆盖
  - 外部删除 → FILE_CONFLICT（"删除或移动"）
  - 独占句柄（共享读）→ FILE_BUSY，原文原样、恢复材料留存
  - 草稿生命周期写/读/弃
- 用户人工验收（2026-09-07）：编辑、IME、自动保存、外部改写冲突三选一、关闭守卫、草稿恢复均通过
- M0 冒突注入测试继续通过（写临时文件中途崩溃 → 原文+草稿可识别）

## 4. 与设计文档的偏差 / 决策记录

1. **候选副本先于核验落盘**：§13.2 原顺序是"核验 → 恢复材料"。实现将候选提前到第一步——任何失败路径（包括入口哈希冲突、进程崩溃）下本地文本都有磁盘副本，更严格地满足 §14.4"两版保留"。
2. **外部变更检测时机**：M1 仅在窗口聚焦（`onFocusChanged` → stat 哈希对比）与保存协议内检测；完整 Watcher 与周期补扫在 M7。干净缓冲区自动重载并重建撤销栈；dirty 缓冲进冲突态。
3. **冲突解决三选一**："手动合并"按设计属 M7；M1 的"以本地覆盖"即最简合并形态（expectedHash 切到远程哈希，磁盘版被协议自动备份）。
4. **草稿 MIXED 处理**：混合换行文件的草稿按 LF 落盘（草稿只求内容不丢）；正文字节级还原以正式保存为准。
5. **单文件根**：`.recallmd` 建于所选文件所在目录；最近文件记录在 localStorage——两者都是 M1 权宜，M2 换成正式 Workspace 注册与最近列表。
6. 全局保存串行队列（`Mutex<()>`）：单文件里程碑足够，M4 按路径分队列。

## 5. 踩坑记录

- **React 常驻挂载**：编辑器容器 div 若条件渲染（打开文件后才出现），一次性 mount effect 会在宿主不存在时静默跳过 → CodeMirror 永不创建。宿主必须常驻，欢迎页用覆盖层。
- `indentWithTab` 是 `KeyBinding`（来自 `@codemirror/commands`），须放进 `keymap.of([...])` 数组而非 extensions 顶层。
- `EditorState` 无公开 `extensions` 属性；扩展数组须自存实例字段。
- windows 0.62：`ReplaceFileW` 末两参为 `Option<*const c_void>`；`CreateFileW` 的 access 参数是裸 `u32`。
- rusqlite `Backup::run_to_completion` 签名为 `(pages, Duration, progress)`（M0 已记）。
- dev 模式内存压力：系统空闲 <1.5GB 时 dev 栈（vite+WebView2）可能被系统强杀；release 构建占用小得多。

## 6. 遗留 / 下一里程碑输入

- 磁盘满（DISK_FULL）路径已有错误码映射与"不触碰原文件"语义，但未做注入测试（Windows 难以模拟配额）；M7 故障矩阵补。
- 替换前窗口期的真实竞争（两次核验之间外部写入）逻辑已实现（二次核验中止），注入测试待 M7。
- M2 前置已备：路径校验、保存协议、错误协议可直接复用；Workspace manifest/OS 锁/目录树是新增面。
