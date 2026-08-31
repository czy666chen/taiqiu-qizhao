import { describe, expect, it } from "vitest";
import { resolveReportTheme } from "./report-theme";

describe("战绩导出主题", () => {
  it("跟随白天模式，并将缺省或未知值安全回退到黑夜模式", () => {
    expect(resolveReportTheme("day")).toBe("day");
    expect(resolveReportTheme("night")).toBe("night");
    expect(resolveReportTheme(undefined)).toBe("night");
  });
});
