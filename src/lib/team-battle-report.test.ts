import { describe, expect, it } from "vitest";
import { eightPlayerSample, longReportSample, twoPlayerSample } from "./team-battle.test";
import { buildTeamBattleReport, buildTeamBattleReportProjection } from "./team-battle-report";
import { createTeamBattleMatch, pauseTeamBattleMatch, recordTeamBattleRound, resumeTeamBattleMatch } from "./team-battle";

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

  it("逐局报告使用对局序位而不是包含暂停的事件序号", () => {
    let match = createTeamBattleMatch({ playerNames: ["甲", "乙"] }, 1_000);
    const [first, second] = match.players;
    match = recordTeamBattleRound(match, { playerIds: [first.id, second.id], winnerId: first.id, winType: "normal", fouls: {}, note: "", startedAt: 1_001 }, 1_010);
    match = pauseTeamBattleMatch(match, 1_020);
    match = resumeTeamBattleMatch(match, 1_030);
    match = recordTeamBattleRound(match, { playerIds: [first.id, second.id], winnerId: second.id, winType: "break_clear", fouls: {}, note: "", startedAt: 1_031 }, 1_040);

    const svg = buildTeamBattleReport(match, { scope: { kind: "all" }, detail: "full" });
    expect(svg).toContain("第 2 局");
    expect(svg).not.toContain("第 4 局");
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
