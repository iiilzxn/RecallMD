# M4 SQLite Metadata 与恢复——实现记录

对照设计 §18 M4（L1136–1144）。实现日期：2026-09-09/10。

状态：**实现完成，自动化验证全绿**（cargo 54 用例、vitest 109 用例、typecheck/build 干净）。
人工验收清单见 §6（待用户 WebView2 实测）。

## 1. 交付范围（对照设计 §18 M4）

| 项 | 实现 |
| --- | --- |
| 六表迁移 | ✅ `store/schema.rs` DDL_V1 逐字内嵌（六表五索引）；`migrate.rs` user_version 有序迁移 + 迁移前备份钩子 + 高版本拒绝（Offline） |
| Repository DTO | ✅ `store/dto.rs` 输入 deny_unknown_fields（契约漂移=响亮 INDEX_FAILED）；`src/index/ipc.ts` TS 侧镜像 |
| 单连接事务 | ✅ `store/mod.rs` 专用 DB 线程邮箱（Online/Offline 句柄）；所有 SQL 经 dispatch 进入唯一连接 |
| 索引 CAS | ✅ expectedIndexRevision vs live 行；STALE_INDEX 错误码；TS 侧自动重读重试一轮（sync.ts） |
| 软删除/复现 | ✅ MARK_MISSING/KEEP_MISSING/RESTORE/MARK_CONFLICT 转移；DELETED 不降级（引擎+Rust 双侧防线） |
| 操作日志恢复 | ✅ save 日志保留至 INDEX_COMMITTED（index_complete 幂等）；启动扫描标 PENDING/重放 MOVE/DELETE/RESTORE |
| 每日 DB 备份 | ✅ Backup API 在线复制→quick_check+FK 验证→原子改名；本地日 marker；留 7；迁移前留 3 |
| 完整 Workspace 备份 | ✅ backup_full（正文/资源/manifest/一致性 DB/未解决材料；逐文件 hash 前后校验；manifest 原子收尾；绝不覆写）+ verify-first 恢复 |
| ID 冲突修复保存 | ✅ repair.rs 三动作（DuplicateRekey/MissingReinsert/MisplacedRemove），preview 单行 diff，apply 走八步保存协议；M2App 修复面板 |

验收标准六项（L1143）全部有对应测试（见 §3）。

## 2. 架构落位

```
src-tauri/src/persistence/
  store/mod.rs        DB 线程+邮箱+boot 全序（探测→PRAGMA→quick_check→迁移→身份核对
                      →每日备份→操作日志扫描）；损坏=隔离重建、迁移失败=Offline；
                      restore_db 换连接（失败路径兜底重开+隔离目录保全原件）
  store/schema.rs     DDL_V1 / quick_check / FK 检查 / 引擎版本下限 / Workspace 行 upsert
  store/migrate.rs    user_version 迁移器（失败回滚→Offline，不自动重建）
  store/dto.rs        commit/registry DTO + 纯校验（UUID/64hex/枚举/offset/批上限 256 文档 20k 提案）
  store/fsrs.rs       冻结算法身份 ts-fsrs@5.4.2+FSRS-6.0；config_json（§11.2 展开值，
                      实测核对库默认 maximum_interval=36500 须覆写 3650）；
                      空卡 state_json（与库 createEmptyCard().toJSON() 逐键一致，无 last_review 键）
  store/commit.rs     commit_on 单事务：Phase0 校验→CAS→推演（幂等 NOOP 零写入，
                      dirty 走 Cell）→Document 先写（FK 序）→块/ReviewState→提交
  store/query.rs      registry 快照（非 DELETED 文档+全部块含 tombstone）/到期候选（M5 备用）/Settings
  store/ops.rs        移动/删除/恢复 DB 随批（前缀匹配在 Rust 侧，避开 SQL LIKE 转义）
  store/backup.rs     日备/轮换/DB 恢复/完整备份/完整恢复
  store/recovery.rs   启动扫描（save@FILE_COMMITTED→PENDING；fs 残留按磁盘证据幂等重放）、
                      三件套隔离、RecoveryStatus
  repair.rs           锚点行手术（只动选定行）+ preview/apply
  workspace.rs        ActiveWorkspace 增 store/db_join/recovery；open 顺序 §14.3；
                      manifest 缺失交 DB 裁决身份（§7.1 L186）；close=Shutdown+join
  document.rs         操作日志保留至 INDEX_COMMITTED；全局保存队列→按路径队列
src/index/            ipc.ts（13 命令客户端）/ commitBatch.ts（纯拼装）/ sync.ts
                      （runIndexSync STALE 重试、runStartupSync stale+未登记分批 ≤50）
src/engine/           types.ts RegisteredBlock+documentId/needsRecheck；
                      reconcile.ts DELETED 语义三处补缝
src/ui/M2App.tsx      保存流 500ms 扫描内 reconcile→commit→indexComplete；
                      启动收敛；恢复横幅（历史丢失/离线两态）；身份修复面板；库级索引计数
```

### 启动顺序落地（§14.3 L963）

