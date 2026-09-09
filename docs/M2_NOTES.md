# M2 Workspace 与文件管理——实现记录

日期：2026-09-09 · 执行：Claude（编码 Agent）· 对应设计文档 §18 M2

状态：**M2 完成**。Rust 测试 26/26 通过（`m2_workspace.rs` 新增 11 个）；前端 typecheck + build 通过；用户人工验收通过（10 项清单：启动屏选根、独占锁、目录树/中文过滤、中文路径、大小写重命名、同名冲突、根外路径、删除恢复、切库守卫、1,000 文件树）。

## 1. 交付范围（对照设计 §18 M2）

| 项 | 实现 |
| --- | --- |
| 选根目录 | 根规范化后校验卷：仅本机固定盘（`GetDriveTypeW == DRIVE_FIXED`）+ NTFS（`GetVolumeInformationW`）；网络路径/可移动介质/非 NTFS 一律 `PATH_REJECTED` |
| manifest | `.recallmd/workspace.json`：`workspaceId` + `formatVersion`，不存绝对路径；版本高于本版拒读；manifest 与 SQLite 双丢时生成新 UUID |
| 最近库 | Tauri 应用配置目录 `recent-workspaces.json`（不存库内）；容量 10，Windows 路径大小写不敏感去重、置顶；损坏按空处理不阻塞启动 |
| OS 独占锁 | `.recallmd/workspace.lock` 上 `LockFileEx` 独占 + `LOCKFILE_FAIL_IMMEDIATELY`，句柄存于激活态；进程终止 OS 兜底释放；锁文件**存在本身不代表占用**，第二实例取得锁失败 → `WORKSPACE_LOCKED` |
| 目录树 | 按需懒展开（`tree_list` 单层）；目录优先、名称大小写不敏感排序；隐藏 `.recallmd`/`.git`/`node_modules` 与点开头目录；仅显示 `.md`；跳过 reparse point |
| 文件名过滤 | `tree_filter` 递归可见 `.md`，大小写不敏感子串，上限 200 条；枚举失败/超深（>64）子目录跳过 |
| 新建文件/目录 | create-new 语义，已存在即 `FILE_CONFLICT` 拒绝覆盖；文件名必须 `.md` 结尾 |
| 库内移动/重命名 | preview（类型/计数/case-only 标记）→ 操作日志 STARTED → `MoveFileExW` 同卷原子 rename 不覆盖 → 事后核验（目标出现、源消失）→ 草稿随迁 → COMMITTED 后清日志 |
| trash 删除恢复 | 移入 `.recallmd/trash/<uuid>/payload/<原相对路径>`（镜像结构防同名冲突）；manifest PLANNED→COMMITTED 两阶段；恢复绝不覆盖现存文件、可改道恢复；草稿随删除入 trash、恢复时跟回 recovery；`trash_id` 强制 UUID 杜绝路径注入 |
| 当前文件切换 | 前端文件树点选 + 编辑器状态随路径切换；dirty 时切换守卫确认 |
| 基础目录核对 | `resolve_root` 规范化（M1 `paths.rs` 路径边界全部复用于相对路径段校验：`..`、盘符、ADS、保留名、结尾点/空格、reparse point） |

## 2. 架构落位

- `src-tauri/src/persistence/workspace.rs`（约 1,030 行）：激活态（进程内单 Workspace，`Mutex<Option<ActiveWorkspace>>`，持锁句柄）、卷校验、manifest、目录树/过滤、新建/移动/删除/trash 全套；命令层（`lib.rs`）只收相对路径，根由 `active_root()` 解析——**M1 的文档命令（read/save/stat/draft×3）一并改为激活态根**，前端不再传根
- `src-tauri/src/persistence/recent.rs`：最近库读写（应用配置目录）
- 移动/删除共用 `.recallmd/operations/<operation_id>.json` 操作日志（action/phase/src/dst/file_count/timestamp），成功后删除；`VERIFY_FAILED` 错误码携带 op id 供排查
- `src/workspace/ipc.ts`：workspace 侧类型化命令客户端
- `src/ui/M2App.tsx`（约 1,190 行，替代 M1App）：启动屏（最近库 + 选择根目录）、侧栏目录树（`Tree.tsx` 懒展开）+ 文件名过滤、文件操作模态（新建/移动/重命名/删除确认，preview 计数）、回收站 UI（列表/恢复/改道）、切库与关闭守卫（dirty 确认）
- capabilities 无新增（对话框插件沿用 M1）

