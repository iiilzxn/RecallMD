# M7 外部变化同步与综合可靠性——实现记录

对照设计 §18 M7（L1166–1174）、§13.3/§13.5/§14.4/§15。实现日期：2026-09-14/15。

状态：**实现完成，自动化全绿 + CDP 驱动 release exe 线上验收通过（2026-09-15）**
（cargo 76 用例 + m7_perf（release 门控）+ vitest 145 过/2 跳过、typecheck/build 干净）。

## 1. 交付范围（对照设计 §18 M7）

| 项 | 实现 |
| --- | --- |
| 完整 Watcher 合并 | ✅ `persistence/watcher.rs`：notify@8.2 递归监听（排除 .recallmd/.git/node_modules、`.recallmd-tmp-*`、非 .md）；300ms 合并去重；稳定窗 200ms×2（≤3s，未稳暂存 2s 重试不判删除）；删除只发无 hash 线索 |
| 内部 hash 识别 | ✅ `(path, committedHash)` 注册表（save 成功登记，TTL 10min/容量 256）；匹配条件必须是 hash 相等；命中仍发前端复核索引已提交（§13.3 L883） |
| 外部重载 | ✅ 打开文件外部变化先走 §13.4 checkExternal（干净重载/dirty 冲突），冲突未解决落 `index_status=CONFLICT` 挡评，解决后 PENDING→重扫→READY |
| 跨文件稳定核对 | ✅ commit 采纳（§13.5 优先级）：② file_identity 一对一（卷序列+文件索引）→ ③ 本轮确认缺席旧路径 + 新路径字节 hash 唯一相等；多候选/批内路径不猜配；document_id 与学习历史保留 |
| overflow/定期补扫 | ✅ overflow→`fs-overflow`→hash 全量核对（分窗推进）；60s quick（stat 存在性/mtime/size vs registry，消失→MARK_MISSING）；10min rolling hash 窗口（捕获同 mtime/size 修改）；前台聚焦节流；启动后 2.5s 首轮 quick |
| Git 冲突诊断 | ✅ 语义落地：rename/checkout 风暴经稳定窗+暂存重试收敛（cargo 风暴测试）；合并冲突产生的 ID 冲突走既有修复面板（M4）；未稳定期不以未扫描定删除（§13.5） |
| 性能优化 | ✅ §15.1 预算实测达标（§3）；三组计数合并单趟 |
| 全部故障矩阵 | ✅ §14.4 十行映射见 §5（既有 7 行 + M7 新增 3 行） |

## 2. 架构落位

```
src-tauri/src/persistence/
  watcher.rs    notify 事件线程（合并/稳定/自写识别/overflow）；随
                workspace_open/close 启停；事件经 AppHandle.emit 推前端
  audit.rs      audit_quick（60s stat 快查）/ audit_hash_batch（滚动 hash 窗口）/
                file_identity_of（CreateFileW+GetFileInformationByHandle）
  store/commit.rs  try_adopt 移动采纳（Phase1 内：旧行迁新路径保 document_id，
                CAS 容纳 expected=0；采纳后块重算为幂等 NOOP——移动完全在文档层）
  store/ops.rs  mark_doc_status（CONFLICT 挡评 / PENDING 待重扫）
  store/dto.rs  DocumentHeaderDto += file_identity；纯删除批合法（§4.3）
  store/review.rs  count_groups 三组计数单趟（10k 规模三连全扫 3× 成本）
src/index/externalSync.ts   四层核对编排（fs-changed 防抖 800ms→runIndexSync、
                quick、rolling、fullVerify）；quick 两段 try（审计静默/重扫上报）
src/ui/M2App.tsx            事件订阅与 60s/10min 定时器随工作区启停；打开文件
                外部变化→checkExternal→CONFLICT 标记（sync 后落防覆写）；useDisk
                解决→PENDING+重扫；启动 2.5s 首轮 quick；聚焦节流
src/index/sync.ts           缺席语义修正：仅 FILE_NOT_FOUND 进空快照（§13.5 L909
                权限拒绝等不参与本轮→引擎 DEFER）
```

## 3. 验证结论

