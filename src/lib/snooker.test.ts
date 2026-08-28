import { describe, expect, it } from "vitest";
import { CARD_DEFINITIONS } from "../data/cards";
import {
  correctSnookerEvent,
  createSnookerMatch,
  getSnookerBreakBallCounts,
  getSnookerBreakStats,
  getSnookerScoreSituation,
  isOfficialSnookerFoulPoints,
  isSnookerMatch,
  isValidSnookerBestOf,
  isValidSnookerInitialReds,
  projectSnookerMatch,
  recordSnookerCardAction,
  recordSnookerCommand,
  runSnookerRuleTestVector,
  shouldShowSnookerBreakPrompt,
  SNOOKER_BALL_VALUES,
  SNOOKER_BREAK_PROMPT_MIN_POINTS,
  SNOOKER_COLOUR_CLEARANCE_ORDER,
  SNOOKER_OFFICIAL_FOUL_POINTS,
  SNOOKER_RULE_TEST_VECTORS,
  SNOOKER_RULESET,
  SNOOKER_V1_REFEREE_BOUNDARY,
  SNOOKER_VARIANT_LABELS,
  undoLastSnookerEvent,
} from "./snooker";

describe("斯诺克阶段 0 规则契约", () => {
  it("固定规则版本、球值与清彩顺序", () => {
    expect(SNOOKER_RULESET).toBe("wpbsa-2024-09");
    expect(SNOOKER_BALL_VALUES).toEqual({ red: 1, yellow: 2, green: 3, brown: 4, blue: 5, pink: 6, black: 7 });
    expect(SNOOKER_COLOUR_CLEARANCE_ORDER).toEqual(["yellow", "green", "brown", "blue", "pink", "black"]);
  });

  it("31 分开始提示单杆", () => {
    expect(SNOOKER_BREAK_PROMPT_MIN_POINTS).toBe(31);
    expect(shouldShowSnookerBreakPrompt(30)).toBe(false);
    expect(shouldShowSnookerBreakPrompt(31)).toBe(true);
  });

  it("正式罚分只接受 4–7 且同杆多项犯规取最高值", () => {
    expect(SNOOKER_OFFICIAL_FOUL_POINTS).toEqual([4, 5, 6, 7]);
    expect([1, 2, 3, 8].every((points) => !isOfficialSnookerFoulPoints(points))).toBe(true);
    expect(SNOOKER_OFFICIAL_FOUL_POINTS.every(isOfficialSnookerFoulPoints)).toBe(true);
    const vector = SNOOKER_RULE_TEST_VECTORS.find(({ name }) => name.includes("highest foul"));
    expect(vector?.commands[0]).toEqual({ type: "foul", values: [4, 6, 7] });
    expect(vector?.expected.scores).toEqual([12, 27]);
  });

  it("Best of 只接受自由局或正奇数", () => {
    expect([null, 1, 3, 5, 99].every(isValidSnookerBestOf)).toBe(true);
    expect([-1, 0, 2, 4, 1.5].some(isValidSnookerBestOf)).toBe(false);
  });

  it("红球数接受 1–15 的整数并默认使用 15 红", () => {
    expect([1, 6, 10, 15].every(isValidSnookerInitialReds)).toBe(true);
    expect([0, 16, 1.5].some(isValidSnookerInitialReds)).toBe(false);
    expect(createSnookerMatch({ playerNames: ["甲", "乙"], bestOf: 3, firstStriker: 0 }, 100)).toMatchObject({ initialReds: 15, currentFrame: { initialReds: 15, redsRemaining: 15 } });
    expect(createSnookerMatch({ playerNames: ["甲", "乙"], bestOf: 3, firstStriker: 0, initialReds: 6 }, 100)).toMatchObject({ initialReds: 6, currentFrame: { initialReds: 6, redsRemaining: 6 } });
    expect(() => createSnookerMatch({ playerNames: ["甲", "乙"], bestOf: 3, firstStriker: 0, initialReds: 16 }, 100)).toThrow("红球数必须是 1–15 的整数");
  });

  it("奇招牌始终标记为变体局", () => {
    expect(SNOOKER_VARIANT_LABELS).toEqual({ standard: "标准斯诺克", trick_cards: "奇招牌变体局" });
  });

  it("首版不推断球位、自由球、miss 或复位", () => {
    expect(SNOOKER_V1_REFEREE_BOUNDARY).toEqual({
      tracksBallPositions: false,
      freeBall: "manual",
      foulAndMiss: "manual",
      ballReplacement: "manual",
    });
  });

  it("固化红彩、清彩、147、155、最后黑球和重置黑球向量", () => {
    expect(SNOOKER_RULE_TEST_VECTORS.map(({ name }) => name)).toEqual([
      "red-colour alternation returns to a red",
      "last red and colour lead into ordered clearance",
      "fifteen red-black pairs and the clearance score 147",
      "a pre-red free ball creates a separate 155 route",
      "only the highest foul value from one stroke is awarded",
      "the final black ends a non-tied frame",
      "a tied final black enters respotted black without changing the tie",
      "the first score on a respotted black ends the frame",
    ]);
    expect(SNOOKER_RULE_TEST_VECTORS.find(({ name }) => name.includes("score 147"))?.expected).toMatchObject({
      scores: [147, 0], route: "147", phase: "completed",
    });
    expect(SNOOKER_RULE_TEST_VECTORS.find(({ name }) => name.includes("155 route"))?.expected).toMatchObject({
      scores: [155, 0], route: "155-free-ball", phase: "completed",
    });
  });
});

