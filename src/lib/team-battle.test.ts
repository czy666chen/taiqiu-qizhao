import { describe, expect, it } from "vitest";
import {
  addTeamBattlePlayer,
  compareTeamBattleStandings,
  correctTeamBattleRound,
  createTeamBattleMatch,
  finishTeamBattleMatch,
  getEffectiveTeamBattleRounds,
  getPairProjection,
  getPlayerReport,
  getTeamBattleProjection,
  pauseTeamBattleMatch,
  recordTeamBattleRound,
  renameTeamBattlePlayer,
  resumeTeamBattleMatch,
  TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH,
  TEAM_BATTLE_MAX_PLAYERS,
  TEAM_BATTLE_MIN_PLAYERS,
  TEAM_BATTLE_REPORT_AUTO_DETAIL_MAX_HEIGHT,
  TEAM_BATTLE_REPORT_HARD_MAX_HEIGHT,
  teamBattlePairKey,
  teamBattleElapsedMs,
  undoLastTeamBattleRound,
  type PlayerReportProjection,
  type PlayerStanding,
  type TeamBattleMatch,
  type TeamBattleProjection,
  type TeamBattleReportProjection,
} from "./team-battle";

const players = Array.from({ length: 8 }, (_, index) => ({
  id: `p${index + 1}`,
  name: `成员${index + 1}`,
  joinedAt: 1_000 + index * 100,
}));

const names = (count: number) => Object.fromEntries(players.slice(0, count).map((player) => [player.id, player.name]));
const round = (id: string, sequenceNo: number, playerIds: [string, string], winnerId: string) => ({
  id,
  sequenceNo,
  type: "round" as const,
  occurredAt: 2_000 + sequenceNo,
  playerNames: names(8),
  round: {
    playerIds,
    winnerId,
    winType: "normal" as const,
    fouls: {},
    note: "",
    startedAt: 1_900 + sequenceNo,
    confirmedAt: 2_000 + sequenceNo,
  },
});

export const twoPlayerSample = {
  schemaVersion: 1,
  id: "team-two",
  mode: "team_battle",
  status: "completed",
  title: "双人样例",
  location: "",
  note: "",
  createdAt: 1_000,
  startedAt: 1_000,
  endedAt: 2_100,
  pausedDurationMs: 0,
  players: players.slice(0, 2),
  events: [round("r1", 1, ["p1", "p2"], "p1")],
} satisfies TeamBattleMatch;

export const eightPlayerSample = {
  schemaVersion: 1,
  id: "team-eight",
  mode: "team_battle",
  status: "active",
  title: "八人综合样例",
  location: "球房",
  note: "覆盖加入、重复交手、撤销和更正",
  createdAt: 1_000,
  startedAt: 1_000,
  pausedDurationMs: 0,
  players,
  events: [
    ...players.slice(2).map((player, index) => ({
      id: `j${index + 1}`,
      sequenceNo: index + 1,
      type: "join" as const,
      occurredAt: player.joinedAt,
      playerNames: names(index + 3),
      playerId: player.id,
      nextName: player.name,
    })),
    round("r1", 7, ["p1", "p2"], "p1"),
    round("r2", 8, ["p2", "p1"], "p1"),
    round("r3", 9, ["p1", "p3"], "p3"),
    round("r4", 10, ["p4", "p5"], "p4"),
    round("r5", 11, ["p6", "p7"], "p6"),
    round("r6", 12, ["p8", "p1"], "p8"),
    {
      id: "c1",
      sequenceNo: 13,
      type: "correction",
      occurredAt: 2_013,
      playerNames: names(8),
      correctsEventId: "r2",
      replacement: { ...round("unused", 8, ["p2", "p1"], "p2").round },
    },
    {
      id: "c2",
      sequenceNo: 14,
      type: "correction",
      occurredAt: 2_014,
      playerNames: names(8),
      correctsEventId: "r4",
    },
  ],
} satisfies TeamBattleMatch;

