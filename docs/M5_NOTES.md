# M5 Review Engine——实现记录

对照设计 §18 M5（L1146–1154）、§10/§11 全量。实现日期：2026-09-14。

状态：**实现完成，自动化全绿 + CDP 驱动 release exe 线上验收通过（2026-09-14）**
（cargo 65 用例、vitest 138 过/2 跳过、typecheck/build 干净）。M5 按"无 UI 也能正确
执行完整记忆生命周期"交付；Review 页面属 M6，验收经 `window.__recallmd.review`
服务桥（M2App 挂载）以 CDP 驱动真实 TS scheduler ↔ Rust 事务全链路（见 §5）。

## 1. 交付范围（对照设计 §18 M5）

| 项 | 实现 |
| --- | --- |
| FSRS adapter | ✅ `src/review/scheduler.ts`：§11.3 独立接口（initialize/schedule/preview）；envelope↔Card 无损往返；身份/配置漂移即抛错；nowMs 全注入 |
| 固定时钟 | ✅ `src/review/clock.ts` 双轨（wall+monotonic 观测，wall 回退 >5s 本地拦截）；Rust 侧 ±10s 容差 + 进程 wall/monotonic 5 分钟偏离守卫 + 倒跳拒绝 |
| 四 Rating | ✅ §10.4 名称↔1–4 存储；预览 repeat、提交 next（点击时新 now 重算） |
| 首次 due | M4 已写（NEW+空状态+24h）；重置 due=now（`initialize`/reset_block） |
| 日配额 | ✅ 本地日窗口（Rust GetLocalTime 推导 [start,start+24h) UTC 窗）统计 `first_review_at`；只限终身首评；队列侧截流 + 提交侧兜底双防线 |
| 暂停排除 | ✅ PAUSE/RESUME/EXCLUDE/INCLUDE 各写一条历史事件，不动算法 due/S/D/last_review；EXCLUDED 无自动恢复 |
| 变更沿用/重学 | ✅ KEEP=ACCEPT_CHANGE+RATE、RESET=RESET+RATE 双事件单事务（§10.3 L413 同事务约束）；单独 RESET 命令 |
| revision CAS | ✅ 令牌绑定五元快照（content_version/body_hash/document_hash/index_revision/state_revision）+ participation/status/到期复核 |
| 幂等提交与历史快照 | ✅ request_id 先查重（已存 RATE 原样返回零写入）；before/after_state_json 完整 envelope 快照；子事件 request_id=`{主UUID}:keep/:reset` 确定性派生 |

验收标准四项全部有对应测试（§3/§5）：状态与时间边界（golden 覆盖逾期/日界线/
分钟间隔/暂停恢复）；断点无半条评分（双事件同事务 + 事务回滚测试）；超时重试只算
一次（幂等重放 Rust+wire 双验）；旧内容 token 被拒（TOKEN_STALE wire 实测）。

## 2. 架构落位

```
src/review/
  scheduler.ts   FSRS 适配器（唯一生产封装 ts-fsrs@5.4.2）：envelope、reviveCard
                 （Date 显式还原）、schedule/preview/initialize、toOutcome（wire DTO）、
                 envelopeFromRow（review_begin 应答→envelope）
  clock.ts       createSystemClock/createFakeClock；wall 回退检测 + ClockAnomaly
  ipc.ts         五命令客户端 + DTO 镜像 + REVIEW_ERROR_CODES/RATING 映射
  service.ts     ReviewService：queue/begin/previewIntervals/submit/setParticipation/
                 resetBlock；submit 内置一次可重试重试（复用同一请求对象）
  runtime.ts     生产单例（M6 Review UI 落点；M5 验收桥）
src/ui/M2App.tsx wsInfo 就绪挂 window.__recallmd.review（M6 页面化后移除）
src-tauri/src/persistence/store/review.rs
                 review_begin_on / submit_review_on / set_participation_on /
                 reset_block_on / review_queue_on + ReviewTokens（worker 线程独占，
                 容量 64 逐旧）；validate_outcome（投影一致性）；local_day_window
store/mod.rs     DbAction 增 5 变体；worker_loop 持令牌表；dispatch 增臂
lib.rs           review_begin/review_submit/review_queue/review_set_participation/
                 review_reset_block 五命令
```

### submit_review 事务序（§12.5 L762）

request_id 查重（命中→重放返回，零写入）→ 令牌存在性 → 定位/参与前置 + 五元
快照 CAS（不符→TOKEN_STALE 并销毁令牌）→ 时钟三查（wall/mono 偏离、±10s 容差、
不早于 last_review）→ 到期复核 → Rating 1–4 → recheck 配对（true↔决策必填）→
算法身份冻结校验 → 日配额（仅 first_review_at IS NULL）→ validate_outcome
（due ISO↔scheduledDueAt、state↔phase、reps/lapses、S/D NULL⇔空状态、
interval==due-now）→ 子事件（KEEP 清 recheck / RESET 空状态 gen+1）→ RATE 事件
+ 行更新（投影与 state_json 同一事务同一结果）→ commit → 销毁令牌。

