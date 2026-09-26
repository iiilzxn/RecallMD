import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JevFeedback } from "../../src/ui/JevFeedback";
import type { JevGrade } from "../../src/review/jev";

describe("Jev 低置信度反馈", () => {
  function render(result: JevGrade) {
    return renderToStaticMarkup(createElement(JevFeedback, {
      answer: "只答出一点", grading: false, error: null, retryDisabled: false, onRetry: () => {},
      result,
    }));
  }
  it("不把低置信度样本的偏低数字当作成绩呈现", () => {
    const html = render({ score: 12, points: [
      { point: "栈后进先出", score: 0.47, confidence: 0.3, probabilities: [0.72, 0.09, 0.19] },
      { point: "队列先进先出", score: 0.01, confidence: 0.99, probabilities: [0.99, 0.01, 0] },
    ] });
    expect(html).toContain("待核对");
    expect(html).toContain("暂不显示总分");
    expect(html).not.toContain(" / 100");
    expect(html).not.toContain("0.5 / 2");
  });
  it("确定程度达到提示阈值时保留参考评分", () => {
    const html = render({ score: 100, points: [{ point: "栈后进先出", score: 2, confidence: 1, probabilities: [0, 0, 1] }] });
    expect(html).toContain(" / 100");
    expect(html).not.toContain("暂不显示总分");
  });
});