describe("斯诺克阶段 3 奇招牌白名单", () => {
  it("创建变体局时只发斯诺克兼容牌并冻结过滤统计", () => {
    const match = createSnookerMatch({ playerNames: ["甲", "乙"], bestOf: 3, firstStriker: 0, variant: "trick_cards", cardMode: "independent", initialHandSize: 3 }, 100);
    expect(match.cards?.deckSnapshot).toMatchObject({ game: "snooker", originalCardCount: 51, cardCount: 22, excludedForGameCount: 29 });
    expect(match.cards?.deckSnapshot.snapshot?.cards).toHaveLength(21);
    expect(Object.values(match.cards!.hands).flat().every((card) => CARD_DEFINITIONS.find((item) => item.id === card.definitionId)?.supportedGames.includes("snooker"))).toBe(true);
    const playerId = match.players[0].id;
    const card = match.cards!.hands[playerId][0];
    const skipped = recordSnookerCardAction(match, playerId, card.instanceId, "skip", 101, () => 0);
    expect(skipped.cards?.skipped[0].instanceId).toBe(card.instanceId);
    expect(skipped.cards?.hands[playerId]).toHaveLength(3);
  });
});

const create = () => createSnookerMatch({ playerNames: ["甲", "乙"], bestOf: 3, firstStriker: 0 }, 100);

function playScoringVector(name: "score 147" | "155 route") {
  const vector = SNOOKER_RULE_TEST_VECTORS.find((item) => item.name.includes(name))!;
  let match = create();
  let now = 200;
  for (const command of vector.commands) {
    if (command.type !== "pot") throw new Error("该向量不是连续得分向量");
    if (command.freeBallAs) match = recordSnookerCommand(match, {
      type: "snooker.free_ball.declare",
      nominatedBall: command.ball,
      valueAs: command.freeBallAs,
    }, now++);
    match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: command.ball }, now++);
  }
  return match;
}

