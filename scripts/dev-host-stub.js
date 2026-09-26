/* =====================================================================
   dev-host-stub.js —— 浏览器预览宿主 stub（仅 dev server 注入，绝不进构建产物）
   =====================================================================
   用途：在普通浏览器里打开 vite dev URL 时预览 UI（无需启动 Tauri 宿主）。
   真实环境零影响：window.__TAURI_INTERNALS__ 已存在（tauri dev / 生产构建）时整体跳过。

   用法（dev server 运行时）：
     http://localhost:5173/               启动屏（含最近知识库示例）
     http://localhost:5173/?demo=editor   编辑器主界面（自动打开示例文件）
     http://localhost:5173/?demo=review   今日待复习（遮蔽阶段）
     http://localhost:5173/?demo=learning 立即开始学习（新题目标设置）
     http://localhost:5173/?demo=stats    统计页
     http://localhost:5173/?demo=settings 设置页
     http://localhost:5173/?demo=onboarding 空白示例知识库，验收首次使用流程（仅内存）

   未实现的原生命令以 STUB_UNIMPLEMENTED 拒绝——与真实宿主错误路径一致。
   ===================================================================== */
(function () {
  if (window.__TAURI_INTERNALS__) return; // 真实 Tauri：不干预

  var demo = new URLSearchParams(location.search).get("demo") || "start";
  var workspaceActive = demo !== "start" && demo !== "onboarding";
  var memoryDocuments = {};
  var memoryVersions = {};
  var saveSequence = 0;
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
    "```mermaid",
    "flowchart LR",
    "  A[记录知识] --> B[主动回忆]",
    "  B --> C[核对与反馈]",
    "  C --> D[间隔复习]",
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
      text: Object.hasOwn(memoryDocuments, rel) ? memoryDocuments[rel] : DOC,
      rawByteHash: "stub-" + rel.length + "-" + (memoryVersions[rel] || 0),
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
      phase: "NEW",
      nextReviewAt: now + DAY,
      needsRecheck: false,
      neverRated: true,
      recallPrompt: null,
      startOffset: 0,
      bodyStartOffset: 50,
      endOffset: 260,
    },
  ];

  // Derive the first sample block's range from its displayed document.
  QUEUE_ITEMS[0].startOffset = DOC.indexOf("## 《认知天性》摘录");
  QUEUE_ITEMS[0].bodyStartOffset = DOC.indexOf("让学习看起来更吃力的方法");
  QUEUE_ITEMS[0].endOffset = DOC.indexOf("\n## 间隔重复原理");
  QUEUE_ITEMS[2].startOffset = QUEUE_ITEMS[0].startOffset;
  QUEUE_ITEMS[2].bodyStartOffset = QUEUE_ITEMS[0].bodyStartOffset;
  QUEUE_ITEMS[2].endOffset = QUEUE_ITEMS[0].endOffset;

  // In-memory demo state for exercising pause → restore and settings feedback.
  var config = { dailyNewLimit: 20, autosave: true };
  var jevDemo = new URLSearchParams(location.search).get("jev");
  var jevConfig = { enabled: !!jevDemo, hasApiKey: !!jevDemo };
  var speechConfig = { enabled: true, model: "paraformer-bilingual-fp32", modelsRoot: "D:\\SpeechModels", device: null, maxSeconds: 600,
    models: [
      { id: "paraformer-bilingual-fp32", label: "Paraformer 中英双语 · FP32 原版", sizeMib: 825, ready: true, missing: [] }
    ] };
  var speechSession = null;
  var cancelledSpeech = new Set();
  var jevRubrics = {};
  jevRubrics[QUEUE_ITEMS[0].blockId] = ["检索练习（主动回忆）优于重复阅读", "间隔安排优于集中突击", "交错不同题型优于分块刷同类"];
  var usedToday = 3;
  var nativeStates = {};
  var participation = {};
  QUEUE_ITEMS.forEach(function (item) { participation[item.blockId] = "ENABLED"; });
  var pausedSample = Object.assign({}, QUEUE_ITEMS[0], { blockId: "6a0e2d73-a75b-4a89-b8a2-680a5e7da220", title: "动态规划的状态转移", relativePath: "算法/动态规划.md" });
  var excludedSample = Object.assign({}, QUEUE_ITEMS[0], { blockId: "9c0317b4-1d51-4e1f-9b71-83f449e76ca0", title: "间隔重复原理" });
  QUEUE_ITEMS.push(pausedSample, excludedSample);
  participation[pausedSample.blockId] = "PAUSED";
  participation[excludedSample.blockId] = "EXCLUDED";
  if (demo === "onboarding") {
    TREE = { "": [] };
    QUEUE_ITEMS = [];
    usedToday = 0;
    participation = {};
    jevRubrics = {};
  }

  function registryResult() {
    return { documents: [], recoveryMode: null, blocks: QUEUE_ITEMS.map(function (item, i) {
      return {
        blockId: item.blockId, documentId: "demo-doc-" + i, relativePath: item.relativePath,
        kind: "HEADING", headingLevel: 2, title: item.title, headingPath: item.headingPath,
        ordinal: i, startOffset: item.startOffset, bodyStartOffset: item.bodyStartOffset, endOffset: item.endOffset,
        sourceHash: "demo", bodyHash: "demo", contentVersion: 1, status: "ACTIVE", statusReason: null,
        participation: participation[item.blockId], needsRecheck: false, hasRating: !item.neverRated,
        missingSince: null, lastSeenAt: now,
      };
    }) };
  }

  function queueResult(learnNow) {
    var remaining = Math.max(0, config.dailyNewLimit - usedToday);
    var items = QUEUE_ITEMS.filter(function (item) {
      return participation[item.blockId] === "ENABLED" && (learnNow ? item.phase === "NEW" && item.neverRated : item.nextReviewAt <= Date.now());
    });
    return {
      nowMs: now,
      items: learnNow ? items.slice(0, remaining) : items,
      counts: {
        learning: items.filter(function (item) { return !item.neverRated && item.phase === "Learning"; }).length,
        review: items.filter(function (item) { return !item.neverRated && item.phase !== "Learning"; }).length,
        newTotal: items.filter(function (item) { return item.neverRated; }).length,
      },
      quota: { limit: config.dailyNewLimit, usedToday: usedToday, remaining: remaining },
      nextUpcomingAt: learnNow ? null : now + 42 * MIN,
    };
  }

  function beginResult(blockId) {
    var item = QUEUE_ITEMS.find(function (i) {
      return i.blockId === blockId;
    });
    return {
      token: "stub-token:" + blockId,
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
        // Match the frozen adapter so the browser can render interval previews.
        // These sample values never reach the native host or production bundle.
        algorithmId: "fsrs",
        algorithmVersion: "ts-fsrs@5.4.2+FSRS-6.0",
        stateSchemaVersion: 1,
        configJson: JSON.stringify({
          request_retention: 0.9,
          maximum_interval: 3650,
          w: [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542],
          enable_fuzz: false,
          enable_short_term: true,
          learning_steps: ["1m", "10m"],
          relearning_steps: ["10m"],
        }),
        stateJson: JSON.stringify(nativeStates[blockId] || (item && item.neverRated ? {
          due: new Date(item.nextReviewAt).toISOString(), stability: 0, difficulty: 0,
          elapsed_days: 0, scheduled_days: 0, reps: 0, lapses: 0, learning_steps: 0, state: 0,
        } : {
          due: new Date(now - HOUR).toISOString(),
          stability: 5.2,
          difficulty: 5.8,
          elapsed_days: 3,
          scheduled_days: 3,
          reps: 6,
          lapses: 1,
          learning_steps: 0,
          state: item && item.phase === "Learning" ? 1 : 2,
          last_review: new Date(now - 3 * DAY).toISOString(),
        })),
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
      return workspaceActive ? WS : null;
    },
    workspace_open: function (a) { workspaceActive = true; WS.root = a.root; return WS; },
    workspace_close: function () { workspaceActive = false; },
    "plugin:dialog|open": function () { return WS.root; },
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
    file_create: function (a) {
      var slash = a.path.lastIndexOf("/");
      var dir = slash < 0 ? "" : a.path.slice(0, slash);
      var name = a.path.slice(slash + 1);
      if ((TREE[dir] || []).some(function (item) { return item.name.toLowerCase() === name.toLowerCase(); })) throw { code: "ALREADY_EXISTS", message: "名称已存在" };
      (TREE[dir] || (TREE[dir] = [])).push({ name: name, relativePath: a.path, isDir: false });
      memoryDocuments[a.path] = "";
    },
    save_document: function (a) {
      if (a.params.expectedHash !== readDocument(a.relativePath).rawByteHash) throw { code: "FILE_CONFLICT", message: "文件版本已改变" };
      memoryDocuments[a.relativePath] = a.params.text;
      memoryVersions[a.relativePath] = ++saveSequence;
      return { committedHash: readDocument(a.relativePath).rawByteHash, byteSize: new TextEncoder().encode(a.params.text).length, operationId: "preview-save-" + saveSequence };
    },
    stat_document: function (a) { var doc = readDocument(a.relativePath); return { exists: true, rawByteHash: doc.rawByteHash, byteSize: doc.byteSize, mtimeMs: doc.mtimeMs }; },
    draft_write: function () { return Date.now(); },
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
    learning_queue: function () { return queueResult(true); },
    learning_begin: function (a) { return beginResult(a.blockId); },
    review_submit: function (a) {
      var req = a.request;
      var item = QUEUE_ITEMS.find(function (i) { return req.token === "stub-token:" + i.blockId; });
      if (!item) throw { code: "REVIEW_TOKEN_INVALID", message: "请重新取题" };
      if (item.neverRated) usedToday++;
      item.neverRated = false;
      item.phase = req.outcome.phase;
      item.nextReviewAt = req.outcome.scheduledDueAt;
      nativeStates[item.blockId] = JSON.parse(req.outcome.stateJson);
      return { blockId: item.blockId, stateRevision: 2, nextReviewAt: item.nextReviewAt,
        occurredAt: req.nowMs, replayed: false, quota: queueResult().quota };
    },
    review_stats: function () {
      return Object.assign({}, STATS, {
        due: queueResult().counts,
        enabled: Object.values(participation).filter(function (v) { return v === "ENABLED"; }).length,
        paused: Object.values(participation).filter(function (v) { return v === "PAUSED"; }).length,
        excluded: Object.values(participation).filter(function (v) { return v === "EXCLUDED"; }).length,
      });
    },
    app_config_read: function () {
      return Object.assign({}, config);
    },
    jev_config_read: function () { return Object.assign({}, jevConfig); },
    speech_config_read: function () { return JSON.parse(JSON.stringify(speechConfig)); },
    speech_config_save: function (a) { Object.assign(speechConfig, a.config); return JSON.parse(JSON.stringify(speechConfig)); },
    speech_devices: function () { return ["演示麦克风（浏览器不录音）"]; },
    speech_start: function (a) {
      if (cancelledSpeech.has(a.sessionId)) throw { code: "SPEECH_CANCELLED", message: "录音已取消" };
      speechSession = { id: a.sessionId, started: Date.now(), model: speechConfig.model, maxSeconds: speechConfig.maxSeconds };
      return { sessionId: a.sessionId, phase: "recording", seconds: 0, level: 0, stopped: false, device: "浏览器演示，不使用真实麦克风", error: null };
    },
    speech_status: function (a) {
      if (!speechSession || speechSession.id !== a.sessionId) throw { code: "SPEECH_CANCELLED", message: "录音已取消" };
      var seconds = (Date.now() - speechSession.started) / 1000;
      return { sessionId: a.sessionId, phase: "recording", seconds: seconds, level: 0.04 + Math.abs(Math.sin(seconds * 3)) * 0.15, stopped: seconds >= speechSession.maxSeconds, device: "演示麦克风", error: null, warning: null };
    },
    speech_stop: function (a) {
      if (!speechSession || speechSession.id !== a.sessionId) throw { code: "SPEECH_CANCELLED", message: "录音已取消" };
      var session = speechSession; speechSession = null;
      return new Promise(function (resolve) { setTimeout(function () { resolve({ sessionId: session.id, model: session.model, text: "演示转写：主动回忆是先尝试用自己的话回答，再核对原文中的关键内容。", audioSeconds: (Date.now() - session.started) / 1000, processingMs: 600, preview: true }); }, 600); });
    },
    speech_cancel: function (a) { cancelledSpeech.add(a.sessionId); if (speechSession && speechSession.id === a.sessionId) speechSession = null; },
    jev_config_save: function (a) {
      jevConfig.enabled = a.enabled;
      // 预览不保存真实 Key、不调用外网，仅保留配置状态。
      if (a.apiKey) jevConfig.hasApiKey = true;
      return Object.assign({}, jevConfig);
    },
    jev_key_clear: function () {
      jevConfig = { enabled: false, hasApiKey: false };
      return Object.assign({}, jevConfig);
    },
    review_rubric_read: function (a) { return { points: (jevRubrics[a.blockId] || []).slice() }; },
    note_rubrics_read: function (a) {
      return QUEUE_ITEMS.filter(function (item, index) { return item.relativePath === a.relativePath && (index < 3 || Object.hasOwn(memoryDocuments, item.relativePath)); }).map(function (item) {
        return { blockId: item.blockId, headingOffset: item.startOffset, points: (jevRubrics[item.blockId] || []).slice() };
      });
    },
    note_rubric_save: function (a) {
      var request = a.request;
      var item = QUEUE_ITEMS.find(function (entry) { return entry.blockId === request.blockId && entry.relativePath === request.relativePath; });
      if (!item) throw { code: "JEV_NOTE_STALE", message: "小节已变化，请刷新笔记" };
      if (JSON.stringify(jevRubrics[item.blockId] || []) !== JSON.stringify(request.expectedPoints)) {
        throw { code: "JEV_RUBRIC_STALE", message: "得分点已修改，请重新打开后编辑" };
      }
      jevRubrics[item.blockId] = request.points.slice();
      return { blockId: item.blockId, headingOffset: item.startOffset, points: request.points.slice() };
    },
    review_rubric_save: function (a) {
      var blockId = a.token.replace("stub-token:", "");
      jevRubrics[blockId] = a.points.slice();
      return beginResult(blockId);
    },
    jev_grade: function (a) {
      if (!jevConfig.enabled || !jevConfig.hasApiKey) throw { code: "JEV_KEY_MISSING", message: "请先在设置中填写 API Key" };
      if (jevDemo === "error") throw { code: "JEV_NETWORK", message: "预览模拟：无法连接 Jev，请重试或继续手动评分。" };
      var blockId = a.token.replace("stub-token:", "");
      var rubric = jevRubrics[blockId] || [];
      if (!rubric.length) throw { code: "JEV_RUBRIC_MISSING", message: "本题尚未设置得分点，请在笔记预览的小节标题旁点击「＋」添加。" };
      var points = rubric.map(function (point, i) {
        return { point: point, score: [1.9, 1, 0.2][i % 3], confidence: [0.85, 0.9, 0.7][i % 3], probabilities: [[0, 0.1, 0.9], [0.05, 0.9, 0.05], [0.8, 0.2, 0]][i % 3] };
      });
      return new Promise(function (resolve) { setTimeout(function () { resolve({ preview: true, score: points.reduce(function (sum, p) { return sum + p.score; }, 0) / (2 * points.length) * 100, points: points }); }, 500); });
    },
    app_config_set: function (a) {
      if (a.key === "editor.autosave") config.autosave = a.value === "1";
      if (a.key === "review.daily_new_limit") config.dailyNewLimit = Number(a.value);
    },
    review_set_participation: function (a) {
      var transitions = { PAUSE: ["ENABLED", "PAUSED"], RESUME: ["PAUSED", "ENABLED"], EXCLUDE: ["ENABLED", "EXCLUDED"], INCLUDE: ["EXCLUDED", "ENABLED"] };
      var transition = transitions[a.action];
      if (!transition || a.blockIds.some(function (id) { return participation[id] !== transition[0]; })) {
        throw { code: "REVIEW_REJECTED", message: "参与状态已经变化，请刷新列表后重试。" };
      }
      a.blockIds.forEach(function (id) { participation[id] = transition[1]; });
      return a.blockIds.length;
    },
    review_set_prompt: function (a) {
      var item = QUEUE_ITEMS.find(function (i) { return i.blockId === a.blockId; });
      if (item) item.recallPrompt = a.prompt;
    },
    registry_read: function () {
      return registryResult();
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
    commit_index_batch: function (a) {
      // Exercise enrollment with the real frontend engine, without native disk writes.
      a.request.blockResults.forEach(function (block) {
        var next = block.next;
        if (!next || block.status !== "ACTIVE" || !Object.hasOwn(memoryDocuments, next.relativePath)) return;
        var item = QUEUE_ITEMS.find(function (entry) { return entry.blockId === block.blockId; });
        if (!item) {
          item = { blockId: block.blockId, phase: "NEW", neverRated: true, nextReviewAt: now + DAY, recallPrompt: null, needsRecheck: false };
          QUEUE_ITEMS.push(item);
          participation[item.blockId] = "ENABLED";
        }
        Object.assign(item, { relativePath: next.relativePath, title: next.title, headingPath: next.headingPath, startOffset: next.startOffset, bodyStartOffset: next.bodyStartOffset, endOffset: next.endOffset });
      });
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
  // The browser stub has no native event registry; StrictMode cleanup is a no-op.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: function () {} };
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

  if (demo !== "start" && demo !== "onboarding") {
    var clickInterval = setInterval(function () {
      if (document.querySelector("dialog[open]")) return;
      if (demo === "editor" || demo === "reading") {
        if (demo === "reading") {
          var readingButton = document.querySelector('.editor-toolbar [aria-label="阅读预览"]:not(:disabled)');
          if (readingButton) {
            readingButton.click();
            clearInterval(clickInterval);
            return;
          }
        }
        var file = document.querySelector(".tree-row .tree-icon.file");
        var row = file && file.closest(".tree-row");
        if (row) {
          row.click();
          if (demo === "editor") clearInterval(clickInterval);
        }
      } else {
        var label = { review: "今日复习", learning: "学习新内容", stats: "统计", settings: "设置" }[demo];
        var nav = Array.from(document.querySelectorAll(".sidebar-nav .nav-row")).find(function (button) {
          return label && button.textContent.includes(label);
        });
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
