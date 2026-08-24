import { describe, expect, it } from "vitest";
import { buildPdf, parseMatchReport } from "./json-report";

const scoreMatch = {
  version: 1 as const, id: "match-1", mode: "score" as const, status: "completed" as const,
  createdAt: 1, startedAt: 1, endedAt: 2, players: [], currentPlayerId: "", rules: [], scoreEvents: [],
};

describe("JSON 战绩报告", () => {
  it("读取战绩详情导出的包装格式", () => {
    expect(parseMatchReport(JSON.stringify({ exportVersion: 1, match: scoreMatch }))).toEqual(scoreMatch);
  });

  it("也接受原始战绩，并拒绝普通 JSON", () => {
    expect(parseMatchReport(JSON.stringify(scoreMatch))).toEqual(scoreMatch);
    expect(() => parseMatchReport(" ")).toThrow("请上传战绩 JSON");
    expect(() => parseMatchReport("{nope}")).toThrow("JSON 格式无效");
    expect(() => parseMatchReport('{"matches":[]}')).toThrow("未找到可导出的战绩");
  });

  it("生成包含多页引用的 PDF", () => {
    const pdf = buildPdf([
      { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 20, height: 20 },
      { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 20, height: 20 },
    ]);
    const text = new TextDecoder().decode(pdf);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Count 2");
    expect(text.endsWith("%%EOF")).toBe(true);
  });
});
