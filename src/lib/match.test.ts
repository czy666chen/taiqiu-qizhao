import { describe, expect, it } from "vitest";
import {
  addMatchPlayer,
  applyBlackGoldScore,
  applyHandicapScore,
  applyScore,
  applyTransferScore,
  backfillScoreEvent,
  createMatch,
  correctScoreEvent,
  deleteMatchPlayer,
  DEFAULT_RULES,
  drawMatchCards,
  finishMatch,
  getPlayerAvatarColor,
  getRankings,
  hasPlayerActivity,
  leaveMatchPlayer,
  playMatchCard,
  skipMatchCard,
  setCurrentPlayer,
  triggerMatchCardRefill,
  undoCardAction,
  undoLastScore,
  updateMatchCardSettings,
} from "./match";

const first = () => 0;
const draft = {
  mode: "score" as const,
  playerNames: ["阿杰", "老王", "小李"],
  initialScore: 100,
  rules: DEFAULT_RULES,
  cardMode: "none" as const,
  initialHandSize: 0,
};

describe("追分对局", () => {
  it("使用固化的混合牌组快照创建对局", () => {
    const match = createMatch({
      ...draft,
      mode: "cards",
      cardMode: "independent",
      initialHandSize: 1,
      deckSnapshot: {
        formatVersion: 2,
        name: "周五朋友局",
        cards: [
          { source: "official", definitionId: "card-001", quantity: 1, supportedGames: ["chinese_eight", "snooker"] },
          { source: "custom", definitionId: "custom-1", quantity: 1, snapshot: { title: "再来一杆", effect: "再打一杆", safetyLevel: "low", supportedGames: ["chinese_eight"] } },
        ],
      },
    }, 100, first);
    expect(match.cards?.deckSnapshot).toMatchObject({ name: "周五朋友局", source: "user", cardCount: 2 });
    expect([...match.cards!.remaining, ...Object.values(match.cards!.hands).flat()].map((card) => card.title).sort()).toEqual(["再来一杆", "落井下石"]);
  });

  it("uses the 14710 rules as the default score preset", () => {
    expect(DEFAULT_RULES.map((rule) => [rule.id, rule.value])).toEqual([
      ["foul", 1],
      ["normal-win", 4],
      ["small-gold", 7],
      ["big-gold", 10],
    ]);
  });

  it("支持 2–8 人并保留同名玩家的独立 ID", () => {
    const match = createMatch({ ...draft, playerNames: ["阿杰", "阿杰"] }, 100, first);
    expect(match.players).toHaveLength(2);
    expect(new Set(match.players.map((player) => player.id)).size).toBe(2);
  });

  it.each([2, 4, 8])("支持 %i 人建立核心对局", (playerCount) => {
    const playerNames = Array.from({ length: playerCount }, (_, index) => `玩家 ${index + 1}`);
    const match = createMatch({ ...draft, playerNames }, 100, first);
    expect(match.players).toHaveLength(playerCount);
    expect(match.currentPlayerId).toBe(match.players[0].id);
  });

  it("按自定义分值记分并自动轮转", () => {
    const match = createMatch(draft, 100, first);
    const scored = applyScore(match, "normal-win", match.players[0].id, 200);
    expect(scored.players[0].score).toBe(104);
    expect(scored.currentPlayerId).toBe(match.players[1].id);
    expect(scored.scoreEvents[0].changes[match.players[0].id]).toBe(4);
  });

  it("支持每名玩家独立初始分与得分者继续策略", () => {
    const match = createMatch({ ...draft, playerInitialScores: [10, 20, 30], turnStrategy: "winner_stays" }, 100, first);
    expect(match.players.map((player) => player.score)).toEqual([10, 20, 30]);
    const scored = applyScore(match, "normal-win", match.players[1].id, 200);
    expect(scored.currentPlayerId).toBe(match.players[1].id);
  });

  it("中途加入、手动切换与离场均保留稳定玩家历史", () => {
    const match = createMatch(draft, 100, first);
    const added = addMatchPlayer(match, "新玩家", 50, 200);
    const newcomer = added.players.at(-1)!;
    expect(newcomer).toMatchObject({ name: "新玩家", score: 50, joinedAt: 200, active: true });
    const selected = setCurrentPlayer(added, newcomer.id);
    expect(selected.currentPlayerId).toBe(newcomer.id);
    const left = leaveMatchPlayer(selected, newcomer.id, 300);
    expect(left.players.find((player) => player.id === newcomer.id)).toMatchObject({ active: false, leftAt: 300, score: 50 });
  });

  it("无流水玩家可删除，产生流水后只能离场", () => {
    const match = createMatch(draft, 100, first);
    const added = addMatchPlayer(match, "临时", 0, 200);
    const newcomer = added.players.at(-1)!;
    expect(deleteMatchPlayer(added, newcomer.id).players.some((player) => player.id === newcomer.id)).toBe(false);
    const scored = applyScore(added, "normal-win", newcomer.id, 300);
    expect(hasPlayerActivity(scored, newcomer.id)).toBe(true);
    expect(deleteMatchPlayer(scored, newcomer.id)).toBe(scored);
    expect(leaveMatchPlayer(scored, newcomer.id, 400).players.find((player) => player.id === newcomer.id)?.active).toBe(false);
  });

  it("犯规扣分且撤销同时恢复积分与当前玩家", () => {
    const match = createMatch(draft, 100, first);
    const fouled = applyScore(match, "foul", match.players[0].id, 200);
    expect(fouled.players[0].score).toBe(99);
    const undone = undoLastScore(fouled);
    expect(undone.players[0].score).toBe(100);
    expect(undone.currentPlayerId).toBe(match.players[0].id);
    expect(undone.scoreEvents).toHaveLength(0);
  });

  it("转账计分由每名输家支付固定分数且总分守恒", () => {
    const match = createMatch(draft, 100, first);
    const totalBefore = match.players.reduce((sum, player) => sum + player.score, 0);
    const transferred = applyTransferScore(match, match.players[0].id, [match.players[1].id, match.players[2].id], 10, "两位输家各付 10", 200);
    expect(transferred.players.map((player) => player.score)).toEqual([120, 90, 90]);
    expect(transferred.players.reduce((sum, player) => sum + player.score, 0)).toBe(totalBefore);
    expect(transferred.scoreEvents[0]).toMatchObject({ type: "transfer", note: "两位输家各付 10" });
    expect(undoLastScore(transferred).players.map((player) => player.score)).toEqual([100, 100, 100]);
  });

  it("黑金按双倍基础分由每家支付，让杆在两名玩家间转移", () => {
    const match = createMatch(draft, 100, first);
    const blackGold = applyBlackGoldScore(match, match.players[0].id, 5, "黑金结算", 200);
    expect(blackGold.players.map((player) => player.score)).toEqual([120, 90, 90]);
    expect(blackGold.scoreEvents[0]).toMatchObject({ label: "黑金 · 每家 10 分", note: "黑金结算" });
    const handicap = applyHandicapScore(blackGold, match.players[2].id, match.players[0].id, 8, "开局让杆", 300);
    expect(handicap.players.map((player) => player.score)).toEqual([112, 90, 98]);
    expect(handicap.scoreEvents[0]).toMatchObject({ label: "让杆 · 8 分", note: "开局让杆" });
  });

  it("事件更正保留原流水并追加关联反向事件", () => {
    const match = createMatch(draft, 100, first);
    const scored = applyScore(match, "normal-win", match.players[0].id, 200);
    const corrected = correctScoreEvent(scored, scored.scoreEvents[0].id, "记错玩家", 300);
    expect(corrected.players[0].score).toBe(100);
    expect(corrected.scoreEvents).toHaveLength(2);
    expect(corrected.scoreEvents[0]).toMatchObject({ type: "correction", correctsEventId: scored.scoreEvents[0].id, note: "记错玩家" });
    expect(corrected.scoreEvents[1]).toEqual(scored.scoreEvents[0]);
    expect(correctScoreEvent(corrected, scored.scoreEvents[0].id, "重复", 400)).toBe(corrected);
  });

  it("计分备注与补录均进入不可变流水", () => {
    const match = createMatch(draft, 100, first);
    const scored = applyScore(match, "normal-win", match.players[0].id, 200, "翻中袋");
    expect(scored.scoreEvents[0].note).toBe("翻中袋");
    const backfilled = backfillScoreEvent(scored, match.players[1].id, -8, "漏记犯规", "第二局", 150);
    expect(backfilled.players[1].score).toBe(92);
    expect(backfilled.scoreEvents[0]).toMatchObject({ label: "补录 · 漏记犯规", note: "第二局", occurredAt: 150 });
  });

  it("结束局只有显式受控模式才允许追加更正", () => {
    const started = createMatch(draft, 100, first);
    const match = applyScore(started, "normal-win", started.players[0].id, 200);
    const completed = finishMatch(match, 300);
    expect(correctScoreEvent(completed, completed.scoreEvents[0].id, "普通尝试", 400)).toBe(completed);
    const corrected = correctScoreEvent(completed, completed.scoreEvents[0].id, "受控纠错", 400, true);
    expect(corrected.status).toBe("completed");
    expect(corrected.scoreEvents[0]).toMatchObject({ type: "correction", note: "受控纠错" });
  });

  it("结算后保存确定排名", () => {
    const match = createMatch(draft, 100, first);
    const scored = applyScore(match, "big-gold", match.players[1].id, 200);
    const completed = finishMatch(scored, 300);
    expect(completed.status).toBe("completed");
    expect(completed.endedAt).toBe(300);
    expect(getRankings(completed)[0].name).toBe("老王");
  });
});

