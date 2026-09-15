/* =====================================================================
   dev-host-stub.js —— 浏览器预览宿主 stub（仅 dev server 注入，绝不进构建产物）
   =====================================================================
   用途：在普通浏览器里打开 vite dev URL 时预览 UI（无需启动 Tauri 宿主）。
   真实环境零影响：window.__TAURI_INTERNALS__ 已存在（tauri dev / 生产构建）时整体跳过。

   用法（dev server 运行时）：
     http://localhost:5173/               启动屏（含最近知识库示例）
     http://localhost:5173/?demo=editor   编辑器主界面（自动打开示例文件）
     http://localhost:5173/?demo=review   今日待复习（遮蔽阶段）
     http://localhost:5173/?demo=stats    统计页
     http://localhost:5173/?demo=settings 设置页

   未实现的原生命令以 STUB_UNIMPLEMENTED 拒绝——与真实宿主错误路径一致。
   ===================================================================== */
(function () {
  if (window.__TAURI_INTERNALS__) return; // 真实 Tauri：不干预

  var demo = new URLSearchParams(location.search).get("demo") || "start";
  var now = Date.now();
  var MIN = 60_000;
  var HOUR = 3_600_000;
  var DAY = 86_400_000;

  // ---- 示例数据 ----

  var WS = { workspaceId: "stub-ws-0001", formatVersion: 1, root: "D:\\Notes" };
  var RECENTS = [
    { root: "D:\\Notes", workspaceId: "stub-ws-0001", name: "Notes", lastOpenedAtMs: now - 2 * HOUR },
    { root: "E:\\学习资料\\备考库", workspaceId: null, name: "备考库", lastOpenedAtMs: now - 3 * DAY },
  ];
  var TREE = {
    "": [
      { name: "算法", relativePath: "算法", isDir: true },
      { name: "认知科学", relativePath: "认知科学", isDir: true },
      { name: "读书笔记.md", relativePath: "读书笔记.md", isDir: false },
      { name: "欢迎.md", relativePath: "欢迎.md", isDir: false },
    ],
    算法: [
      { name: "二叉树.md", relativePath: "算法/二叉树.md", isDir: false },
      { name: "动态规划.md", relativePath: "算法/动态规划.md", isDir: false },
    ],
    认知科学: [
      { name: "检索练习.md", relativePath: "认知科学/检索练习.md", isDir: false },
    ],
  };

  var DOC = [
    "# 读书笔记",
    "",
    "跨越几本书的长期主题笔记。**检索练习**与**间隔**是两条主线。",
    "",
    "## 《认知天性》摘录",
    "<!-- recall:block:3f2a9c1e-5b84-4d7a-9c21-8a6f2e0d13b7 -->",
    "",
    "让学习看起来更吃力的方法，反而让记忆更牢固：",
    "",
    "- 检索练习（主动回忆）优于重复阅读",
    "- 间隔安排优于集中突击",
    "- 交错不同题型优于分块刷同类",
    "",
    "### 合困难度的意义",
    "",
    "“必要难度”不是障碍，而是编码深度的信号。",
    "",
    "```text",
    "记忆强度 ≈ f(检索难度, 间隔长度, 反馈质量)",
    "```",
    "",
    "## 间隔重复原理",
    "",
    "遗忘曲线在每次成功检索后被压平，间隔按倍数拉长。",
    "",
    "> 复习的最佳时机是即将忘记的那一刻。",
    "",
    "## 工具链备注",
    "",
    "锚点注释以弱色显示在源码里，渲染层会隐藏。",
  ].join("\n");

  function readDocument(rel) {
    return {
      text: DOC,
      rawByteHash: "stub-" + rel.length,
      byteSize: 2048,
      hasBom: false,
      lineEnding: "LF",
      mtimeMs: now - HOUR,
      fileIdentity: null,
    };
  }

  var QUEUE_ITEMS = [
    {
      blockId: "3f2a9c1e-5b84-4d7a-9c21-8a6f2e0d13b7",
      relativePath: "读书笔记.md",
      title: "《认知天性》摘录",
      headingPath: ["读书笔记"],
      phase: "Review",
      nextReviewAt: now - HOUR,
      needsRecheck: false,
      neverRated: false,
      recallPrompt: "必要难度 —— 检索/间隔/交错",
      startOffset: 0,
      bodyStartOffset: 90,
      endOffset: 420,
    },
    {
      blockId: "b1d0e2f4-33aa-4c55-9d77-2b8c4f1a9e02",
      relativePath: "算法/二叉树.md",
      title: "中序遍历的迭代实现",
      headingPath: ["算法", "二叉树"],
      phase: "Review",
      nextReviewAt: now - 2 * HOUR,
      needsRecheck: false,
      neverRated: false,
      recallPrompt: null,
      startOffset: 0,
      bodyStartOffset: 60,
      endOffset: 300,
    },
    {
      blockId: "c92f8a10-71b4-4e39-8a55-0d3b7e6c21f4",
      relativePath: "认知科学/检索练习.md",
      title: "自由回忆与线索回忆",
      headingPath: ["认知科学", "检索练习"],
      phase: "Learning",
      nextReviewAt: now - 30 * MIN,
      needsRecheck: false,
      neverRated: true,
      recallPrompt: null,
      startOffset: 0,
      bodyStartOffset: 50,
      endOffset: 260,
    },
  ];

  function queueResult() {
    return {
      nowMs: now,
      items: QUEUE_ITEMS,
      counts: { learning: 1, review: 2, newTotal: 1 },
      quota: { limit: 20, usedToday: 3, remaining: 17 },
      nextUpcomingAt: now + 42 * MIN,
    };
  }

  function beginResult(blockId) {
    var item = QUEUE_ITEMS.find(function (i) {
      return i.blockId === blockId;
    });
    return {
      token: "stub-token",
      nowMs: Date.now(),
      state: {
        blockId: blockId,
        relativePath: item ? item.relativePath : "读书笔记.md",
        title: item ? item.title : null,
        headingPath: item ? item.headingPath : [],
        participation: "ENABLED",
        phase: item ? item.phase : "Review",
        generation: 1,
        stateRevision: 1,
        algorithmId: "FSRS",
        algorithmVersion: "stub",
        stateSchemaVersion: 1,
        configJson: "{}",
        stateJson: "{}",
        scheduledDueAt: now - HOUR,
        changeDueAt: null,
        nextReviewAt: now - HOUR,
        stability: 5.2,
        difficulty: 5.8,
        intervalMs: 3 * DAY,
        reps: 6,
        lapses: 1,
        firstReviewAt: now - 30 * DAY,
        lastReviewAt: now - 3 * DAY,
        needsRecheck: false,
        lastReviewedContentVersion: 1,
      },
    };
  }

  var STATS = {
    ratedToday: 12,
    rated7d: 57,
    rated30d: 210,
    distinctBlocks7d: 34,
    ratingsToday: [3, 4, 4, 1],
    ratings7d: [12, 18, 21, 6],
    ratings30d: [45, 60, 70, 35],
    due: { learning: 1, review: 2, newTotal: 1 },
    enabled: 87,
    paused: 4,
    excluded: 2,
  };

  // ---- 命令路由 ----

  var ROUTES = {
    workspace_info: function () {
      return demo === "start" ? null : WS;
    },
    workspace_recent_list: function () {
      return RECENTS;
    },
    workspace_recent_forget: function () {
      return RECENTS.slice(1);
    },
    tree_list: function (a) {
      return TREE[a.dir] || [];
    },
    tree_filter: function () {
      return [];
    },
    read_document: function (a) {
      return readDocument(a.relativePath);
    },
    draft_read: function () {
      return { exists: false, text: null, savedAtMs: null };
    },
    draft_discard: function () {},
    review_queue: function () {
      return queueResult();
    },
    review_begin: function (a) {
      return beginResult(a.blockId);
    },
    review_stats: function () {
      return STATS;
    },
    app_config_read: function () {
      return { dailyNewLimit: 20, autosave: true };
    },
    app_config_set: function () {},
    review_set_participation: function () {
      return 1;
    },
    review_set_prompt: function () {},
    registry_read: function () {
      return { documents: [], blocks: [], recoveryMode: null };
    },
    recovery_status: function () {
      return {
        recoveryMode: null,
        quarantinedTo: null,
        rebuilt: false,
        migrated: false,
        backupTaken: false,
        staleDocuments: [],
        warnings: [],
      };
    },
    enumerate_md: function () {
      return [];
    },
    commit_index_batch: function () {
      return { documents: [], blocks: [] };
    },
    index_complete: function () {},
    audit_quick: function () {
      return [];
    },
    mark_doc_status: function () {},
    backup_db_list: function () {
      return [
        { fileName: "recallmd-20260914.db", byteSize: 458752, createdAtMs: now - DAY },
        { fileName: "recallmd-20260913.db", byteSize: 442368, createdAtMs: now - 2 * DAY },
      ];
    },
    "plugin:event|listen": function () {
      return 1;
    },
    "plugin:event|unlisten": function () {},
  };

  var cbSeq = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    plugins: {},
    transformCallback: function () {
      return cbSeq++;
    },
    invoke: function (cmd, args) {
      var route = ROUTES[cmd];
      if (route) return Promise.resolve().then(function () { return route(args || {}); });
      return Promise.reject({
        code: "STUB_UNIMPLEMENTED",
        message: "浏览器预览 stub 未实现命令 " + cmd,
      });
    },
  };

  // ---- demo 驱动：模拟点击进入各视图（树/导航渲染后触发） ----

  if (demo !== "start") {
    var clickInterval = setInterval(function () {
      if (demo === "editor") {
        var file = document.querySelector(".tree-row .tree-icon.file");
        var row = file && file.closest(".tree-row");
        if (row) {
          row.click();
          clearInterval(clickInterval);
        }
      } else {
        var idx = { review: 0, stats: 1, settings: 2 }[demo];
        var nav = document.querySelectorAll(".sidebar-nav .nav-row")[idx];
        if (nav) {
          nav.click();
          clearInterval(clickInterval);
        }
      }
    }, 250);
    setTimeout(function () {
      clearInterval(clickInterval);
    }, 15000);
  }
})();