锁 → manifest 读（缺失不补）→ `open_store`（boot：探测→迁移→身份核对→日备→
操作日志扫描）→ manifest 对齐（缺失时以 Workspace 行身份补写）→ 激活 → TS 侧
`runStartupSync`（stale/未登记文件重索引）→ 状态栏库级计数。

### 保存流时序（§13.1 L823 落地）

saveNow（八步协议，日志停在 FILE_COMMITTED）→ clean 后 500ms 防抖 →
registry_read → `engine.reconcile`（首个生产调用方）→ buildCommitBatch →
commit_index_batch（STALE 自动重试一轮）→ index_complete(operationId) 清日志；
INDEX_FAILED 仅 toast"正文已保存，复习索引待修复"，阅读编辑不受阻。

## 3. 验证结论

- `cargo test`：**54 通过**（m0 4 / m1 11 / m2 11 / m4_store 12 / m4_recovery 7 / m4_backup 5 + 单元 4）
  - 验收①：DDL 逐项（六表九索引+关键 CHECK 原文）、FK 孤儿拒绝、CHECK 拒绝
    （非法 status/heading7/63 位哈希/recheck 配对/活 path_key 重复；DELETED 同键放行）、
    生成列 min 语义、原生 due=scheduled_due_at
  - 验收②：CREATE 线级重放零写入（updated_at 字节不变）、UPDATE_META 重放 NOOP、
    UPDATE_CONTENT 首评前后两态（未首评不设 recheck；已首评 min(change_due,now+24h)+
    state_revision+1）、已落地内容变更重放幂等、STALE CAS 双向（过期/未知路径非 0）
  - 验收③：块跨文件移动同批两文档头单 ReviewState；文件改名保 document_id 不加
    index_revision；删除→trash→恢复→RESTORE 全周期参与状态保留
  - 验收④：FILE_COMMITTED 残留→重开→PENDING+stale 列表+日志清理→重提交收敛
    （2 块 READY、正文不回退、index_complete 幂等）；新文件首存崩溃；移动 rename 后
    崩溃重放路径迁移
  - 验收⑤：删库重开 REBUILT_NO_HISTORY、注册表空、零 ReviewHistory；同 .md 重登记
    PAUSED+NEW+first_review_at NULL+reps 0；"从现在重新开始"批量启用；损坏→隔离原件
    保留+QUARANTINED_CORRUPT+正文不动；user_version=99→Offline（registry 拒绝、正文可读）
  - 验收⑥：日备 9→留 7 全验证通过；备份恢复历史完整（PAUSED/has_rating/S/D/reps）、
    全文档 PENDING、同内容收敛不加 content_version；坏备份拒绝且现库不动；完整备份
    往返（正文逐字节、DB、manifest）+篡改拒绝+非空目标拒绝
  - DB_BUSY：外部 EXCLUSIVE 锁→等满 busy_timeout→retryable=true
- `pnpm test`：**109 通过 / 2 跳过**（新增 fsrsContract 3、deletedSemantics 4、
  commitBatch 2；既有 100 无回归）；`pnpm typecheck`、`pnpm build` 干净
  （单 chunk 825KB 警告为既有状况）
- 人工验收：见 §6 清单（WebView2，待用户执行）

## 4. 与设计文档的偏差 / 决策记录

1. **MARK_MISSING/MARK_CONFLICT 把所属文档计为受影响**（index_revision+1）：
   §12.5 L761"全部受影响 Document"按此解释——否则标缺提交后注册表 revision 不动，
   下一批立即 STALE。KEEP_MISSING 幂等跳过不写（重放零写入保持）。
2. **UPDATE_CONTENT 线级重放幂等**：已落地的内容变更原样重发（响应丢失重试）在
   "bodyHash 未变+字段全等"时判 NOOP，而非报错。设计只要求"纯重索引幂等"，此为
   重试语义的必要补强（引擎重算路径本来就是 NOOP）。
3. **损坏探测前移**：0xFF 文件头在 journal_mode PRAGMA 路径不暴露 NOTADB——
   boot 先做 `SELECT count(*) FROM sqlite_master` 探针（11/26 扩展码→DB_CORRUPT→
   隔离重建），PRAGMA 在其后。
4. **空库+manifest 在 = 历史丢失**（§12.6 的"恢复迹象"启发式）：全新库但 manifest
   存在 → REBUILT_NO_HISTORY（新块 PAUSED）；manifest 也缺 = 处女库 → NEW+ENABLED。
5. **fs 随批在 Offline 时跳过**：文件操作是用户主意图，元数据离线不阻断移动/删除；
   路径登记延迟到下次成功打开后由重索引收敛（残余偏差=新文档新 ID，记录在案）。
6. **trash_restore 补 RESTORE 操作日志**：M2 无日志；M4 恢复也要覆盖"fs 完成、DB
   随批未跑"的崩溃窗口（重放按"目标已存在"裁决）。
7. **完整备份期间的文件写**：worker 上运行只暂停 DB 写；并发保存会让逐文件
   hash 前后校验失败→备份整体失败（§14.2.5"重试或明确标记失败"取失败侧）。
   UI 入口属 M6，届时可加"备份中"提示。
