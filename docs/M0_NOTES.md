# M0 技术基线验证记录

日期：2026-09-07 · 执行：Claude（编码 Agent）· 对应设计文档 §18 M0

状态：核心样例已通过自动化验证；WebView2 窗口人工验收与 NSIS 构建进行中（见文末待办）。

## 1. 环境基线

| 项 | 版本（已锁定） |
| --- | --- |
| Windows | 11 Home China x64（开发机），Win10 兼容验证留待 M8 |
| Node / pnpm | 22.18.0 / 10.15.0 |
| Rust 工具链 | 1.98.1（`x86_64-pc-windows-msvc`） |
| C++ 链接环境 | VS 2022 Professional 17.11（MSVC 14.41，SDK 10.0.22621.0，位于 D 盘） |
| WebView2 Runtime | 152.0.4191.66（系统自带） |
| cargo 源 | rsproxy.cn sparse 镜像（`~/.cargo/config.toml`，crates 内容经索引 SHA-256 校验） |

## 2. 锁定的依赖版本（package.json / Cargo.lock 已精确固定）

前端（pnpm，全部 `--save-exact`）：

| 包 | 版本 |
| --- | --- |
| react / react-dom | 19.2.8 |
| @tauri-apps/api | 2.11.1 |
| @tauri-apps/cli | 2.11.4 |
| vite | 8.2.2 |
| typescript | 7.0.2 |
| @vitejs/plugin-react | 6.1.1 |
| @codemirror/state / view / commands / language / search / lang-markdown | 6.7.4 / 6.43.11 / 6.11.0 / 6.12.4 / 6.7.2 / 6.5.2 |
| unified / remark-parse / remark-gfm / remark-frontmatter | 11.0.5 / 11.0.0 / 4.0.1 / 5.0.0 |
| ts-fsrs | **5.4.2（FSRS-6.0 内核）** |

Rust（src-tauri）：

| 包 | 版本 |
| --- | --- |
| tauri / tauri-build | 2.11.5 / 2.6.3 |
| rusqlite（dev，bundled+backup） | 0.40.2 |
| bundled SQLite 引擎 | **3.53.2（实测 `rusqlite::version()`，≥ 设计要求的 3.51.3）** |
| windows（dev） | 0.62.2 |

## 3. 已通过的自动化验证

### 3.1 ts-fsrs（`src/m0/fsrs-sample.ts` + node 预验证脚本）

- 参数按设计 §11.2：retention 0.9 · max interval 3650 · fuzz off · short-term on · learning `1m/10m` · relearning `10m`。
- 空 Card 四档（Again/Hard/Good/Easy）：`repeat()` 预览与 `next()` 实际结果在 due、state、reps 上**逐档一致**（Again→Learning +1m，Hard→Learning +6m，Good→Learning +10m，Easy→Review +8d）。
- JSON 序列化往返：Card 含 `due: Date`、`last_review?: Date`，`JSON.parse` 后必须显式 `new Date()` 复原再喂给库；往返后 Easy 评分的 due/S/D/state 与不经过往返完全一致。证实设计 §11.3 "不能把字符串对象直接传给库" 的约束真实存在。
- 注意：v5 的 Card 携带 `learning_steps` 字段（FSRS-6 新增），适配器序列化白名单须包含。

### 3.2 Worker AST（`src/m0/ast.worker.ts`，UI 面板②）

- unified + remark-parse + gfm + frontmatter 在 Web Worker 中构建完整 mdast。
- 根级 heading 切段、frontmatter 后前言、代码块/引用内 `##` 不产生边界——与设计 §8.1 规则一致（AST 判定，非逐行正则）。50k 行实测数字见 §5。

