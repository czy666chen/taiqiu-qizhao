import { secureRandomIndex, type CardInstance } from "../../src/lib/deck";
import { getOfficialDeck, type OfficialDeckId } from "../../src/lib/official-decks";
import { deckSnapshotInstances, filterDeckSnapshotForGame, officialDeckSnapshot, parseDeckSnapshot, type DeckSnapshot } from "../../src/lib/custom-decks";
import type { SupportedGame } from "../../src/data/cards";
import type { JsonObject, JsonValue } from "./chase-scoring";

export type RoomCardMode = "none" | "independent";

export type RoomCardEvent = {
  id: string;
  type: "draw" | "play" | "skip" | "hand_size" | "redeal";
  playerId: string;
  card?: CardInstance;
  size?: number;
  occurredAt: number;
};

export type RoomCardState = {
  mode: "independent";
  deckId: string;
  deckSnapshot: {
    id: string;
    version: number;
    name: string;
    definitionIds: string[];
    cardCount: number;
    source?: "official" | "user";
    game?: SupportedGame;
    originalCardCount?: number;
    excludedForGameCount?: number;
    snapshot?: DeckSnapshot;
  };
  remaining: CardInstance[];
  used: CardInstance[];
  skipped: CardInstance[];
  hands: Record<string, CardInstance[]>;
  initialHandSizes: Record<string, number>;
  pendingHandSizes: Record<string, number>;
  events: RoomCardEvent[];
};

export type RoomCardProjection = {
  kind: "card.drawn" | "card.played" | "card.skipped" | "card.hand_size_changed" | "card.round_redealt";
  payload: JsonObject;
  cards: RoomCardState;
};

export type RoomCardCommandError = "invalid_command" | "not_found";

const MAX_HAND_SIZE = 10;

