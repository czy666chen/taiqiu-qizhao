import { describe, expect, it } from "vitest";
import { eightPlayerSample, longReportSample, twoPlayerSample } from "./team-battle.test";
import { buildTeamBattleReport, buildTeamBattleReportProjection } from "./team-battle-report";

describe("团战阶段 4 报告", () => {
  it("整场报告复用同一投影并保留全部实际交手比分", () => {
    const report = buildTeamBattleReportProjection(eightPlayerSample, { scope: { kind: "all" }, detail: "auto" });
    expect(report.resolvedDetail).toBe("full");
    expect(report.match.pairs).toHaveLength(4);
    expect(buildTeamBattleReport(eightPlayerSample, { scope: { kind: "all" }, detail: "auto" }))
      .toContain("TEAM BATTLE REPORT");
  });

  it("成员摘要列出其他所有成员并标记未交手", () => {
    const report = buildTeamBattleReportProjection(eightPlayerSample, { scope: { kind: "player", playerId: "p1" }, detail: "summary" });
    expect(report.player?.opponents).toHaveLength(7);
    expect(report.player?.opponents.filter(({ played }) => !played)).toHaveLength(4);
    expect(report.omittedRounds).toBe(true);
  });

  it("超长整场和成员报告自动完整降级，full 超硬上限时报错", () => {
    for (const scope of [{ kind: "all" } as const, { kind: "player", playerId: "p1" } as const]) {
      const report = buildTeamBattleReportProjection(longReportSample.match, { scope, detail: "auto" });
      expect(report).toMatchObject({ resolvedDetail: "summary", omittedRounds: true });
      expect(report.match.pairs[0].scores).toEqual(longReportSample.expected.scores);
      expect(report.omissionReason).toContain("已省略逐局变化");
      expect(() => buildTeamBattleReportProjection(longReportSample.match, { scope, detail: "full" })).toThrow("过长");
    }
  });

  it("短报告可强制摘要且 SVG 数字与投影一致", () => {
    const svg = buildTeamBattleReport(twoPlayerSample, { scope: { kind: "all" }, detail: "summary" });
    expect(svg).toContain("成员1 vs 成员2");
    expect(svg).toContain("1 : 0");
    expect(svg).toContain("已省略逐局变化");
  });

  it("白天模式生成白色系 SVG，黑夜模式保留深色底", () => {
    const options = { scope: { kind: "all" } as const, detail: "summary" as const };
    expect(buildTeamBattleReport(twoPlayerSample, options, "night")).toContain('fill="#07110d"');
    const day = buildTeamBattleReport(twoPlayerSample, options, "day");
    expect(day).toContain('fill="#fffefa"');
    expect(day).toContain("fill:#102019");
    expect(day).not.toContain('fill="#07110d"');
  });
});