describe("斯诺克阶段 1 共享规则引擎", () => {
  it("由同一纯投影器执行全部规则向量", () => {
    for (const vector of SNOOKER_RULE_TEST_VECTORS) expect(runSnookerRuleTestVector(vector)).toEqual(vector.expected);
  });

  it("拒绝连续红球和错误清彩目标", () => {
    const afterRed = recordSnookerCommand(create(), { type: "snooker.pot.record", ball: "red" }, 200);
    expect(() => recordSnookerCommand(afterRed, { type: "snooker.pot.record", ball: "red" }, 300)).toThrow("当前目标是彩球");

    let clearance = createSnookerMatch({ playerNames: ["甲", "乙"], bestOf: 1, firstStriker: 0 }, 100);
    for (let index = 0; index < 15; index += 1) {
      clearance = recordSnookerCommand(clearance, { type: "snooker.pot.record", ball: "red" }, 400 + index * 2);
      clearance = recordSnookerCommand(clearance, { type: "snooker.pot.record", ball: "black" }, 401 + index * 2);
    }
    expect(() => recordSnookerCommand(clearance, { type: "snooker.pot.record", ball: "green" }, 400)).toThrow("当前目标是黄球");
  });

  it("结束本杆和犯规归档单杆、切换球员并只取最高罚分", () => {
    let match = create();
    match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "red" }, 200);
    match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "black" }, 300);
    match = recordSnookerCommand(match, { type: "snooker.visit.end", reason: "miss" }, 400);
    expect(match.currentFrame).toMatchObject({ strikerId: match.players[1].id, scores: { [match.players[0].id]: 8 } });
    expect(match.currentFrame?.breaks[0]).toMatchObject({ points: 8, playerId: match.players[0].id });

    match = recordSnookerCommand(match, { type: "snooker.foul.record", values: [4, 6], isMiss: true }, 500);
    expect(match.currentFrame).toMatchObject({ strikerId: match.players[0].id, scores: { [match.players[0].id]: 14 } });
  });

  it("记录自由球和 miss 后的重打选择", () => {
    let match = create();
    match = recordSnookerCommand(match, { type: "snooker.foul.record", values: [4], isMiss: true }, 200);
    expect(match.currentFrame?.strikerId).toBe(match.players[1].id);
    match = recordSnookerCommand(match, { type: "snooker.replay.request", kind: "restore" }, 300);
    expect(match.currentFrame?.strikerId).toBe(match.players[0].id);
    match = recordSnookerCommand(match, { type: "snooker.free_ball.declare", nominatedBall: "black", valueAs: "red" }, 400);
    match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "black" }, 500);
    expect(match.currentFrame).toMatchObject({ phase: "colour_after_red", redsRemaining: 15 });
    expect(match.currentFrame?.currentBreak).toMatchObject({ points: 1, route: "155-free-ball", freeBallUsed: true });
  });

  it("31+、最高单杆和 147/155 从逐球事件派生", () => {
    let match = create();
    for (let index = 0; index < 4; index += 1) {
      match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "red" }, 200 + index * 2);
      match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "black" }, 201 + index * 2);
    }
    expect(getSnookerBreakStats(match)).toMatchObject({
      highestBreak: 32,
      highestByPlayer: { [match.players[0].id]: 32, [match.players[1].id]: 0 },
      breaks30PlusCount: 1,
    });
    expect(getSnookerBreakStats(match).breaks30Plus).toHaveLength(1);
    expect(match.currentFrame?.currentBreak).toMatchObject({ redsPotted: 4, coloursPotted: 4, redBlackPairs: 4, route: "147" });
    expect(getSnookerBreakStats(playScoringVector("score 147"))).toMatchObject({ completed147: 1, completed155: 0, highestBreak: 147 });
    expect(getSnookerBreakStats(playScoringVector("155 route"))).toMatchObject({ completed147: 0, completed155: 1, highestBreak: 155 });
  });

  it("按实际入袋球统计本杆各色数量", () => {
    let match = create();
    for (let index = 0; index < 4; index += 1) {
      match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "red" }, 200 + index * 2);
      match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "black" }, 201 + index * 2);
    }
    expect(getSnookerBreakBallCounts(match.currentFrame!.currentBreak)).toEqual({ red: 4, yellow: 0, green: 0, brown: 0, blue: 0, pink: 0, black: 4 });
  });

  it("按当前阶段计算台面剩余分和被超分数", () => {
    let match = create();
    expect(getSnookerScoreSituation(match.currentFrame!)).toMatchObject({ remainingPoints: 147, lead: 0, excessPoints: 0 });
    for (let index = 0; index < 10; index += 1) {
      match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "red" }, 200 + index * 2);
      match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "black" }, 201 + index * 2);
    }
    expect(getSnookerScoreSituation(match.currentFrame!)).toEqual({
      remainingPoints: 67,
      leaderId: match.players[0].id,
      trailingId: match.players[1].id,
      lead: 80,
      excessPoints: 13,
    });
  });

  it("最后黑球平分后重置，首次得分结束该局", () => {
    const vector = SNOOKER_RULE_TEST_VECTORS.find(({ name }) => name.includes("tied final black"))!;
    expect(runSnookerRuleTestVector(vector)).toEqual(vector.expected);
    const decided = SNOOKER_RULE_TEST_VECTORS.find(({ name }) => name.includes("first score on a respotted"))!;
    expect(runSnookerRuleTestVector(decided)).toEqual(decided.expected);
  });

  it("结束局累计场级局分但不自动结束 Best of", () => {
    let match = create();
    match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "red" }, 150);
    match = recordSnookerCommand(match, { type: "snooker.frame.finish", winnerId: match.players[0].id, reason: "resignation" }, 200);
    match = recordSnookerCommand(match, { type: "snooker.frame.finish", winnerId: match.players[0].id, reason: "award" }, 300);
    expect(match.framesWon[match.players[0].id]).toBe(2);
    expect(match.completedFrames).toHaveLength(2);
    expect(match.currentFrame?.number).toBe(3);
    expect(match.status).toBe("active");
    expect(match.completedFrames[0].breaks).toHaveLength(1);
  });

  it("拒绝非法罚分、无前置犯规重打和无平分重置黑球", () => {
    const match = create();
    expect(() => recordSnookerCommand(match, { type: "snooker.foul.record", values: [3 as 4] }, 200)).toThrow("正式罚分只能为 4–7");
    expect(() => recordSnookerCommand(match, { type: "snooker.replay.request", kind: "restore" }, 200)).toThrow("没有可重打的犯规");
    expect(() => recordSnookerCommand(match, { type: "snooker.respotted_black.start", firstStrikerId: match.players[0].id }, 200)).toThrow("当前不满足重置黑球条件");
  });

  it("更正早期事件后全量回放，撤销只追加更正事件", () => {
    let match = create();
    match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "red" }, 200);
    match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "black" }, 300);
    match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "red" }, 400);
    const blackEvent = match.events[1];
    match = correctSnookerEvent(match, blackEvent.id, { type: "snooker.pot.record", ball: "pink" }, 500);
    expect(match.currentFrame).toMatchObject({ scores: { [match.players[0].id]: 8 }, redsRemaining: 13 });
    expect(match.currentFrame?.currentBreak.route).toBe("none");
    const undone = undoLastSnookerEvent(match, 600);
    expect(undone.events).toHaveLength(5);
    expect(undone.currentFrame).toMatchObject({ scores: { [match.players[0].id]: 7 }, redsRemaining: 14, phase: "reds" });
    expect(projectSnookerMatch(undone)).toEqual(undone);
  });

  it("僵局重开保留流水，改名、暂停和结束整场均事件化", () => {
    let match = create();
    match = recordSnookerCommand(match, { type: "snooker.frame.restart", firstStrikerId: match.players[1].id }, 200);
    match = recordSnookerCommand(match, { type: "snooker.player.rename", playerId: match.players[0].id, name: "新甲" }, 300);
    match = recordSnookerCommand(match, { type: "snooker.pause" }, 400);
    expect(() => recordSnookerCommand(match, { type: "snooker.pot.record", ball: "red" }, 500)).toThrow("比赛已暂停");
    match = recordSnookerCommand(match, { type: "snooker.resume" }, 600);
    match = recordSnookerCommand(match, { type: "snooker.finish" }, 700);
    expect(match).toMatchObject({ status: "completed", pausedDurationMs: 200, endedAt: 700 });
    expect(match.players[0].name).toBe("新甲");
    expect(match.currentFrame).toMatchObject({ restarts: 1, strikerId: match.players[1].id });
    expect(match.events.map(({ type }) => type)).toEqual([
      "snooker.frame.restart", "snooker.player.rename", "snooker.pause", "snooker.resume", "snooker.finish",
    ]);
    expect(isSnookerMatch(match)).toBe(true);
  });
});
