import { describe, expect, it } from "vitest";
import { buildPdf, buildSnookerReport, parseMatchReport } from "./json-report";
import { createSnookerMatch, recordSnookerCommand } from "./snooker";

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

  it("读取斯诺克 JSON 并生成包含局分和单杆统计的 SVG", () => {
    let match = createSnookerMatch({ playerNames: ["甲", "乙"], bestOf: 3, firstStriker: 0 }, 100);
    match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "red" }, 101);
    match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "black" }, 102);
    const parsed = parseMatchReport(JSON.stringify({ exportVersion: 2, match }));
    expect(parsed).toEqual(match);
    const svg = buildSnookerReport(match, { time: true, trend: true, stats: true });
    expect(svg).toContain("SNOOKER MATCH REPORT");
    expect(svg).toContain("甲 0 : 乙 0");
    expect(svg).toContain("最高单杆 8");
    expect(svg).toContain("本场暂无 20+ 单杆");
    expect(svg).not.toContain("事件流水");
    const realtimeArchive = { ...match, realtimeArchive: { roomCode: "ABC123", version: 3 } };
    expect(buildSnookerReport(realtimeArchive, { time: true, trend: true, stats: true })).toBe(svg);
  });

  it("用七色球圆形统计展示 20+ 单杆，不输出逐球事件", () => {
    let match = createSnookerMatch({ playerNames: ["甲", "乙"], bestOf: 3, firstStriker: 0 }, 100);
    for (let index = 0; index < 3; index += 1) {
      match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "red" }, 101 + index * 2);
      match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "black" }, 102 + index * 2);
    }
    const svg = buildSnookerReport(match, { time: true, trend: true, stats: true });
    expect(svg).toContain("20+ 单杆球型");
    expect(svg).toContain("24 分");
    expect(svg.match(/data-ball=/g)).toHaveLength(7);
    expect(svg).toContain('aria-label="红球 3 颗"');
    expect(svg).toContain('aria-label="黑球 3 颗"');
    expect(svg).not.toContain("事件流水");
    expect(svg).not.toContain("进 红球");
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