**关键坑（已修复，M3 正式 BlockEngine 直接受益）**：remark 生态的传递依赖 `decode-named-character-reference@1.3.0` 的 `browser` 条件入口（`index.dom.js`）在模块顶层执行 `document.createElement("i")`——Web Worker 中没有 `document`，导致 Worker 静默加载失败（错误事件是无信息的裸 `Event`，控制台可能无输出，极易误诊）。该包自身提供 `"worker": "./index.js"` 纯 JS 查表入口（`character-entities`）。修复：`vite.config.ts` 增加 `resolve.conditions: ["worker"]`，dev 预构建与生产打包均命中 worker 入口。验证方式：Edge 无头 + CDP 真实时间运行（注意：`--virtual-time-budget` 对 Worker 异步加载会假超时，不可信）。另注意：`optimizeDeps.exclude` 这些 remark 包是错误方向——会把整棵树带出预构建，其中的 CJS 传递依赖（`extend@3.0.2`）缺少 ESM interop 直接报 `does not provide an export named 'default'`。

### 3.3 CodeMirror 6（UI 面板①）

- lineNumbers / history / markdown 高亮 / 折行 / 默认键位可用；5 MiB 级 50k 行文档替换实测数字见 §5。IME 组合输入需人工验收（自动化不可行）。

### 3.4 rusqlite 事务与 Backup（`src-tauri/tests/m0_persistence.rs`）

- bundled 引擎 3.53.2 ≥ 3.51.3（WAL-reset 修复线）。
- `journal_mode=WAL`、`foreign_keys=ON`、`user_version` 写入正常（journal_mode 返回结果行，必须 `query_row` 而非 `pragma_update`）。
- 事务回滚不留半条数据、提交原子可见。
- `backup::Backup` 在线备份到新文件后数据完整。**API 提示**：0.40 的 `run_to_completion(pages, Duration, progress)` 签名与旧文档的 `StepBehavior` 不同。

### 3.5 ReplaceFileW 与故障注入（同文件）

- 带 backup path 的 `ReplaceFileW`：调用后目标=新内容、backup=旧内容、临时文件被消费。符合 §13.2 保存协议第 5 步假设。
- windows 0.62 签名注意：后两参为 `Option<*const c_void>`（传 `None`）。
- 故障注入（§14.4 第 1 行）：子进程写完同目录临时文件后 `exit(101)` 模拟崩溃 → 原文逐字节保留、草稿文件可识别可恢复。通过。

### 3.6 构建

- `pnpm typecheck`（tsc 7.0.2）与 `pnpm build`（Vite 8，含 worker 打包）通过。
- `cargo check` / `cargo test` 通过。dev profile 冷编译约 50s（镜像生效）。

## 4. 与设计文档的差异 / 偏差

- 无架构偏差。样例均为 M0 范围内的最小验证，未实现产品功能。
- `m0_environment` IPC 命令展示 rustc/tauri 版本，属验证用临时命令，M1 起替换为正式命令集。
- `webviewInstallMode` 暂为 `downloadBootstrapper`；M8 按设计改为 `offlineInstaller`。

## 5. 实测数字（用户机器，dev 模式，2026-09-07）

| 指标 | 实测 | 设计预算（M7 目标） |
| --- | --- | --- |
| CM6 载入 50,000 行 / 941,658 字符（替换文档） | 11.3 ms | 5 MiB 文件可编辑 ≤ 2 s |
| Worker 解析示例文档（约 500 字符） | ~4 ms | — |
| Worker 解析 50,000 行 / 941,658 字符 | ~700 ms（≈1.3 s/MB） | 全库 100 MiB ≤ 30 s（需并行/批处理，M7 优化项） |
| ts-fsrs 样例（四档 + 序列化往返） | UI 全部"一致/通过" | — |
| 中文 IME（WebView2，人工） | 用户确认可用 | p95 ≤ 50 ms |
| cargo dev 冷编译 | ~25–50 s | — |

## 5.1 待完成项

- [x] WebView2 窗口人工验收（2026-09-07 用户确认：环境行、CM6 50k、Worker 700ms、fsrs、IME）
- [ ] `tauri build` 产出 NSIS setup.exe，记录体积
- [ ] git 首次提交（含两套 lockfile）

## 6. 后续里程碑输入

- ts-fsrs 5.4.2 / FSRS-6.0 的状态字段白名单：`due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, learning_steps, state, last_review`。
- rusqlite 0.40 与 windows 0.62 的 API 变化点已记录于 §3.4 / §3.5，M1 持久化实现直接采用。
- rsproxy 镜像工作正常，后续里程碑无需调整。