const standing = (playerIndex: number, rank: number, tied: boolean, wins: number, losses: number, opponentsPlayed: number): PlayerStanding => ({
  rank,
  tied,
  player: players[playerIndex],
  wins,
  losses,
  differential: wins - losses,
  opponentsPlayed,
});

const playerOneScores = (opponentId: string): Record<string, number> => {
  if (opponentId === "p2") return { p1: 1, p2: 1 };
  if (opponentId === "p3") return { p1: 0, p3: 1 };
  if (opponentId === "p8") return { p1: 0, p8: 1 };
  return { p1: 0, [opponentId]: 0 };
};

export const eightPlayerExpected = {
  pairScores: {
    [teamBattlePairKey("p1", "p2")]: { p1: 1, p2: 1 },
    [teamBattlePairKey("p1", "p3")]: { p1: 0, p3: 1 },
    [teamBattlePairKey("p1", "p8")]: { p1: 0, p8: 1 },
    [teamBattlePairKey("p6", "p7")]: { p6: 1, p7: 0 },
  },
  standings: [
    standing(2, 1, true, 1, 0, 1),
    standing(5, 1, true, 1, 0, 1),
    standing(7, 1, true, 1, 0, 1),
    standing(1, 4, false, 1, 1, 1),
    standing(0, 5, false, 1, 3, 3),
    standing(3, 6, true, 0, 0, 0),
    standing(4, 6, true, 0, 0, 0),
    standing(6, 8, false, 0, 1, 1),
  ],
  playerReport: {
    player: players[0],
    wins: 1,
    losses: 3,
    differential: -2,
    opponents: players.slice(1).map((opponent) => ({
      opponent,
      scores: playerOneScores(opponent.id),
      played: ["p2", "p3", "p8"].includes(opponent.id),
      rounds: [],
    })),
    rounds: [],
  } satisfies PlayerReportProjection,
} satisfies Pick<TeamBattleProjection, "standings"> & {
  pairScores: Record<string, Record<string, number>>;
  playerReport: PlayerReportProjection;
};

export const longReportSample = {
  match: {
    ...twoPlayerSample,
    id: "team-long",
    events: Array.from({ length: 1_000 }, (_, index) => round(`long-${index + 1}`, index + 1, ["p1", "p2"], index % 2 === 0 ? "p1" : "p2")),
  } satisfies TeamBattleMatch,
  expected: {
    scores: { p1: 500, p2: 500 },
    resolvedDetail: "summary",
    omittedRounds: true,
  } satisfies Pick<TeamBattleReportProjection, "resolvedDetail" | "omittedRounds"> & { scores: Record<string, number> },
};

describe("团战阶段 0 契约与样例", () => {
  it("固定人数、姓名和报告高度边界", () => {
    expect([TEAM_BATTLE_MIN_PLAYERS, TEAM_BATTLE_MAX_PLAYERS, TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH]).toEqual([2, 8, 20]);
    expect(TEAM_BATTLE_REPORT_AUTO_DETAIL_MAX_HEIGHT).toBe(20_000);
    expect(TEAM_BATTLE_REPORT_HARD_MAX_HEIGHT).toBe(30_000);
  });

  it("正反选择使用同一个稳定组合 key", () => {
    expect(teamBattlePairKey("p1", "p2")).toBe("p1::p2");
    expect(teamBattlePairKey("p2", "p1")).toBe("p1::p2");
  });

  it("固定总榜排序且不使用姓名决定名次", () => {
    expect([...eightPlayerExpected.standings].sort(compareTeamBattleStandings).map(({ player }) => player.id))
      .toEqual(["p3", "p6", "p8", "p2", "p1", "p4", "p5", "p7"]);
    expect(eightPlayerExpected.standings.filter(({ tied }) => tied).map(({ rank }) => rank))
      .toEqual([1, 1, 1, 6, 6]);
  });

  it("样例明确覆盖两人、八人、中途加入、重复交手、撤销与更正", () => {
    expect(twoPlayerSample.players).toHaveLength(2);
    expect(eightPlayerSample.players).toHaveLength(8);
    expect(eightPlayerSample.events.filter(({ type }) => type === "join")).toHaveLength(6);
    expect(eightPlayerSample.events.filter(({ type }) => type === "correction")).toHaveLength(2);
    expect(eightPlayerExpected.pairScores[teamBattlePairKey("p1", "p2")]).toEqual({ p1: 1, p2: 1 });
    expect(eightPlayerExpected.playerReport.opponents).toHaveLength(7);
  });

  it("超长流水样例固定为完整比分、自动摘要输出", () => {
    expect(longReportSample.match.events).toHaveLength(1_000);
    expect(longReportSample.expected).toEqual({ scores: { p1: 500, p2: 500 }, resolvedDetail: "summary", omittedRounds: true });
  });
});

