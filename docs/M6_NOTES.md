# M6 Review UI 与产品闭环——实现记录

对照设计 §18 M6（L1156–1164）、§5.2/§5.3/§16/§17.3。实现日期：2026-09-14。

状态：**实现完成，自动化全绿 + CDP 驱动 release exe 线上验收通过（2026-09-14）**
（cargo 69 用例、vitest 140 过/2 跳过、typecheck/build 干净）。验收以真实 DOM
点击/键盘事件 + sqlite 直核三路完成（工作区 `D:\recallmd-m6-acceptance`）。

## 1. 交付范围（对照设计 §18 M6）

| 项 | 实现 |
| --- | --- |
| Review 页面 | ✅ `src/ui/ReviewPage.tsx`：会话队列、题面（路径/祖先标题/标题，无标题前言显示"文件名 · 前言"）、提示编辑 |
| 先回忆再揭示 | ✅ 隐藏阶段正文字节不进页面（揭示动作后才 read_document 切片）；显示原文(Space)/展开上下文正文 |
| 上下文使用标记 | ✅ 展开上下文正文 = 揭示 + `context_used=true`（§5.2 L100） |
| 四结果预览 | ✅ 揭示时 previewIntervals 现算（分钟/天格式，§11.2 L460） |
| 修改确认 | ✅ needsRecheck 横幅二选一，未决前按钮禁用 + 键盘拦截；KEEP/RESET 随评分提交 |
| 暂停/排除 | ✅ 当前题暂停（可恢复）/永久排除按钮，即时出会话 |
| 简版统计 | ✅ StatsPage：仅 RATE 原始计数（今日/7/30 天、不同块数、四档分布、当前状态）；无记忆率推断 |
| 设置 | ✅ SettingsPage：Workspace/时区、新内容日配额 0–100、自动保存开关、备份/恢复、冻结算法诊断 |
| 备份/恢复入口 | ✅ 每日备份列表/立即备份/单库恢复；完整备份/恢复（目录选择器） |
| 本地预览复用 | ✅ M5 scheduler preview 直用 |
| 键盘/IME | ✅ Space 揭示、1–4 评分、Esc 返回；输入框/IME 焦点不触发（target 判定 + isComposing） |

验收标准逐项见 §5。

## 2. 架构落位

```
src/ui/ReviewPage.tsx    复习状态机（loading/hidden/revealed/done）；跳过本会话集合；
                         TOKEN_STALE→同题重 begin；QUOTA_EXCEEDED→跳过推进；其余错误
                         留题重试且复用 requestId（§10.4）；提示保存后同题重 begin
src/ui/StatsPage.tsx     统计卡片 + 刷新；空态"完成首次复习"
src/ui/SettingsPage.tsx  知识库/复习/备份恢复/诊断四节；目录选择走 dialog 插件
src/ui/M2App.tsx         三视图（editor/review/stats/settings）+ 侧栏导航与到期角标
                         （评分后/启动同步后刷新，queue(1) 取计数）；编辑器宿主常驻
                         仅 CSS 隐藏（CM 实例不重建）；启动读 appConfig 应用自动保存
src/review/ipc.ts        +reviewStats/appConfigRead/appConfigSet/reviewSetPrompt；
                         QueueItemDto +recallPrompt/startOffset/bodyStartOffset/endOffset；
                         ReviewQueueResultDto +nextUpcomingAt
src/review/service.ts    +stats/appConfig/setPrompt/now()；submit 接受外部 requestId
src/editor/SaveCoordinator.ts  setAutosaveEnabled（关时只写草稿兜底；Ctrl+S 不受影响）
src-tauri store/review.rs      +review_stats_on/app_config_on/app_config_set_on/
                         set_prompt_on；队列项带提示与 offsets；next_upcoming_at
lib.rs                   +review_stats/app_config_read/app_config_set/review_set_prompt
```

## 3. 验证结论

- `cargo test`：**69 通过**（M0–M5 无回归 + m6_review_ui 4）
  - 队列项带提示/offsets；next_upcoming_at（有未到期→其 due；全到期→NULL）
  - 统计：3 评 2 块 → today/7d/30d=3、distinct=2、分布 [1,0,1,1]；PAUSE 不计入
  - 配置：缺省 20/true；7/0 写读回环；101/"yes"/evil.key 拒且不落库；配额即时生效
  - 提示：201 字符拒；题面变化使令牌失效（begin→set_prompt→submit=STALE）；
    清回 NULL；未知块拒
- `pnpm test`：**140 过/2 跳过**（service.spec +2：requestId 复用、新方法透传+now()）
- typecheck/build 干净

## 4. 与设计文档的偏差 / 决策记录

1. **上下文正文 = 块完整切片（含标题行与锚点注释）**：read_document 按
   startOffset..endOffset 切；普通揭示是 bodyStartOffset..endOffset（直属正文）。
   两级揭示都以显式点击为界，上下文路径记 context_used。