## 3. 验证结论

- `cargo test`：**65 通过**（M0–M4 54 无回归 + m5_review 11）
  - begin/令牌：到期前置、暂停拒、快照签发
  - submit：快乐路径行/历史/投影一致；幂等重放零写入且令牌耗尽后仍可重放；
    TOKEN_STALE 两路（state_revision 推进 / content_version 变化）且销毁令牌
  - 双事件：KEEP→[ACCEPT_CHANGE,RATE] rev+2、RESET→[RESET,RATE] gen+1 保留
    first_review_at；缺/多决策拒
  - 时钟：漂移 >10s 拒、倒跳（早于 last_review）拒、未到期 REVIEW_REJECTED
  - 配额：limit=1 第二新块 QUOTA_EXCEEDED；重置块再评不占额；队列隐藏但计数
  - 参与：PAUSE/RESUME 字节不动调度、事件配对 revision、非法转换拒、可作用
    于 MISSING 块；EXCLUDE 不进队列、INCLUDE 恢复即到期
  - 重置：空状态 gen+1 due=now lrcv=NULL；重置后立即可 begin
  - 队列：LEARNING→REVIEW→NEW 分组、NEW 占额/不占两路、counts/quota
  - 投影校验：phase/due/interval/S-D/reps 五类不一致全拒；未知键放行（§11.3 无损）
  - tombstone：MARK_MISSING→RESTORE 后 due 不变，过期即入队（M4 遗留输入闭环）
- `pnpm test`：**138 过/2 跳过**（新增 review 4 文件 25 用例：golden 5、scheduler 7、
  seam 4、service 9——2 跳过为既有 RUN_PERF 门控）
- golden fixtures（`tests/fixtures/fsrs-golden/`，generate-golden.mjs 生成入库）：
  首评四 Rating（Again 1m / Hard 6m / Good 10m / Easy 8d 毕业——Hard 6m 为库实测，
  非手拍）、学习→毕业→遗忘重学→再毕业 7 步链路、逾期 300 天、重置=空卡无泄漏、
  日界线不吸附零点。升级 ts-fsrs 后 golden 变红即调度行为变化，须走 §11.4 审阅
- `pnpm typecheck`、`pnpm build` 干净（chunk 警告为既有状况）

## 4. 与设计文档的偏差 / 决策记录

1. **occurred_at=UI 动作时间、created_at=Rust 入库时间**：M4 的"TS 不传时间"是
   索引写路径的时钟纪律；评分是用户动作，动作时间在 UI 产生（§12.1 历史时间
   双字段的原义）。防线：±10s 容差 + 倒跳拒绝 + wall/mono 偏离守卫，越界=TIME_ANOMALY。
2. **Rust 不复算 FSRS、校验结构一致性**：算法推进只在 TS（冻结契约单一来源）；
   Rust validate_outcome 钉死投影↔state_json 五组关系，不一致即停（§11.3 L501）。
   与 M4"TS 拼装、Rust 校验落库"同构。
3. **日配额窗口 Rust 侧推导**（GetLocalTime 距本地午夜毫秒→[start,+24h) UTC 窗），
   不信任 TS 传窗；DST 切换日的窗口与真本地日可差 ≤1h，配额场景可接受。
4. **begin 也查到期**（§10.2 可评分条件前置），提交侧二次复核；未到期提交=
   REVIEW_REJECTED 而非令牌错误（令牌快照不含 due，due 变化必然伴随 revision
   推进，真实场景不会出现"快照同而 due 变"）。
5. **change_resolution 只写 RATE 行**：子事件行（ACCEPT_CHANGE/RESET）的事件类型
   已表达决策，字段留 NULL；RATE 行携带该评分的决策上下文（§12.3 L586）。
6. **reset 清 last_reviewed_content_version（NULL）**：重置后无已评分版本；
   recheck 触发仍依据 first_review_at（终身保留），后续内容变更照常进确认流。
7. **队列 NEW 组两路查询合并**：占配额路 LIMIT=剩余名额、重置路不占；合并后按
   (next_review_at, block_id) 排序，再并入学习→复习之后，截 page（§10.2 L398
   "分组查询再组合"落地）。counts.new_total 统计全部到期 NEW 不隐藏积压。
8. **令牌表在 DB worker 线程内**（非全局锁）：worker 生命周期=工作区会话，切换
   工作区自然失效；容量 64 逐旧；REVIEW_REJECTED 不销毁令牌（可补决策重交），
   TOKEN_STALE/成功才销毁。
