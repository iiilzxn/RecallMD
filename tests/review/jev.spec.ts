import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcCall } from "../../src/editor/ipc";
import { jevIpc, parseRubricDraft, pointLabel, pointVerdict, rubricProblem } from "../../src/review/jev";

vi.mock("../../src/editor/ipc", () => ({ ipcCall: vi.fn().mockResolvedValue({}) }));

describe("Jev 评分接缝与标准", () => {
  beforeEach(() => vi.mocked(ipcCall).mockClear());

  it("评分只传会话和答案，标准与 Key 由原生端读取", async () => {
    await jevIpc.grade("review-token", "自己回忆的答案");
    await jevIpc.saveRubric("review-token", ["关键条件", "核心结论"]);
    expect(vi.mocked(ipcCall).mock.calls).toEqual([
      ["jev_grade", { token: "review-token", answer: "自己回忆的答案" }],
      ["review_rubric_save", { token: "review-token", points: ["关键条件", "核心结论"] }],
    ]);
  });

  it("开关不会清空已保存的 Key，删除使用单独命令", async () => {
    await jevIpc.saveConfig(false);
    await jevIpc.clearKey();
    expect(vi.mocked(ipcCall).mock.calls).toEqual([
      ["jev_config_save", { enabled: false, apiKey: null }], ["jev_key_clear", {}],
    ]);
  });

  it("支持中文编号、Markdown 项目符号和空行，保留点内语义", () => {
    expect(parseRubricDraft("1. 条件一\r\n\r\n- 条件二\n3、结论三\n-1 是负数\n 公式 x - y"))
      .toEqual(["条件一", "条件二", "结论三", "-1 是负数", "公式 x - y"]);
    expect(rubricProblem(Array(31).fill("一个点"))).not.toBeNull();
    expect(rubricProblem(["中".repeat(501)])).not.toBeNull();
    expect(rubricProblem(["😀".repeat(500)])).toBeNull();
  });

  it("不将概率期望值直接当成确定等级，低置信度提示核对", () => {
    expect(pointVerdict({ point: "条件", score: 1, confidence: 0.1, probabilities: [0.5, 0, 0.5] })).toBe("需自行核对");
    expect(pointVerdict({ point: "条件", score: 1.9, confidence: 0.9, probabilities: [0, 0.1, 0.9] })).toBe("完整覆盖");
  });

  it("五字标签只影响展示，保留中文、emoji 和组合字符边界", () => {
    expect(pointLabel("后进先出")).toBe("后进先出");
    expect(pointLabel("主线程执行")).toBe("主线程执行");
    expect(pointLabel("主线程执行命令")).toBe("主线程执行…");
    expect(pointLabel("👨‍👩‍👧‍👦一二三四五")).toBe("👨‍👩‍👧‍👦一二三四…");
  });

  it("预览保存携带文档版本和原得分点，不依赖复习令牌且不截断内容", async () => {
    const point = "主线程执行命令，IO 线程处理网络读写";
    const request = { relativePath: "Redis.md", expectedHash: "saved-hash", blockId: "block", expectedPoints: ["原来的得分点"], points: [point] };
    await jevIpc.noteRubrics("Redis.md", "saved-hash");
    await jevIpc.saveNoteRubric(request);
    expect(vi.mocked(ipcCall).mock.calls).toEqual([
      ["note_rubrics_read", { relativePath: "Redis.md", expectedHash: "saved-hash" }],
      ["note_rubric_save", { request }],
    ]);
  });
});