2. **块提示编辑放 Review 页当前题卡**：§16 的"Block 详情侧栏"（Editor 页）整体
   延后（记录为遗留）；提示保存使 state_revision+1 → 同题重 begin（题面变化语义，
   §10.4），无历史事件（§12.5 L766 允许）。
3. **深色模式未做**：styles.css 既有浅色硬编码体系（M2 起），§16"系统浅色/深色"
   延后（§17.2 允许裁剪美化项；已记录）。
4. **跳过语义补全（验收发现）**：会话结束重拉队列时排除本会话跳过的块——否则
   "跳过仅本会话"退化为立即回场。空态三态文案（还有到期已跳过/配额用完/真无到期）。
5. **自动保存开关的作用域**：仅停用自动落盘；草稿兜底、Ctrl+S、八步保存协议
   不变（§13.1 协议安全门槛不因设置降低）。
6. **诊断节为静态信息**（冻结算法三元组+参数）；app/sqlite 版本号注入延后（M8
   发行说明统一记录）。
7. **重试按钮不做**：失败留题后用户重按原评分按钮即重试（requestIdRef 已保留，
   结果未明的重放由 Rust 幂等承接）——比独立"重试"按钮少一个错评入口。

## 5. 线上验收（2026-09-14，CDP 驱动 release exe；真实 DOM/键盘/sqlite 三侧）

- [x] 1. 三块登记→拨到期→侧栏角标 3→进 Review：题面 `redis.md / M6 验收库 / 持久化`，
      **隐藏阶段四个答案串零泄露**（innerText 扫描）、无评分按钮
- [x] 2. Space 揭示→正文+四按钮（1/6/10 分钟+8 天预览）；**输入框内按 3 不评**、
      **isComposing 按 3 不评**、真 3 → Good 进下一题
- [x] 3. 跳过（无事件）→ 下一题鼠标路径 Easy → DB 恰 2 条 RATE；会话末重拉不回场
      （修复缺陷 4 后复验）
- [x] 4. **DB 独占锁注入**：评分点击→busy 等待中留在题→5s×2 后错误横幅仍在题→
      解锁重点同按钮→成功且**不双计**（线上 requestId 复用）
- [x] 5. 外部改正文→编辑器打开重扫→cv=2+recheck→变更窗到期→Review 显示"正文已变更"
      横幅→未选时按钮禁用+键盘拦→选"沿用进度"→Good→**ACCEPT_CHANGE(rev3)+RATE'KEEP'
      (rev4)**、lrcv=2（评的是新正文）
- [x] 6. 统计页：今天 4 / 7 天 4 / 30 天 4 / 不同块 3 / Good×3+Easy×1、Again/Hard×0
      ——恰等于 4 条 RATE（ACCEPT_CHANGE/跳过/暂停不计）
- [x] 7. 设置页：立即备份 toast+列表 2 行；配额 7 写入生效（review_queue.quota.limit=7）；
      自动保存开关 → app_config_read 回读 {7,false}（已还原 20/true）
- [x] 8. 关闭重开：5 事件无损、reps (2,1,1)、usedToday=3 保持、全部未到期不回场、
      稍后到期时刻正确

## 6. 踩坑记录

1. **导航 toggle 语义**：已在 Review 视图时点"今日待复习"回到编辑器——CDP 脚本
   按单一入口写会误触；UI 语义保留（再点返回），脚本侧改走"再查一轮"。
2. **React 受控输入的程序化赋值**：`input.value=x` 不触发 onChange，须用
   `HTMLInputElement.prototype.value` 的原生 setter + dispatchEvent('input')。
3. **会话结束即重拉的回场问题**：见偏差 4——"跳过仅本会话"必须贯穿到重拉过滤。
4. **编辑器宿主不可卸载**：CM 实例挂在常驻 div，视图切换只能 CSS 隐藏
   （`display:none`），否则 EditorController 状态全失。
5. **quota usedToday(3) ≠ ratedToday(4)**：前者数终身首评、后者数全部 RATE——
   两处口径不同是设计使然（§10.2 L399 vs §12.5 L787），UI 同页展示时别混用。

## 7. 遗留 / 下一里程碑输入

- **M7 输入已备**：外部变更检测仍是"编辑器打开文件触发重扫"（本次 KEEP 流即走
  此路径）；Watcher/全量枚举核对/滚动校验/故障矩阵全部属 M7（§18 M7）。
- **Editor 页 Block 详情侧栏**（§16"当前 Block 提示与参与开关"）：提示编辑已在
  Review 页提供；编辑器内按块操作（暂停/恢复/排除单块入口）延后，命令层全备。
- **深色模式**：styles.css 硬编码浅色，需引入 CSS 变量层（§17.2 允许的裁剪项）。
- **诊断版本号**：app/sqlite 版本注入延后至 M8 发行记录。
- **评分按钮预览间隔的时点**：揭示时现算展示（正式提交用提交时刻新算，§10.4
  已满足）；揭示后长停留的分钟级漂移可接受。
- Statistics"自评回忆成功比例"（Hard+Good+Easy）未展示——按 §16 L1051 优先只给
  原始分布。