9. **M2App 挂 window.__recallmd.review 服务桥**：M5 无 UI 的验收通路；M6 Review
   页面化后移除（runtime.ts 单例保留为 UI 落点）。
10. **暂停/排除不改 body 也不要求文档可读**：历史引用取最后一次成功索引的
    content_version/body_hash/document_hash（§12.5 L768）；RATE 则必须新鲜核实。

## 5. 线上验收（2026-09-14，CDP 驱动 release exe；工作区 D:\recallmd-m5-acceptance）

全链路（真 WebView 里真 ts-fsrs ↔ 真 Rust 事务 ↔ 真 SQLite）：

- [x] 1. 新块登记 24h 首提未到 → begin 拒（REVIEW_REJECTED）；队列空、配额 20/0
- [x] 2. reset_block 拨到期 → 预览四间隔 = golden 逐值（1m/6m/10m/8d）
- [x] 3. 提交 Good：stateRevision 0→1→2、quota usedToday=1；请求恰好 8 键 camelCase
- [x] 4. **同 requestId 重放（令牌已耗尽）→ replayed:true、零重复计数**
      （M4 §4.12 类接缝的高危路径，线上实测通过）
- [x] 5. begin 后暂停 → 旧令牌提交 REVIEW_TOKEN_STALE；暂停期队列空；
      恢复后原计划已过期 → 立即回队列（不冻结时间）
- [x] 6. 外部编辑正文 → 树点击打开重扫 → contentVersion 2 + needsRecheck
      （启动同步按 M4 设计跳过未变化的已登记文件，外部变更检测属 M7）
- [x] 7. 变更窗到期后：无决策提交拒；KEEP 提交 → [ACCEPT_CHANGE, RATE] rev 6→8、
      last_reviewed_content_version=2（评的是新正文）
- [x] 8. 再 reset + Easy → REVIEW/8 天（= golden）；事件序 9~10 [RESET, RATE(4)]
- [x] 9. sqlite 终核：7+2 事件 after=before+1 连续（ACCEPT_CHANGE 前 5→6 为索引
      recheck 递增，§12.5 允许间隔）；state_json 含 last_review 键；RATE 快照 13 键

## 6. 踩坑记录

1. **rusqlite 元组行类型不回传推断**：query_row 闭包里 `r.get(0)` 与后续断言无
   关联时推断为 ()——一律 turbofish（`r.get::<_, i64>(0)`）。
2. **闭包捕获 &mut 后再调用自身方法**：`stale` 闭包内 tokens.remove 需 `let mut
   stale`；NLL 下最后使用点之后才能再次可变借用 tokens。
3. **同文档多块测试的 header revision**：commit 后 index_revision=1 起，第二个
   CREATE 批必须 expected=1（STALE_INDEX 教训在测试侧重演）。
4. **tsgo（tsc 7.0.2）增量检查漏报既有类型错**：reconcile-contract.spec 的
   statusReason/blockId 可空两个错误 M4 期未被报告，本次全量检查浮出——增量
   缓存不可全信，里程碑收尾建议删 .tsbuildinfo 全量跑一次。
5. **vitest expect() 类型只收 1 参**：第二参 message 是 chai 运行时能力、类型上
   不存在——自定义失败上下文用模板字符串进断言值或注释。
6. **评分后 due=+10m**：连续评分测试之间必须重新拨到期（make_due/reset），
   否则 begin 拒——真实语义使然，测试侧要记得"时间流逝"。
7. **console 显示 GBK 乱码**：HostError 中文 message 经 python 控制台回显乱码
   （M4 已知）；code 字段干净，验收以 code 为准。

## 7. 遗留 / 下一里程碑输入

- **M6 输入已备**：`reviewService()` 单例（runtime.ts）+ 五命令客户端 + 队列/配额
  DTO；Review 页面（先回忆再揭示、四结果预览、修改确认二选一、暂停/排除、简版
  统计、设置含 daily_new_limit 0–100 修改入口、备份/恢复 UI 入口）。
- **daily_new_limit 修改命令未暴露**：读路径（settings key `review.daily_new_limit`，
  缺省 20 钳 0–100）已就绪；M6 设置页随写命令一并加。
- **简版统计命令未做**：M5 功能表无此项（属 M6）；历史表索引已备（history_rating_time）。
- **RELEARNING 线上场景未单独驱动**：需 REVIEW 卡评 Again（wire 上未走完该分支）；
  golden/Rust 测试已覆盖，M6 UI 验收自然会经过。
- **窗口.__recallmd.review 桥**：M6 页面化后移除。
- M7 不变：Watcher/全量枚举核对/滚动校验（本次再次验证 runStartupSync 跳过
  未变化的已登记文件）。
