import { describe, expect, it } from "vitest";
import {
  createDeck,
  DEFAULT_SETTINGS,
  drawCards,
  loadGameState,
  playCard,
  resetGame,
  setExcludedDefinitions,
  skipCard,
} from "./deck";
import { CARD_DEFINITIONS } from "../data/cards";
import { filterDeckSnapshotForGame, officialDeckSnapshot, parseDeckSnapshot } from "./custom-decks";

const first = () => 0;

describe("卡牌核心逻辑", () => {
  it("总卡牌实例数量为 51", () => expect(createDeck()).toHaveLength(51));

  it("官方卡牌 ID 固定且不重复", () => {
    expect(CARD_DEFINITIONS).toHaveLength(50);
    expect(new Set(CARD_DEFINITIONS.map((card) => card.id)).size).toBe(CARD_DEFINITIONS.length);
    expect(CARD_DEFINITIONS.every((card, index) => card.id === `card-${String(index + 1).padStart(3, "0")}`)).toBe(true);
  });

  it("拒绝伪造或超额的牌组快照", () => {
    expect(parseDeckSnapshot({ formatVersion: 1, name: "有效", cards: [{ source: "official", definitionId: "card-001", quantity: 1 }] })).not.toBeNull();
    expect(parseDeckSnapshot({ formatVersion: 1, name: "伪造", cards: [{ source: "official", definitionId: "card-999", quantity: 1 }] })).toBeNull();
    expect(parseDeckSnapshot({ formatVersion: 1, name: "超额", cards: [{ source: "official", definitionId: "card-001", quantity: 11 }] })).toBeNull();
  });

  it("50 张官方牌都有人工作出的玩法与影响标记", () => {
    expect(CARD_DEFINITIONS.every((card) => card.supportedGames.includes("chinese_eight") && card.ruleImpact)).toBe(true);
    expect(CARD_DEFINITIONS.filter((card) => card.supportedGames.includes("snooker")).map((card) => card.id)).toEqual([
      "card-001", "card-007", "card-008", "card-009", "card-011", "card-012", "card-016", "card-017", "card-020", "card-022", "card-024", "card-025", "card-026", "card-028", "card-030", "card-035", "card-038", "card-039", "card-045", "card-047", "card-049",
    ]);
  });

  it("斯诺克过滤器排除中八专属牌并保留数量快照", () => {
    const filtered = filterDeckSnapshotForGame(officialDeckSnapshot(), "snooker");
    expect(filtered).toMatchObject({ originalCount: 51, compatibleCount: 22, excludedCount: 29 });
    expect(filtered.snapshot.cards.every((card) => card.source === "official" && card.supportedGames.includes("snooker"))).toBe(true);
  });

  it("旧版自定义牌默认不兼容斯诺克", () => {
    const migrated = parseDeckSnapshot({ formatVersion: 1, name: "旧牌组", cards: [{ source: "custom", definitionId: "old", quantity: 1, snapshot: { title: "旧牌", effect: "旧效果", safetyLevel: "low" } }] });
    expect(migrated?.formatVersion).toBe(2);
    expect(filterDeckSnapshotForGame(migrated!, "snooker").compatibleCount).toBe(0);
  });

  it("无懈可击有两个不同实例和显示编号", () => {
    const cards = createDeck().filter((item) => item.title === "无懈可击");
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((item) => item.instanceId)).size).toBe(2);
    expect(cards.map((item) => item.displayNumber)).toEqual(["026-A", "026-B"]);
  });

  it("一套手牌按设置发牌", () => {
    const state = resetGame({ ...DEFAULT_SETTINGS, handMode: "shared", sharedHandSize: 5 }, first);
    expect(state.hands.shared).toHaveLength(5);
    expect(state.remaining).toHaveLength(46);
    expect(state.activeHand).toBe("shared");
  });

  it("双手牌可分别设置不同数量", () => {
    const state = resetGame({
      ...DEFAULT_SETTINGS,
      handMode: "dual",
      playerAHandSize: 2,
      playerBHandSize: 6,
    }, first);
    expect(state.hands.playerA).toHaveLength(2);
    expect(state.hands.playerB).toHaveLength(6);
    expect(state.remaining).toHaveLength(43);
  });

  it("一次抽取 N 张不会重复", () => {
    const state = resetGame({ ...DEFAULT_SETTINGS, sharedHandSize: 0 }, first);
    const result = drawCards(state, "shared", 10, first);
    expect(new Set(result.hands.shared.map((item) => item.instanceId)).size).toBe(10);
  });

  it("连续抽取不会抽到已经抽出的卡", () => {
    const state = resetGame({ ...DEFAULT_SETTINGS, sharedHandSize: 0 }, first);
    const once = drawCards(state, "shared", 12, first);
    const twice = drawCards(once, "shared", 12, first);
    expect(new Set(twice.hands.shared.map((item) => item.instanceId)).size).toBe(24);
  });

  it("使用卡牌后进入带归属的记录", () => {
    const state = resetGame({ ...DEFAULT_SETTINGS, sharedHandSize: 1 }, first);
    const target = state.hands.shared[0];
    const played = playCard(state, "shared", target.instanceId, 123);
    expect(played.hands.shared).toHaveLength(0);
    expect(played.used[0]).toMatchObject({ owner: "shared", recordedAt: 123 });
    expect(playCard(played, "shared", target.instanceId)).toBe(played);
  });

  it("风险卡可以跳过并补抽", () => {
    const deck = createDeck();
    const risk = deck.find((item) => item.safetyNote);
    expect(risk).toBeDefined();
    const state = resetGame({ ...DEFAULT_SETTINGS, sharedHandSize: 0 }, first);
    const custom = {
      ...state,
      remaining: state.remaining.filter((item) => item.instanceId !== risk!.instanceId),
      hands: { ...state.hands, shared: [risk!] },
    };
    const skipped = skipCard(custom, "shared", risk!.instanceId, first, 456);
    expect(skipped.discarded[0]).toMatchObject({ owner: "shared", recordedAt: 456 });
    expect(skipped.hands.shared).toHaveLength(1);
  });

  it("损坏的本地数据会被拒绝", () => {
    expect(loadGameState("{broken")).toBeNull();
    expect(loadGameState(JSON.stringify({ remaining: [] }))).toBeNull();
  });

  it("旧版状态可迁移为一套手牌", () => {
    const deck = createDeck();
    const legacy = {
      remaining: deck.slice(2),
      hand: [deck[0]],
      used: [deck[1]],
    };
    const migrated = loadGameState(JSON.stringify(legacy));
    expect(migrated?.version).toBe(3);
    expect(migrated?.hands.shared).toHaveLength(1);
    expect(migrated?.used[0].owner).toBe("shared");
  });

  it("不能抽取超过剩余数量的卡", () => {
    const state = resetGame({ ...DEFAULT_SETTINGS, sharedHandSize: 0 }, first);
    expect(() => drawCards(state, "shared", 52, first)).toThrow();
  });

  it("任何卡牌都可经同意跳过并补抽", () => {
    const state = resetGame({ ...DEFAULT_SETTINGS, sharedHandSize: 1 }, first);
    const ordinary = state.hands.shared.find((card) => !card.safetyNote)!;
    const skipped = skipCard(state, "shared", ordinary.instanceId, first, 789);
    expect(skipped.discarded[0].card.instanceId).toBe(ordinary.instanceId);
    expect(skipped.hands.shared).toHaveLength(1);
  });

  it("可从本局剩余牌库排除并重新纳入整类卡牌", () => {
    const state = resetGame({ ...DEFAULT_SETTINGS, sharedHandSize: 0 }, first);
    const excluded = setExcludedDefinitions(state, ["card-026"]);
    expect(excluded.excluded).toHaveLength(2);
    expect(excluded.remaining).toHaveLength(49);
    expect(excluded.settings.excludedDefinitionIds).toEqual(["card-026"]);
    const restored = setExcludedDefinitions(excluded, []);
    expect(restored.excluded).toHaveLength(0);
    expect(restored.remaining).toHaveLength(51);
  });

  it("新局会在发牌前应用排除范围", () => {
    const state = resetGame({
      ...DEFAULT_SETTINGS,
      sharedHandSize: 3,
      excludedDefinitionIds: ["card-026"],
    }, first);
    expect(state.excluded).toHaveLength(2);
    expect(state.remaining).toHaveLength(46);
    expect(state.hands.shared.every((card) => card.definitionId !== "card-026")).toBe(true);
  });
});