describe("追分与奇招牌组合", () => {
  it.each([
    ["complete", 51],
    ["light", 25],
    ["competitive", 26],
    ["safe", 37],
  ] as const)("%s 官方牌组保存不可变版本快照", (deckId, expectedCount) => {
    const match = createMatch({ ...draft, mode: "score_cards", cardMode: "shared", initialHandSize: 0, deckId }, 100, first);
    expect(match.cards!.deckSnapshot).toMatchObject({ id: deckId, version: 1, cardCount: expectedCount });
    expect(match.cards!.deckSnapshot.definitionIds).not.toBe(match.cards!.remaining);
    expect(match.cards!.remaining).toHaveLength(expectedCount);
  });
  it("独立手牌不放回且每名玩家都有起始手牌", () => {
    const match = createMatch({ ...draft, mode: "score_cards", cardMode: "independent", initialHandSize: 2 }, 100, first);
    const cards = Object.values(match.cards!.hands).flat();
    expect(cards).toHaveLength(6);
    expect(new Set(cards.map((card) => card.instanceId)).size).toBe(6);
    expect(match.cards!.remaining).toHaveLength(45);
  });

  it("共用手牌可抽取、使用并生成卡牌流水", () => {
    const match = createMatch({ ...draft, mode: "score_cards", cardMode: "shared", initialHandSize: 1 }, 100, first);
    const drawn = drawMatchCards(match, "shared", 1, 200, first);
    const target = drawn.cards!.hands.shared[0];
    const played = playMatchCard(drawn, "shared", target.instanceId, 300);
    expect(played.cards!.used[0].instanceId).toBe(target.instanceId);
    expect(played.cards!.events.some((event) => event.type === "play")).toBe(true);
  });

  it("危险卡可安全跳过并补抽", () => {
    const match = createMatch({ ...draft, mode: "score_cards", cardMode: "shared", initialHandSize: 0 }, 100, first);
    const risk = match.cards!.remaining.find((card) => card.safetyNote)!;
    const custom = {
      ...match,
      cards: {
        ...match.cards!,
        remaining: match.cards!.remaining.filter((card) => card.instanceId !== risk.instanceId),
        hands: { shared: [risk] },
      },
    };
    const skipped = skipMatchCard(custom, "shared", risk.instanceId, 200, first);
    expect(skipped.cards!.skipped[0].instanceId).toBe(risk.instanceId);
    expect(skipped.cards!.hands.shared).toHaveLength(1);
  });

  it.each(["game", "round"] as const)("%s 自动补牌补至手牌上限", (policy) => {
    const match = createMatch({ ...draft, mode: "score_cards", cardMode: "shared", initialHandSize: 0, cardAutoDrawPolicy: policy, cardHandLimit: 3 }, 100, first);
    const refilled = triggerMatchCardRefill(match, policy, 200, first);
    expect(refilled.cards!.hands.shared).toHaveLength(3);
    expect(refilled.cards!.events.filter((event) => event.type === "draw")).toHaveLength(3);
  });

  it("用牌后自动补牌且手牌上限阻止额外手动抽牌", () => {
    const match = createMatch({ ...draft, mode: "score_cards", cardMode: "shared", initialHandSize: 1, cardAutoDrawPolicy: "after_play", cardHandLimit: 1 }, 100, first);
    const target = match.cards!.hands.shared[0];
    const played = playMatchCard(match, "shared", target.instanceId, 200, undefined, first);
    expect(played.cards!.hands.shared).toHaveLength(1);
    expect(played.cards!.events.slice(0, 2).map((event) => event.type)).toEqual(["draw", "play"]);
    expect(drawMatchCards(played, "shared", 1, 300, first)).toBe(played);
  });

  it("可在对局中调整补牌策略和手牌上限", () => {
    const match = createMatch({ ...draft, mode: "score_cards", cardMode: "shared", initialHandSize: 1 }, 100, first);
    const updated = updateMatchCardSettings(match, { autoDrawPolicy: "round", handLimit: 4, exhaustionPolicy: "reshuffle" });
    expect(updated.cards).toMatchObject({ autoDrawPolicy: "round", handLimit: 4, exhaustionPolicy: "reshuffle" });
  });

  it("牌库耗尽默认停止，确认后可重洗弃牌", () => {
    const match = createMatch({ ...draft, mode: "score_cards", cardMode: "shared", initialHandSize: 0, cardHandLimit: 2, cardExhaustionPolicy: "reshuffle" }, 100, first);
    const recycled = match.cards!.remaining[0];
    const exhausted = { ...match, cards: { ...match.cards!, remaining: [], used: [recycled], hands: { shared: [] } } };
    expect(drawMatchCards(exhausted, "shared", 1, 200, first)).toBe(exhausted);
    const reshuffled = drawMatchCards(exhausted, "shared", 1, 200, first, { allowReshuffle: true });
    expect(reshuffled.cards!.hands.shared[0].instanceId).toBe(recycled.instanceId);
    expect(reshuffled.cards!.events.some((event) => event.type === "reshuffle")).toBe(true);
  });

  it("按安全等级、类别和关键词过滤并固化牌组快照", () => {
    const match = createMatch({ ...draft, mode: "score_cards", cardMode: "shared", initialHandSize: 0, cardFilter: { excludedCategories: ["social"], maxSafetyLevel: "low", excludedKeywords: ["红包"] } }, 100, first);
    const allCards = match.cards!.remaining;
    expect(allCards.every((card) => !card.safetyNote && !card.effect.includes("红包"))).toBe(true);
    expect(match.cards!.deckSnapshot.filter).toMatchObject({ excludedCategories: ["social"], maxSafetyLevel: "low", excludedKeywords: ["红包"] });
  });

  it("卡牌计分双向关联，撤销时同时恢复积分、手牌和流水", () => {
    const match = createMatch({ ...draft, mode: "score_cards", cardMode: "shared", initialHandSize: 1 }, 100, first);
    const target = match.cards!.hands.shared[0];
    const played = playMatchCard(match, "shared", target.instanceId, 200, { playerId: match.players[0].id, delta: 7, note: "卡牌奖励" }, first);
    const playEvent = played.cards!.events.find((event) => event.type === "play")!;
    expect(played.players[0].score).toBe(107);
    expect(played.scoreEvents[0].linkedCardEventId).toBe(playEvent.id);
    expect(playEvent.relatedScoreEventId).toBe(played.scoreEvents[0].id);
    expect(played.scoreEvents[0].occurredAt).toBeGreaterThan(playEvent.occurredAt);
    const undone = undoCardAction(played, playEvent.id);
    expect(undone.players[0].score).toBe(100);
    expect(undone.scoreEvents).toHaveLength(0);
    expect(undone.cards!.hands.shared.some((card) => card.instanceId === target.instanceId)).toBe(true);
    expect(undone.cards!.used).toHaveLength(0);
  });

  it("keeps each avatar color bound to the player after rankings change", () => {
    const match = createMatch(draft, 100, first);
    const player = match.players[1];
    const colorBefore = getPlayerAvatarColor(player.id);
    const scored = applyScore(match, "big-gold", player.id, 200);
    const rankedPlayer = getRankings(scored).find((item) => item.id === player.id)!;
    expect(getRankings(scored)[0].id).toBe(player.id);
    expect(getPlayerAvatarColor(rankedPlayer.id)).toBe(colorBefore);
  });
});