- `cargo test`：**76 通过**（M0–M6 无回归 + m7_watcher 1（真实事件全生命周期）+
  m7_adopt 6（hash/身份采纳、不扫不猜、歧义不猜、副本不采纳、纯删除批））
- `m7_perf`（`cargo test --release -- --ignored`，30 次）：
  1,000 md / 10,000 Block / 100,000 History（SQL 播种 1.2s）——
  **review_queue p50 49.6ms / p95 51.0ms；review_stats p50 14.0 / p95 14.7ms；
  registry_snapshot 22.5 / 23.7ms**——§15.1 预算（到期/统计 p95 ≤ 100ms）内。
  首轮 p95 123ms 为播种后冷页缓存；EXPLAIN 分解（m7_perf_breakdown 留档）：
  无 sqlite_stat1 时计划器选 block_status 全扫（8ms/查询），三组计数合并后
  达标；`INDEXED BY review_due` 强制部分索引实测反劣化至 4.8s（join 方向被
  破坏）已回退——不做无实测依据的计划器干预。
- `pnpm test`：**145 过/2 跳过**（+externalSync.spec 5：自写跳过/quick 可疑+消失/
  rolling 同 mtime/size 篡改捕获/overflow 分窗/目录事件）
- typecheck/build 干净；notify@8.2 经 rsproxy 镜像新增

## 4. 与设计文档的偏差 / 决策记录

1. **外部移动采纳在 commit 层（不在引擎层）**：引擎按块 ID 天然随注释迁移
   （Relocate）；document_id 连续性是文档行属性，由 commit Phase1 的 try_adopt
   完成（身份②→hash③；批内路径排除=副本不采纳）。采纳后块落库字段全未变
   →引擎重算必为 NOOP——移动完全由文档层一次 UPDATE 完成，无第二写路径。
2. **冲突挡评用 index_status=CONFLICT**：队列/评分查询只认 READY（M5 既有
   语义），零新查询；标记时序=sync 后落（sync 会覆写 READY）；解决路径
   （useDisk）→ PENDING + 合成事件重扫。resolveLocalWins/saveAs 经保存流自然
   回 READY，仅 useDisk 需显式触发。
3. **纯删除批合法**（验收发现的缺陷 §6.1）：Watcher 单独同步被删文件时
   documents 空、只有 MARK_MISSING 提案——validate_batch 原拒空文档头，M4
   时代从未出现该形状。现允许"空文档+有提案"，全空仍拒。
4. **启动消失核对交给首轮 quick**：runStartupSync 仍只扫候选（stale/未登记，
   M4 语义不动）；消失文档核对由启动后 2.5s 的 quick(true) 承担（§13.3 L885
   "启动全量枚举核对"的落地位置）。
5. **quick 的静默边界**：审计阶段（enumerate/stat 失败=根不可达）静默放弃
   （§13.5 不得据此定缺失，60s 节拍防刷屏）；重扫阶段错误上报 onError——
   正是这条边界修正让 §6.1 的被吞缺陷浮出。
6. **EXPLAIN 驱动但不强扭计划器**：诊断留档；INDEXED BY 强制提示实测劣化即回退。
7. **file_identity 每次 commit 刷新**：作为短期线索存储（§12.3 原义），移动并
   改写仍可经身份采纳（Rust 测试钉死）。
8. **Watcher 对非 .md 资源不事件**（§13.3"图片资源只更新资源缓存"——MVP 无
   资源缓存，忽略；watcher 测试钉死不产生事件）。

## 5. §14.4 故障矩阵映射