8. **state_json 无 last_review 键**：对已装 ts-fsrs 5.4.2 实测，库序列化省略
   undefined；模板逐键对齐库输出（fsrsContract.spec 钉死），而非带 null 键。
9. **close_workspace 仅在 Shutdown 获 Ack 后 join 线程**：避免长备份卡死时 join
   悬挂；未 Ack 则线程脱离自尽。JoinHandle 从 open_store 透出（测试删库需要
   确定性的文件句柄释放）。
10. **MissingReinsert 行号语义**：修复面板提供 0 基行号（该块标题行），锚点行插在
    其上方；合法性由重扫诊断兜底（错位→ID_MISPLACED 可再修）。
11. **M1 测试更新**：保存后操作日志不再清理（保留至 INDEX_COMMITTED 是 M4 契约），
    m1_save 快乐路径改为断言 FILE_COMMITTED→index_complete→清理→幂等。

## 5. 踩坑记录

1. **rusqlite 0.40 `close()` 返回 `Result<(), (Connection, Error)>`**——元组序是
   (连接, 错误)，与直觉相反；恢复换连接路径的类型签名按此写。
2. **`transaction()` 借 &mut**：内层 SQL 函数收 `&Connection`，编排层独占开事务，
   不可嵌套（计划已知，实现时 dispatch/&mut 传递又绕了一次）。
3. **worker 关闭竞态**：Shutdown 的 Ack 在循环内发出、连接 drop 在其后——测试删库
   会撞共享违例。解法：open_store 透出 JoinHandle，Ack 后 join。
4. **windows 0.62 的 `GetLocalTime` 在 `Win32_System_SystemInformation` feature**
   （不在 Time），`SYSTEMTIME` 在 Foundation；按符号逐个查再定 feature。
5. **ErrorCode 枚举无 NotADB 变体**：按扩展码判定（11=CORRUPT、26=NOTADB、5/6=BUSY）。
6. **测试锁中毒级联**：一个持锁断言失败→后续全部 PoisonError 淹没真实原因——
   `serial()` 用 `unwrap_or_else(|p| p.into_inner())` 容忍中毒，各自暴露。
7. **store_followup 比较规范化根**：测试传原始 temp 路径会被当作"未激活"静默跳过
   DB 随批（表现为路径没迁）；实现层函数要么传 active_root() 同源路径，要么先
   resolve_root。
8. **同毫秒备份名撞车**：文件名含毫秒仍可能在快机上相撞——生成前循环探测存在性
   递增 1ms，而非"先占名再改名"。

## 6. 人工验收清单（WebView2，对照 §18 M4 + §14.4）

- [ ] 1. 新文件纳入复习→保存→重启应用：状态栏库级块数稳定（幂等可见）、无重复 ID
- [ ] 2. 手工复制带注释段到另一节→状态栏冲突计数→修复面板"生成新 ID"→冲突消解
- [ ] 3. 外部编辑器删除锚点注释行→刷新→修复面板"恢复此 ID"（行号）→块回到 ACTIVE
- [ ] 4. 外部编辑器改正文→聚焦刷新→自动保存/手动保存后索引收敛（状态栏待同步归零）
- [ ] 5. 保存瞬间杀进程→重开→无异常提示且块数正确（启动收敛 + 日志清理幂等）
- [ ] 6. 关闭应用删除 metadata.sqlite（保留 workspace.json）→重开→"历史丢失"横幅
      →重扫登记为暂停→"从现在重新开始"启用
- [ ] 7. 从 A 剪切块粘贴到 B，分别保存→库级计数不重复（单一状态）
- [ ] 8. （可选跨日）或 backup_db_list 出现日备；backup_db_restore 恢复后历史仍在
- [ ] 9. 完整备份到库外目录→目标含 manifest.json/db/files；恢复到空目录后正文一致
- [ ] 10. 应用内移动/删除文件→索引随迁；回收站恢复→块经重扫 RESTORE 回 ACTIVE

## 7. 遗留 / 下一里程碑输入

- **M5 输入已备**：ReviewState 初始行由 M4 写入（NEW+空算法状态+首提 24h，
  config/state JSON 契约由 fsrsContract.spec 与 Rust 模板双端钉死）；
  `due_candidates_on` 即到期候选查询（§12.5 L774）；submit_review 的 revision CAS、
  request_id 幂等、"沿用/重学双事件同事务"在 ReviewHistory 表约束已就位。
- **needs_recheck/change_due_at 的评分侧清除**（§12.5 L768）属 M5 submit_review。
- **"原计划已过期则立即到期"**（tombstone 复现的调度细化，L358 后半）属 M5。
- **备份/恢复 UI 入口**（设置页、进度、恢复向导）属 M6；命令层已全量就绪。
- **启动全量枚举核对/Watcher/10 分钟滚动校验**属 M7；runStartupSync 目前只做
  stale+未登记文件（未变化已登记文件跳过重解析）。
- 完整备份未暂停编辑器自动保存（见偏差 7）；M6 做 UI 时可加暂停提示。
- M3 遗留确认：`vite build` 单 chunk 825KB 警告依旧（React+CM6+ts-fsrs）。