const createMatch = () => createTeamBattleMatch({ playerNames: ["甲", "乙"] }, 100);
const record = (match: TeamBattleMatch, winnerId = match.players[0].id, now = 200) => recordTeamBattleRound(match, {
  playerIds: [match.players[0].id, match.players[1].id],
  winnerId,
  winType: "normal",
  fouls: {},
  note: " 测试 ",
  startedAt: now - 50,
}, now);

describe("团战领域模型", () => {
  it("创建时规范姓名并拒绝人数、空名、长名和重名", () => {
    const match = createTeamBattleMatch({ playerNames: [" 甲 ", "乙"], title: " 标题 " }, 100);
    expect(match.players.map(({ name }) => name)).toEqual(["甲", "乙"]);
    expect(match.title).toBe("标题");
    expect(() => createTeamBattleMatch({ playerNames: ["甲"] })).toThrow("2–8");
    expect(() => createTeamBattleMatch({ playerNames: Array.from({ length: 9 }, (_, index) => `${index}`) })).toThrow("2–8");
    expect(() => createTeamBattleMatch({ playerNames: ["甲", " "] })).toThrow("1–20");
    expect(() => createTeamBattleMatch({ playerNames: ["甲", "甲"] })).toThrow("不能重复");
    expect(() => createTeamBattleMatch({ playerNames: ["甲", "乙".repeat(21)] })).toThrow("1–20");
  });

  it("中途加入和改名保留稳定 ID 与事件姓名快照", () => {
    const match = createMatch();
    const joined = addTeamBattlePlayer(match, " 丙 ", 300);
    const playerId = joined.players[2].id;
    const renamed = renameTeamBattlePlayer(joined, playerId, "丁", 400);
    expect(renamed.players[2]).toEqual({ id: playerId, name: "丁", joinedAt: 300 });
    expect(renamed.events[0]).toMatchObject({ type: "join", playerId, nextName: "丙" });
    expect(renamed.events[0].playerNames[playerId]).toBe("丙");
    expect(renamed.events[1]).toMatchObject({ type: "rename", playerId, previousName: "丙", nextName: "丁" });
    expect(renamed.events[1].playerNames[playerId]).toBe("丁");
    expect(() => addTeamBattlePlayer(joined, "甲")).toThrow("不能重复");
    expect(() => renameTeamBattlePlayer(joined, playerId, "乙")).toThrow("不能重复");
    let full = match;
    for (const name of ["丙", "丁", "戊", "己", "庚", "辛"]) full = addTeamBattlePlayer(full, name);
    expect(full.players).toHaveLength(8);
    expect(() => addTeamBattlePlayer(full, "壬")).toThrow("最多 8 名");
  });

  it("拒绝无效对阵、胜者、获胜类型和犯规", () => {
    const match = createMatch();
    const [first, second] = match.players;
    const base = { playerIds: [first.id, second.id] as [string, string], winnerId: first.id, winType: "normal" as const, fouls: {}, note: "", startedAt: 100 };
    expect(() => recordTeamBattleRound(match, { ...base, playerIds: [first.id, first.id] }, 200)).toThrow("不能相同");
    expect(() => recordTeamBattleRound(match, { ...base, playerIds: [first.id, "missing"] }, 200)).toThrow("成员不存在");
    expect(() => recordTeamBattleRound(match, { ...base, winnerId: "missing" }, 200)).toThrow("胜者");
    expect(() => recordTeamBattleRound(match, { ...base, winType: "invalid" as "normal" }, 200)).toThrow("获胜类型");
    expect(() => recordTeamBattleRound(match, { ...base, fouls: { missing: 1 } }, 200)).toThrow("犯规");
    expect(() => recordTeamBattleRound(match, { ...base, fouls: { [second.id]: -1 } }, 200)).toThrow("犯规");
  });

  it("更正和撤销只追加事件并从完整有效流水重算", () => {
    let match = createMatch();
    const [first, second] = match.players;
    match = record(match, first.id, 200);
    match = record(match, first.id, 300);
    const corrected = correctTeamBattleRound(match, match.events[0].id, {
      ...match.events[0].round!, winnerId: second.id, winType: "runout", note: " 更正 ",
    }, 400);
    expect(corrected.events).toHaveLength(3);
    expect(getPairProjection(corrected, first.id, second.id).scores).toEqual({ [first.id]: 1, [second.id]: 1 });
    expect(getTeamBattleProjection(corrected).playerStats[second.id]).toMatchObject({ wins: 1, runouts: 1 });
    const undone = undoLastTeamBattleRound(corrected, [second.id, first.id], 500);
    expect(undone.events).toHaveLength(4);
    expect(getEffectiveTeamBattleRounds(undone)).toHaveLength(1);
    expect(getPairProjection(undone, first.id, second.id).scores).toEqual({ [first.id]: 0, [second.id]: 1 });
    expect(match.events[0].round?.note).toBe("测试");
  });

  it("暂停、恢复和结束保持准确用时并阻止非法状态操作", () => {
    const match = createMatch();
    const paused = pauseTeamBattleMatch(match, 1_100);
    expect(teamBattleElapsedMs(paused, 5_100)).toBe(1_000);
    expect(() => record(paused)).toThrow("已暂停");
    expect(() => pauseTeamBattleMatch(paused)).toThrow("已暂停");
    const resumed = resumeTeamBattleMatch(paused, 5_100);
    expect(teamBattleElapsedMs(resumed, 6_100)).toBe(2_000);
    const finished = finishTeamBattleMatch(resumed, 7_100);
    expect(finished).toMatchObject({ status: "completed", endedAt: 7_100, pausedDurationMs: 4_000 });
    expect(() => addTeamBattlePlayer(finished, "丙")).toThrow("已结束");
    expect(() => finishTeamBattleMatch(finished)).toThrow("已结束");
  });

  it("8 人黄金样例同时得到稳定两两比分、总榜和成员报告", () => {
    const projection = getTeamBattleProjection(eightPlayerSample);
    expect(Object.fromEntries(projection.pairs.map((pair) => [pair.pairKey, pair.scores]))).toEqual(eightPlayerExpected.pairScores);
    expect(projection.pairs.map(({ pairKey }) => pairKey)).toEqual(["p1::p8", "p6::p7", "p1::p3", "p1::p2"]);
    expect(projection.standings).toEqual(eightPlayerExpected.standings);
    const report = getPlayerReport(eightPlayerSample, "p1");
    expect({
      player: report.player,
      wins: report.wins,
      losses: report.losses,
      differential: report.differential,
      opponents: report.opponents.map(({ opponent, scores, played }) => ({ opponent, scores, played, rounds: [] })),
      rounds: [],
    }).toEqual(eightPlayerExpected.playerReport);
    expect(getPairProjection(eightPlayerSample, "p2", "p1").scores).toEqual({ p2: 1, p1: 1 });
    expect(getPairProjection(eightPlayerSample, "p4", "p5").scores).toEqual({ p4: 0, p5: 0 });
  });
});