function makeId(prefix: string, now: number) {
  return `${prefix}-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

function takeRandom(source: CardInstance[], count: number, randomIndex = secureRandomIndex) {
  const remaining = [...source];
  const drawn: CardInstance[] = [];
  for (let index = 0; index < count; index += 1) {
    const selected = randomIndex(remaining.length);
    drawn.push(remaining[selected]);
    remaining[selected] = remaining[remaining.length - 1];
    remaining.pop();
  }
  return { remaining, drawn };
}

function int(value: JsonValue | undefined, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 128) : undefined;
}

function eventPayload(event: RoomCardEvent): JsonObject {
  return {
    playerId: event.playerId,
    occurredAt: event.occurredAt,
    ...(event.size !== undefined ? { size: event.size } : {}),
    ...(event.card ? { card: {
      instanceId: event.card.instanceId,
      definitionId: event.card.definitionId,
      displayNumber: event.card.displayNumber,
      title: event.card.title,
      effect: event.card.effect,
      ...(event.card.safetyNote ? { safetyNote: event.card.safetyNote } : {}),
    } } : {}),
  };
}

export function initRoomCards(input: {
  deckId?: OfficialDeckId;
  deckSnapshot?: DeckSnapshot;
  playerIds: string[];
  handSizes: number[];
  randomIndex?: typeof secureRandomIndex;
  game?: SupportedGame;
}): RoomCardState {
  const officialDeck = getOfficialDeck(input.deckId);
  const game = input.game ?? "chinese_eight";
  const parsedSnapshot = input.deckSnapshot ? parseDeckSnapshot(input.deckSnapshot) : undefined;
  if (input.deckSnapshot && !parsedSnapshot) throw new Error("牌组快照无效");
  const complete = officialDeckSnapshot(officialDeck.name);
  const sourceSnapshot = parsedSnapshot ?? { ...complete, cards: complete.cards.filter((card) => officialDeck.definitionIds.includes(card.definitionId)) };
  const filtered = filterDeckSnapshotForGame(sourceSnapshot, game);
  let remaining = deckSnapshotInstances(filtered.snapshot);
  const requestedTotal = input.playerIds.reduce((sum, _, index) => sum + Math.max(0, Math.min(MAX_HAND_SIZE, Math.trunc(input.handSizes[index] ?? input.handSizes[0] ?? 0))), 0);
  if (game === "snooker" && requestedTotal > remaining.length) throw new Error("斯诺克兼容牌不足以发放初始手牌");
  const cardCount = remaining.length;
  const hands: Record<string, CardInstance[]> = {};
  const initialHandSizes: Record<string, number> = {};
  input.playerIds.forEach((playerId, index) => {
    const requested = Math.max(0, Math.min(MAX_HAND_SIZE, Math.trunc(input.handSizes[index] ?? input.handSizes[0] ?? 0)));
    const dealt = takeRandom(remaining, Math.min(requested, remaining.length), input.randomIndex);
    remaining = dealt.remaining;
    hands[playerId] = dealt.drawn;
    initialHandSizes[playerId] = dealt.drawn.length;
  });
  return {
    mode: "independent",
    deckId: parsedSnapshot ? "user" : officialDeck.id,
    deckSnapshot: {
      id: parsedSnapshot ? "user" : officialDeck.id,
      version: parsedSnapshot?.formatVersion ?? officialDeck.version,
      name: parsedSnapshot?.name ?? officialDeck.name,
      definitionIds: Array.from(new Set(remaining.map((card) => card.definitionId))),
      cardCount,
      source: parsedSnapshot ? "user" : "official",
      game,
      originalCardCount: filtered.originalCount,
      excludedForGameCount: filtered.excludedCount,
      snapshot: filtered.snapshot,
    },
    remaining,
    used: [],
    skipped: [],
    hands,
    initialHandSizes,
    pendingHandSizes: { ...initialHandSizes },
    events: [],
  };
}

export function redealRoomCards(cards: RoomCardState, now = Date.now(), randomIndex = secureRandomIndex): RoomCardState {
  let remaining = [...cards.remaining, ...cards.used, ...cards.skipped, ...Object.values(cards.hands).flat()];
  const hands: Record<string, CardInstance[]> = {};
  const initialHandSizes: Record<string, number> = {};
  for (const playerId of Object.keys(cards.hands)) {
    const requested = Math.max(0, Math.min(MAX_HAND_SIZE, cards.pendingHandSizes[playerId] ?? cards.initialHandSizes[playerId] ?? 0));
    const dealt = takeRandom(remaining, Math.min(requested, remaining.length), randomIndex);
    remaining = dealt.remaining;
    hands[playerId] = dealt.drawn;
    initialHandSizes[playerId] = dealt.drawn.length;
  }
  const event: RoomCardEvent = { id: makeId("card", now), type: "redeal", playerId: "all", occurredAt: now };
  return { ...cards, remaining, hands, used: [], skipped: [], initialHandSizes, pendingHandSizes: { ...initialHandSizes }, events: [event, ...cards.events] };
}

export function projectRoomCardCommand(
  cards: RoomCardState | undefined,
  command: { kind: string; payload: JsonObject; now: number },
): RoomCardProjection | RoomCardCommandError {
  if (!cards) return "not_found";
  const playerId = text(command.payload.playerId);

  if (command.kind === "card.draw") {
    if (!playerId || !cards.hands[playerId]) return "not_found";
    const count = Math.min(int(command.payload.count, 1, 1, MAX_HAND_SIZE), cards.remaining.length);
    if (!count) return "invalid_command";
    const dealt = takeRandom(cards.remaining, count);
    const event: RoomCardEvent = { id: makeId("card", command.now), type: "draw", playerId, occurredAt: command.now };
    return {
      kind: "card.drawn",
      payload: { ...eventPayload(event), count },
      cards: { ...cards, remaining: dealt.remaining, hands: { ...cards.hands, [playerId]: [...dealt.drawn, ...cards.hands[playerId]] }, events: [event, ...cards.events] },
    };
  }

  if (command.kind === "card.play" || command.kind === "card.skip") {
    const instanceId = text(command.payload.instanceId);
    const card = playerId && instanceId ? cards.hands[playerId]?.find((item) => item.instanceId === instanceId) : undefined;
    if (!playerId || !instanceId || !card) return "not_found";
    const base = {
      ...cards,
      hands: { ...cards.hands, [playerId]: cards.hands[playerId].filter((item) => item.instanceId !== instanceId) },
    };
    if (command.kind === "card.play") {
      const event: RoomCardEvent = { id: makeId("card", command.now), type: "play", playerId, card, occurredAt: command.now };
      return { kind: "card.played", payload: eventPayload(event), cards: { ...base, used: [card, ...cards.used], events: [event, ...cards.events] } };
    }
    const event: RoomCardEvent = { id: makeId("card", command.now), type: "skip", playerId, card, occurredAt: command.now };
    const skipped = { ...base, skipped: [card, ...cards.skipped], events: [event, ...cards.events] };
    if (!skipped.remaining.length) return { kind: "card.skipped", payload: eventPayload(event), cards: skipped };
    const dealt = takeRandom(skipped.remaining, 1);
    return {
      kind: "card.skipped",
      payload: eventPayload(event),
      cards: { ...skipped, remaining: dealt.remaining, hands: { ...skipped.hands, [playerId]: [...dealt.drawn, ...skipped.hands[playerId]] } },
    };
  }

  if (command.kind === "card.hand_size.set") {
    const size = int(command.payload.size, -1, 0, MAX_HAND_SIZE);
    if (!playerId || !cards.hands[playerId]) return "not_found";
    if (size < 0) return "invalid_command";
    const event: RoomCardEvent = { id: makeId("card", command.now), type: "hand_size", playerId, size, occurredAt: command.now };
    return {
      kind: "card.hand_size_changed",
      payload: eventPayload(event),
      cards: { ...cards, pendingHandSizes: { ...cards.pendingHandSizes, [playerId]: size }, events: [event, ...cards.events] },
    };
  }

  if (command.kind === "card.round.start") {
    const next = redealRoomCards(cards, command.now);
    return { kind: "card.round_redealt", payload: { occurredAt: command.now }, cards: next };
  }

  return "invalid_command";
}