| 注入场景 | 证据 |
| --- | --- |
| 1 写临时文件中途终止 | m1_save 崩溃注入（M1）；操作日志+恢复副本（M4 recovery） |
| 2 替换前目标被改写 | M1 expectedHash CAS（m1_save）；备份核验（M4 backup） |
| 3 文件替换后、SQLite 提交前崩溃 | m4_recovery：FILE_COMMITTED 残留→重开重放收敛 |
| 4 插历史后、写状态前故障 | M5 submit 单事务回滚（m5_review 双事件原子） |
| 5 评分成功但响应丢失 | M5 幂等（m5+M6 线上 DB 锁注入重试不双计） |
| 6 连续保存时继续输入 | M1 SaveCoordinator（m1_save 快乐路径+并发） |
| 7 外部删除 + dirty buffer | M1 checkExternal "gone"（保留缓冲停自动保存）；M7 线上冲突挡评场景含 dirty 路径 |
| 8 Git checkout/rename 风暴/overflow | M7：m7_watcher 风暴收敛（14×300ms 连写→收敛到最终 hash）；overflow→fullVerify 管线（externalSync.spec）；adopt/rename 线上验证 |
| 9 ID 复制/丢失/跨文件/拆分合并 | M3 reconcile 语义 + m4_store（M6 不变量未动） |
| 10 DB/WAL 损坏/磁盘满 | M4 隔离重建（m4_recovery/m4_backup）；磁盘满 M1 错误路径 |

## 6. 线上验收（2026-09-15，CDP 驱动 release exe；工作区 D:\recallmd-m7-acceptance）

- [x] 1. **外部编辑零接触自动检测**：python 改正文（不打开编辑器）→ 5s 内
      registry cv 1→2 自动落库（M6 前不可能——必须打开文件触发重扫）
- [x] 2. **外部移动采纳**：rename redis.md → notes/redis-moved.md → 6s 内
      document_id `b5a2cfb0` 保留、单一 Document 行、两块 ACTIVE 随迁
- [x] 3. **外部删除 → MISSING**：删文件 →（修复 §4.3 后）60s tick 消失核对 →
      两块 MISSING；过程中发现并修复纯删除批被拒且被静默吞的缺陷
- [x] 4. **恢复 → RESTORE**：重建同名文件 → 块经重扫回 ACTIVE（含启动核对）
- [x] 5. **冲突挡评闭环**：打开文件+SendKeys 置脏（save-dirty）→ 外部改同一
      文件 → 冲突 UI + Document index_status=CONFLICT（sqlite 双确认）→
      到期块被队列排除 → "使用磁盘版本"解决 → PENDING→重扫→READY →
      队列重新纳入、编辑器载入外部正文
- [x] 6. 新文件（probe.md）自动注册——watcher→事件→编排→runIndexSync 全链路

## 7. 踩坑记录

1. **notify 8.2 API**：overflow 信号是 `event.need_rescan()`（attrs Flag::Rescan），
   无 `EventFlags`；`recommended_watcher(tx)` 直接收 channel。
2. **windows 0.62 CreateFileW**：主依赖需补 Win32_Security feature（SECURITY_ATTRIBUTES
   参数门控）；dwDesiredAccess 参数类型是 u32（FILE_ACCESS_RIGHTS.0）；
   FILE_SHARE_ALL 不存在（用三标志或）。
3. **vi.mock 工厂提升**：共享 mock 状态必须 `vi.hoisted`；vitest node 环境无
   `window`——计时器用环境无关全局（setTimeout 等）。
4. **纯删除批缺陷的隐蔽性**：三层叠加才暴露——validate_batch 拒空文档头（M4
   契约）× quick 静默 catch（设计上防根不可达刷屏）× 60s 才有一次消失核对。
   修法三管齐下：批合法化 + 两段 try + 启动首轮 quick。
5. **INDEXED BY 的反直觉**：强制部分索引提示让 SQLite join 方向劣化 100×
   （45ms→4.8s）——提示不等于好计划，实测是唯一裁判。
6. **rusqlite 占位符按最高编号计数**：跳号（?1..?7,?9,?10 缺 ?8）报参数数
   不符——连续编号或核对 params 长度。

## 8. 遗留 / 下一里程碑输入

- **M8（发布）输入已备**：性能预算实测记录（§3）；§14.4 矩阵映射（§5）；
  NSIS 链路 M0 已验证；签名证书发布前确认。
- **sqlite ANALYZE/PRAGMA optimize 未做**：当前计划器无统计信息但预算达标；
  若真实库规模增长后查询劣化，先跑 ANALYZE 再评估（EXPLAIN 分解测试已留档）。
- **Watch 时长统计/健康面板**未做（§16 Settings"诊断"的最小项）——可在 M8
  发行说明前补。
- runStartupSync 语义未动（只扫候选）；全量枚举核对职责已由 quick 承担。