## 3. 验证结论

- Rust 测试 26/26（`cargo test`，2026-09-09 复跑确认）：
  - manifest：创建后 ID 稳定、版本守卫（高版本拒读）
  - 锁：独占生效（第二把锁 `WORKSPACE_LOCKED`）、关闭后释放可重开
  - 未激活时任何命令 → `WORKSPACE_NOT_OPEN`
  - 目录树：过滤/排序/中文文件名
  - 新建：路径校验 + 拒绝覆盖（文件与目录）
  - 移动/重命名语义：同名冲突拒绝、case-only 成功、目录入自身拒绝、核验
  - 删除 → trash → 恢复（原位与改道）；**草稿随删除入 trash、恢复跟回**
  - 移动后崩溃遗留草稿迁移到新路径键
  - 1,000 文件树：list/filter 全量走查可用
- 用户人工验收（2026-09-09，10 项全过）：含中文路径、case-only 重命名、junction/根外拒绝、删目录恢复、dirty 切库不丢
- M0/M1 测试继续通过（无回归）

## 4. 与设计文档的偏差 / 决策记录

1. **大小写重命名单次原子调用**：设计 §13.6 设想"两步经过中间名"避免大小写不敏感 FS 上源=目标；实测 Windows 上对 `README.md → Readme.md` 直接单次 `MoveFileExW` 即原子成功，且比两步少一个中间态窗口，故采用单次调用。配套调整两处核验：case-only 时"目标已存在"命中的是源文件本身（不算冲突）；"源已消失"核验跳过（源路径仍解析到改名后的同一文件）。
2. **目录树只显示 `.md`**：非 md 文件不进树与过滤（知识库定位）；物理移动/删除不受此限——目录整体操作是物理动作，walk 不跳过隐藏目录内的普通文件。
3. **过滤上限 200 条**（`FILTER_LIMIT`，clamp 1–200）：满足 §15.2 交互预算；首版不做分页，超限时用户收窄查询。
4. **最近库列表写失败不阻塞打开**：`record_recent` 失败仅 eprintln（应用配置目录异常不应挡住知识库使用）。
5. M1 的"根 = 文件所在目录 + localStorage 最近文件"权宜按计划移除：现在必须先开 Workspace，最近列表由 Rust 侧管理。

## 5. 踩坑记录

- **`LockFileEx` 的 `lpOverlapped` 必须传真实 `OVERLAPPED`**（读取 Offset 字段），传 NULL 直接 `ACCESS_VIOLATION` 崩溃——不是可选参数。
- Windows `fs::create_dir` 目标已存在返回错误码 183（`ERROR_ALREADY_EXISTS`）而非 `AlreadyExists` 之外的普通 NotFound 语义，需要显式幂等分支；且"已存在"时要确认它是目录不是同名文件。
- 大小写不敏感 FS 下 case-only 重命名：改前探测"目标已存在"与改后探测"源已消失"都会命中（或 miss）源文件自身，核验逻辑必须感知 case-only（见偏差 1）。
- windows 0.62 crate：`DRIVE_FIXED` 在 `Win32_System_WindowsProgramming` feature；`LockFileEx`/`OVERLAPPED` 需 `Win32_System_IO` feature——文档不直观，按符号逐个加。
- React 19 类型删除了全局 `JSX` 命名空间，组件返回类型用 `ReactElement` 而非 `JSX.Element`。
- 串行化测试：workspace 激活态是进程级全局，测试间必须互斥（静态 Mutex 串行锁）。

## 6. 遗留 / 下一里程碑输入

- **Watcher/外部变更监听属 M7**：当前外部对树的增删改要手动刷新；M1 的聚焦检测仍覆盖当前打开文件。
- **移动/删除后的 SQLite 复习索引迁移属 M4**：M2 已把受影响 md 清单写进 trash manifest 与操作日志，M4 可据此做索引搬迁与"跨文件移动不创建第二份状态"。
- 磁盘满/权限异常路径依赖 M1 的错误码映射，未做注入测试（M7 故障矩阵）。
- M3 前置已备：引擎输入 = 相对路径 + 文档字节，输出与 UI/SQLite 无关，可直接复用 M0 Worker 骨架与 M1 读取管线。
