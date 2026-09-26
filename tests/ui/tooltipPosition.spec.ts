import { describe, expect, it } from "vitest";
import { tooltipPosition } from "../../src/ui/tooltipPosition";

describe("得分点全文提示的可视边界", () => {
  it("500 字提示的实测尺寸应留在窗口内，超长内容使用滚动空间", () => {
    const result = tooltipPosition({ left: 751, top: 323, bottom: 342 }, { width: 400, height: 423 }, { width: 1280, height: 720 });
    expect(result.top).toBeGreaterThanOrEqual(12);
    expect(result.top + Math.min(423, result.maxHeight)).toBeLessThanOrEqual(708);
    expect(result.maxHeight).toBeLessThan(423);
  });
  it("靠近底部时放到上方", () => {
    const result = tooltipPosition({ left: 300, top: 650, bottom: 674 }, { width: 200, height: 100 }, { width: 1280, height: 720 });
    expect(result.top + 100).toBeLessThan(650);
  });
  it("窄窗口与右侧标签不产生横向溢出", () => {
    const result = tooltipPosition({ left: 350, top: 30, bottom: 54 }, { width: 400, height: 200 }, { width: 390, height: 844 });
    expect(result.left).toBeGreaterThanOrEqual(12);
    expect(result.left + result.maxWidth).toBeLessThanOrEqual(378);
    expect(result.top).toBeGreaterThan(54);
  });
});
