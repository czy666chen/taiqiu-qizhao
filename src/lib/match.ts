import { CardInstance, createDeck, secureRandomIndex } from "./deck";
import { getOfficialDeck, OfficialDeckId } from "./official-decks";
import { CARD_DEFINITIONS, CardCategory, CardSafetyLevel, getCardCategory, getCardSafetyLevel } from "../data/cards";
import { deckSnapshotInstances, type DeckSnapshot, type DeckSnapshotCard } from "./custom-decks";

export type MatchMode = "cards" | "score" | "score_cards";
export type CardMode = "none" | "shared" | "independent";
export type ScoreRuleKind = "gain" | "penalty";
export type TurnStrategy = "fixed" | "winner_stays";
export type AutoDrawPolicy = "manual" | "game" | "round" | "after_play";
export type DeckExhaustionPolicy = "stop" | "reshuffle";

export interface MatchCardFilter {
  excludedCategories: CardCategory[];
  maxSafetyLevel: CardSafetyLevel;
  excludedKeywords: string[];
}

export interface MatchPlayer {
  id: string;
  name: string;
  kind: "guest" | "registered-placeholder";
  initialScore: number;
  score: number;
  active: boolean;
  joinedAt?: number;
  leftAt?: number;
}

export type PlayerAvatarColor = "gold" | "cyan" | "violet" | "mint" | "red";

const PLAYER_AVATAR_COLORS: PlayerAvatarColor[] = ["gold", "cyan", "violet", "mint", "red"];

export function getPlayerAvatarColor(playerId: string): PlayerAvatarColor {
  let hash = 2166136261;
  for (let index = 0; index < playerId.length; index += 1) {
    hash ^= playerId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return PLAYER_AVATAR_COLORS[(hash >>> 0) % PLAYER_AVATAR_COLORS.length];
}

export interface ScoreRule {
  id: string;
  label: string;
  value: number;
  kind: ScoreRuleKind;
  enabled: boolean;
  color: string;
  description?: string;
  custom?: boolean;
}

export interface ScoreEvent {
  id: string;
  type: "score" | "transfer" | "correction";
  label: string;
  playerId: string;
  changes: Record<string, number>;
  previousCurrentPlayerId: string;
  occurredAt: number;
  note?: string;
  correctsEventId?: string;
  linkedCardEventId?: string;
}

export interface CardEvent {
  id: string;
  type: "draw" | "play" | "skip" | "reshuffle";
  label: string;
  handId: string;
  card?: CardInstance;
  occurredAt: number;
  actionId?: string;
  relatedScoreEventId?: string;
  reshuffledUsed?: CardInstance[];
  reshuffledSkipped?: CardInstance[];
}

export interface MatchCardState {
  mode: Exclude<CardMode, "none">;
  remaining: CardInstance[];
  hands: Record<string, CardInstance[]>;
  used: CardInstance[];
  skipped: CardInstance[];
  events: CardEvent[];
  initialHandSize: number;
  initialHandSizes?: Record<string, number>;
  autoDrawPolicy?: AutoDrawPolicy;
  handLimit?: number;
  exhaustionPolicy?: DeckExhaustionPolicy;
  filter?: MatchCardFilter;
  deckSnapshot: {
    id: string;
    version: number;
    name: string;
    definitionIds: string[];
    cardCount: number;
    source?: "official" | "user";
    filter?: MatchCardFilter;
  };
}

export interface BilliardsMatch {
  version: 1;
  id: string;
  mode: MatchMode;
  status: "active" | "completed";
  createdAt: number;
  startedAt: number;
  endedAt?: number;
  players: MatchPlayer[];
  currentPlayerId: string;
  rules: ScoreRule[];
  scoreEvents: ScoreEvent[];
  cards?: MatchCardState;
  turnStrategy?: TurnStrategy;
  cardAutoDrawPolicy?: AutoDrawPolicy;
  cardHandLimit?: number;
  cardExhaustionPolicy?: DeckExhaustionPolicy;
  cardFilter?: Partial<MatchCardFilter>;
}

export interface MatchDraft {
  mode: MatchMode;
  playerNames: string[];
  initialScore: number;
  rules: ScoreRule[];
  cardMode: CardMode;
  initialHandSize: number;
  initialHandSizes?: number[];
  deckId?: OfficialDeckId;
  deckSnapshot?: DeckSnapshot;
  playerInitialScores?: number[];
  turnStrategy?: TurnStrategy;
  cardAutoDrawPolicy?: AutoDrawPolicy;
  cardHandLimit?: number;
  cardExhaustionPolicy?: DeckExhaustionPolicy;
  cardFilter?: Partial<MatchCardFilter>;
}

export const DEFAULT_RULES: ScoreRule[] = [
  { id: "foul", label: "犯规", value: 1, kind: "penalty", enabled: true, color: "red" },
  { id: "normal-win", label: "普胜", value: 4, kind: "gain", enabled: true, color: "mint" },
  { id: "small-gold", label: "小金", value: 7, kind: "gain", enabled: true, color: "cyan" },
  { id: "big-gold", label: "大金", value: 10, kind: "gain", enabled: true, color: "gold" },
];

const makeId = (prefix: string, now = Date.now()) =>
  `${prefix}-${now}-${Math.random().toString(36).slice(2, 8)}`;

function takeRandom(source: CardInstance[], count: number, randomIndex = secureRandomIndex) {
  if (!Number.isInteger(count) || count < 0 || count > source.length) {
    throw new Error("抽卡数量超出剩余卡牌范围");
  }
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

export const DEFAULT_CARD_FILTER: MatchCardFilter = {
  excludedCategories: [],
  maxSafetyLevel: "review",
  excludedKeywords: [],
};

function normalizeCardFilter(filter?: Partial<MatchCardFilter>): MatchCardFilter {
  const categories: CardCategory[] = ["strategy", "social", "physical", "chaos"];
  const safetyLevels: CardSafetyLevel[] = ["low", "medium", "review"];
  return {
    excludedCategories: Array.from(new Set((filter?.excludedCategories ?? []).filter((item): item is CardCategory => categories.includes(item)))),
    maxSafetyLevel: safetyLevels.includes(filter?.maxSafetyLevel as CardSafetyLevel) ? filter!.maxSafetyLevel! : "review",
    excludedKeywords: Array.from(new Set((filter?.excludedKeywords ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean))),
  };
}

function cardAllowed(definitionId: string, filter: MatchCardFilter): boolean {
  const definition = CARD_DEFINITIONS.find((card) => card.id === definitionId);
  if (!definition || filter.excludedCategories.includes(getCardCategory(definition))) return false;
  const allowedSafety = filter.maxSafetyLevel === "review" ? ["low", "medium", "review"] : filter.maxSafetyLevel === "medium" ? ["low", "medium"] : ["low"];
  if (!allowedSafety.includes(getCardSafetyLevel(definition))) return false;
  const searchable = `${definition.title}${definition.effect}${definition.safetyNote ?? ""}`.toLowerCase();
  return !filter.excludedKeywords.some((keyword) => searchable.includes(keyword));
}

function snapshotCardAllowed(card: DeckSnapshotCard, filter: MatchCardFilter): boolean {
  if (card.source === "official") return cardAllowed(card.definitionId, filter);
  const allowedSafety = filter.maxSafetyLevel === "review" ? ["low", "medium", "review"] : filter.maxSafetyLevel === "medium" ? ["low", "medium"] : ["low"];
  if (!allowedSafety.includes(card.snapshot.safetyLevel)) return false;
  const searchable = `${card.snapshot.title}${card.snapshot.effect}${card.snapshot.safetyNote ?? ""}`.toLowerCase();
  return !filter.excludedKeywords.some((keyword) => searchable.includes(keyword));
}

export interface MatchCardStateDraft {
  cardMode: Exclude<CardMode, "none">;
  handIds: string[];
  initialHandSize: number;
  initialHandSizes?: number[];
  deckId?: OfficialDeckId;
  deckSnapshot?: DeckSnapshot;
  cardAutoDrawPolicy?: AutoDrawPolicy;
  cardHandLimit?: number;
  cardExhaustionPolicy?: DeckExhaustionPolicy;
  cardFilter?: Partial<MatchCardFilter>;
}

export function createMatchCardState(draft: MatchCardStateDraft, randomIndex = secureRandomIndex): MatchCardState {
  const officialDeck = getOfficialDeck(draft.deckId);
  const filter = normalizeCardFilter(draft.cardFilter);
  const handIds = draft.cardMode === "shared" ? ["shared"] : draft.handIds;
  let remaining = draft.deckSnapshot
    ? deckSnapshotInstances({ ...draft.deckSnapshot, cards: draft.deckSnapshot.cards.filter((card) => snapshotCardAllowed(card, filter)) })
    : createDeck().filter((card) => officialDeck.definitionIds.includes(card.definitionId) && cardAllowed(card.definitionId, filter));
  const hands: Record<string, CardInstance[]> = {};
  const perHandMax = draft.cardMode === "shared" ? remaining.length : Math.floor(remaining.length / Math.max(1, handIds.length));
  const uniformSize = Math.max(0, Math.trunc(draft.initialHandSize));
  for (const [index, handId] of handIds.entries()) {
    const requested = draft.cardMode === "independent" && Number.isFinite(draft.initialHandSizes?.[index])
      ? Math.max(0, Math.trunc(draft.initialHandSizes![index]))
      : uniformSize;
    const size = Math.min(requested, perHandMax, remaining.length);
    const dealt = takeRandom(remaining, size, randomIndex);
    remaining = dealt.remaining;
    hands[handId] = dealt.drawn;
  }
  const initialHandSize = Math.max(0, ...Object.values(hands).map((hand) => hand.length));
  const handLimit = Math.max(initialHandSize, Math.min(20, Math.max(1, Math.trunc(draft.cardHandLimit ?? Math.max(initialHandSize, 5)))));
  const initialHandSizes = Object.fromEntries(Object.entries(hands).map(([handId, hand]) => [handId, hand.length]));
  return {
    mode: draft.cardMode,
    remaining,
    hands,
    used: [],
    skipped: [],
    events: [],
    initialHandSize,
    initialHandSizes,
    autoDrawPolicy: draft.cardAutoDrawPolicy ?? "manual",
    handLimit,
    exhaustionPolicy: draft.cardExhaustionPolicy ?? "stop",
    filter,
    deckSnapshot: {
      id: draft.deckSnapshot ? "user" : officialDeck.id,
      version: draft.deckSnapshot?.formatVersion ?? officialDeck.version,
      name: draft.deckSnapshot?.name ?? officialDeck.name,
      source: draft.deckSnapshot ? "user" : "official",
      definitionIds: Array.from(new Set(remaining.concat(...Object.values(hands)).map((card) => card.definitionId))),
      cardCount: remaining.length + Object.values(hands).reduce((sum, hand) => sum + hand.length, 0),
      filter: { ...filter, excludedCategories: [...filter.excludedCategories], excludedKeywords: [...filter.excludedKeywords] },
    },
  };
}

export function redealMatchCardState(cards: MatchCardState, now = Date.now(), randomIndex = secureRandomIndex): MatchCardState {
  const handIds = Object.keys(cards.hands);
  let remaining = [...cards.remaining, ...cards.used, ...cards.skipped, ...Object.values(cards.hands).flat()];
  const hands: Record<string, CardInstance[]> = {};
  for (const handId of handIds) {
    const size = cards.initialHandSizes?.[handId] ?? cards.initialHandSize;
    const dealt = takeRandom(remaining, Math.min(size, remaining.length), randomIndex);
    remaining = dealt.remaining;
    hands[handId] = dealt.drawn;
  }
  return {
    ...cards,
    remaining,
    hands,
    used: [],
    skipped: [],
    events: [{ id: makeId("card", now), type: "reshuffle", label: "下一局重新发牌", handId: "all", occurredAt: now }, ...cards.events],
  };
}

export function createMatch(draft: MatchDraft, now = Date.now(), randomIndex = secureRandomIndex): BilliardsMatch {
  const names = draft.playerNames.map((name) => name.trim()).filter(Boolean).slice(0, 8);
  if (names.length < 2) throw new Error("至少需要 2 名玩家");
  const players = names.map((name, index) => ({
    id: `player-${now}-${index + 1}`,
    name,
    kind: "guest" as const,
    initialScore: Number.isFinite(draft.playerInitialScores?.[index]) ? Math.trunc(draft.playerInitialScores![index]) : Math.trunc(draft.initialScore),
    score: Number.isFinite(draft.playerInitialScores?.[index]) ? Math.trunc(draft.playerInitialScores![index]) : Math.trunc(draft.initialScore),
    active: true,
    joinedAt: now,
  }));
  const mode = draft.mode;
  let cards: MatchCardState | undefined;
  if (draft.cardMode !== "none") {
    cards = createMatchCardState({
      cardMode: draft.cardMode,
      handIds: players.map((player) => player.id),
      initialHandSize: draft.initialHandSize,
      initialHandSizes: draft.initialHandSizes,
      deckId: draft.deckId,
      deckSnapshot: draft.deckSnapshot,
      cardAutoDrawPolicy: draft.cardAutoDrawPolicy,
      cardHandLimit: draft.cardHandLimit,
      cardExhaustionPolicy: draft.cardExhaustionPolicy,
      cardFilter: draft.cardFilter,
    }, randomIndex);
  }
  return {
    version: 1,
    id: makeId("match", now),
    mode,
    status: "active",
    createdAt: now,
    startedAt: now,
    players,
    currentPlayerId: players[0].id,
    rules: draft.rules.map((rule) => ({ ...rule, value: Math.abs(Math.trunc(rule.value)) })),
    scoreEvents: [],
    turnStrategy: draft.turnStrategy ?? "fixed",
    ...(cards ? { cards } : {}),
  };
}

export function nextPlayerId(match: BilliardsMatch, fromId = match.currentPlayerId): string {
  const active = match.players.filter((player) => player.active);
  if (!active.length) return fromId;
  const index = active.findIndex((player) => player.id === fromId);
  return active[(index + 1 + active.length) % active.length].id;
}

export function applyScore(match: BilliardsMatch, ruleId: string, playerId: string, now = Date.now(), note = ""): BilliardsMatch {
  const rule = match.rules.find((item) => item.id === ruleId && item.enabled);
  const player = match.players.find((item) => item.id === playerId && item.active);
  if (!rule || !player || match.status !== "active") return match;
  const delta = rule.kind === "penalty" ? -Math.abs(rule.value) : Math.abs(rule.value);
  const event: ScoreEvent = {
    id: makeId("score", now),
    type: "score",
    label: rule.label,
    playerId,
    changes: { [playerId]: delta },
    previousCurrentPlayerId: match.currentPlayerId,
    occurredAt: now,
    ...(note.trim() ? { note: note.trim() } : {}),
  };
  return {
    ...match,
    players: match.players.map((item) => item.id === playerId ? { ...item, score: item.score + delta } : item),
    currentPlayerId: (match.turnStrategy ?? "fixed") === "winner_stays" && delta > 0 ? playerId : nextPlayerId(match),
    scoreEvents: [event, ...match.scoreEvents],
  };
}

export function backfillScoreEvent(match: BilliardsMatch, playerId: string, delta: number, label: string, note = "", occurredAt = Date.now()): BilliardsMatch {
  const player = match.players.find((item) => item.id === playerId);
  const value = Math.trunc(delta);
  const cleanLabel = label.trim();
  if (match.status !== "active" || !player || !value || !cleanLabel) return match;
  const event: ScoreEvent = {
    id: makeId("backfill", occurredAt),
    type: "score",
    label: `补录 · ${cleanLabel}`,
    playerId,
    changes: { [playerId]: value },
    previousCurrentPlayerId: match.currentPlayerId,
    occurredAt,
    note: note.trim() || "赛后补录",
  };
  return {
    ...match,
    players: match.players.map((item) => item.id === playerId ? { ...item, score: item.score + value } : item),
    scoreEvents: [event, ...match.scoreEvents],
  };
}

export function applyTransferScore(match: BilliardsMatch, winnerId: string, loserIds: string[], amount: number, note = "", now = Date.now()): BilliardsMatch {
  const winner = match.players.find((player) => player.id === winnerId && player.active);
  const uniqueLosers = Array.from(new Set(loserIds)).filter((id) => id !== winnerId);
  const losers = uniqueLosers.map((id) => match.players.find((player) => player.id === id && player.active)).filter((player): player is MatchPlayer => !!player);
  const value = Math.abs(Math.trunc(amount));
  if (match.status !== "active" || !winner || !value || losers.length !== uniqueLosers.length || !losers.length) return match;
  const changes: Record<string, number> = { [winnerId]: value * losers.length };
  losers.forEach((loser) => { changes[loser.id] = -value; });
  const event: ScoreEvent = {
    id: makeId("transfer", now),
    type: "transfer",
    label: `转账 · 每人 ${value} 分`,
    playerId: winnerId,
    changes,
    previousCurrentPlayerId: match.currentPlayerId,
    occurredAt: now,
    ...(note.trim() ? { note: note.trim() } : {}),
  };
  return {
    ...match,
    players: match.players.map((player) => ({ ...player, score: player.score + (changes[player.id] ?? 0) })),
    currentPlayerId: (match.turnStrategy ?? "fixed") === "winner_stays" ? winnerId : nextPlayerId(match),
    scoreEvents: [event, ...match.scoreEvents],
  };
}

export function applyBlackGoldScore(match: BilliardsMatch, winnerId: string, baseAmount: number, note = "", now = Date.now()): BilliardsMatch {
  const loserIds = match.players.filter((player) => player.active && player.id !== winnerId).map((player) => player.id);
  const amount = Math.abs(Math.trunc(baseAmount)) * 2;
  const updated = applyTransferScore(match, winnerId, loserIds, amount, note, now);
  if (updated === match) return match;
  const [event, ...events] = updated.scoreEvents;
  return { ...updated, scoreEvents: [{ ...event, label: `黑金 · 每家 ${amount} 分` }, ...events] };
}

export function applyHandicapScore(match: BilliardsMatch, beneficiaryId: string, grantorId: string, amount: number, note = "", now = Date.now()): BilliardsMatch {
  const value = Math.abs(Math.trunc(amount));
  const updated = applyTransferScore(match, beneficiaryId, [grantorId], value, note, now);
  if (updated === match) return match;
  const [event, ...events] = updated.scoreEvents;
  return { ...updated, scoreEvents: [{ ...event, label: `让杆 · ${value} 分` }, ...events] };
}

export function correctScoreEvent(match: BilliardsMatch, eventId: string, note: string, now = Date.now(), allowCompleted = false): BilliardsMatch {
  const original = match.scoreEvents.find((event) => event.id === eventId && event.type !== "correction");
  if (!original || (match.status !== "active" && !allowCompleted) || match.scoreEvents.some((event) => event.correctsEventId === eventId)) return match;
  const changes = Object.fromEntries(Object.entries(original.changes).map(([playerId, value]) => [playerId, -value]));
  const correction: ScoreEvent = { id: makeId("correction", now), type: "correction", label: `更正 · ${original.label}`, playerId: original.playerId, changes, previousCurrentPlayerId: match.currentPlayerId, occurredAt: now, correctsEventId: original.id, note: note.trim() || "撤销错误事件" };
  return { ...match, players: match.players.map((player) => ({ ...player, score: player.score + (changes[player.id] ?? 0) })), scoreEvents: [correction, ...match.scoreEvents] };
}

export function undoLastScore(match: BilliardsMatch): BilliardsMatch {
  const [event, ...scoreEvents] = match.scoreEvents;
  if (!event || match.status !== "active") return match;
  return {
    ...match,
    players: match.players.map((player) => ({
      ...player,
      score: player.score - (event.changes[player.id] ?? 0),
    })),
    currentPlayerId: event.previousCurrentPlayerId,
    scoreEvents,
  };
}

export function reorderPlayers(match: BilliardsMatch, playerIds: string[]): BilliardsMatch {
  const positions = new Map(playerIds.map((id, index) => [id, index]));
  return { ...match, players: [...match.players].sort((a, b) => (positions.get(a.id) ?? 999) - (positions.get(b.id) ?? 999)) };
}

export function setCurrentPlayer(match: BilliardsMatch, playerId: string): BilliardsMatch {
  if (match.status !== "active" || !match.players.some((player) => player.id === playerId && player.active)) return match;
  return { ...match, currentPlayerId: playerId };
}

export function hasPlayerActivity(match: BilliardsMatch, playerId: string): boolean {
  return match.scoreEvents.some((event) => event.playerId === playerId || Object.hasOwn(event.changes, playerId))
    || !!match.cards?.events.some((event) => event.handId === playerId);
}

export function addMatchPlayer(match: BilliardsMatch, name: string, initialScore = 0, now = Date.now()): BilliardsMatch {
  const normalizedName = name.trim();
  if (match.status !== "active" || !normalizedName || match.players.filter((player) => player.active).length >= 8) return match;
  const id = `player-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const score = Number.isFinite(initialScore) ? Math.trunc(initialScore) : 0;
  const player: MatchPlayer = { id, name: normalizedName, kind: "guest", initialScore: score, score, active: true, joinedAt: now };
  return {
    ...match,
    players: [...match.players, player],
    ...(match.cards?.mode === "independent" ? { cards: { ...match.cards, hands: { ...match.cards.hands, [id]: [] } } } : {}),
  };
}

export function leaveMatchPlayer(match: BilliardsMatch, playerId: string, now = Date.now()): BilliardsMatch {
  const player = match.players.find((item) => item.id === playerId && item.active);
  if (match.status !== "active" || !player || match.players.filter((item) => item.active).length <= 2) return match;
  const nextId = nextPlayerId(match, playerId);
  const updated = { ...match, players: match.players.map((item) => item.id === playerId ? { ...item, active: false, leftAt: now } : item) };
  return { ...updated, currentPlayerId: match.currentPlayerId === playerId ? nextId : match.currentPlayerId };
}

export function deleteMatchPlayer(match: BilliardsMatch, playerId: string): BilliardsMatch {
  const player = match.players.find((item) => item.id === playerId && item.active);
  if (match.status !== "active" || !player || match.players.filter((item) => item.active).length <= 2 || hasPlayerActivity(match, playerId)) return match;
  const nextId = nextPlayerId(match, playerId);
  const players = match.players.filter((item) => item.id !== playerId);
  const returnedCards = match.cards?.mode === "independent" ? (match.cards.hands[playerId] ?? []) : [];
  const hands = match.cards?.mode === "independent"
    ? Object.fromEntries(Object.entries(match.cards.hands).filter(([handId]) => handId !== playerId))
    : match.cards?.hands;
  return {
    ...match,
    players,
    currentPlayerId: match.currentPlayerId === playerId ? nextId : match.currentPlayerId,
    ...(match.cards && hands ? { cards: { ...match.cards, hands, remaining: [...returnedCards, ...match.cards.remaining] } } : {}),
  };
}

export function finishMatch(match: BilliardsMatch, now = Date.now()): BilliardsMatch {
  if (match.status === "completed") return match;
  return { ...match, status: "completed", endedAt: now };
}

export interface DrawMatchCardOptions {
  allowReshuffle?: boolean;
  actionId?: string;
  labelPrefix?: string;
}

export interface LinkedCardScore {
  playerId: string;
  delta: number;
  note?: string;
}

const cardHandLimit = (cards: MatchCardState) => Math.max(cards.initialHandSize, cards.handLimit ?? Math.max(cards.initialHandSize, 5));

export function updateMatchCardSettings(match: BilliardsMatch, settings: { autoDrawPolicy?: AutoDrawPolicy; handLimit?: number; exhaustionPolicy?: DeckExhaustionPolicy }): BilliardsMatch {
  if (!match.cards || match.status !== "active") return match;
  return {
    ...match,
    cards: {
      ...match.cards,
      autoDrawPolicy: settings.autoDrawPolicy ?? match.cards.autoDrawPolicy ?? "manual",
      handLimit: Math.max(match.cards.initialHandSize, Math.min(20, Math.max(1, Math.trunc(settings.handLimit ?? cardHandLimit(match.cards))))),
      exhaustionPolicy: settings.exhaustionPolicy ?? match.cards.exhaustionPolicy ?? "stop",
    },
  };
}

export function drawMatchCards(match: BilliardsMatch, handId: string, count = 1, now = Date.now(), randomIndex = secureRandomIndex, options: DrawMatchCardOptions = {}): BilliardsMatch {
  if (!match.cards || !match.cards.hands[handId] || match.status !== "active") return match;
  const capacity = Math.max(0, cardHandLimit(match.cards) - match.cards.hands[handId].length);
  const requested = Math.min(Math.max(0, Math.trunc(count)), capacity);
  if (!requested) return match;
  const actionId = options.actionId ?? makeId("card-action", now);
  let cards = match.cards;
  const extraEvents: CardEvent[] = [];
  if (cards.remaining.length < requested && cards.exhaustionPolicy === "reshuffle" && options.allowReshuffle && (cards.used.length || cards.skipped.length)) {
    const reshuffledUsed = [...cards.used];
    const reshuffledSkipped = [...cards.skipped];
    cards = { ...cards, remaining: [...cards.remaining, ...reshuffledUsed, ...reshuffledSkipped], used: [], skipped: [] };
    extraEvents.push({ id: makeId("card", now), type: "reshuffle", label: `重洗 ${reshuffledUsed.length + reshuffledSkipped.length} 张弃牌`, handId, occurredAt: now, actionId, reshuffledUsed, reshuffledSkipped });
  }
  const drawCount = Math.min(requested, cards.remaining.length);
  if (!drawCount) return match;
  const dealt = takeRandom(cards.remaining, drawCount, randomIndex);
  const drawEvents = dealt.drawn.map((card, index): CardEvent => ({
    id: makeId("card", now + index + 1), type: "draw", label: `${options.labelPrefix ?? "手动抽牌"}「${card.title}」`, handId, card, occurredAt: now + index + 1, actionId,
  })).reverse();
  return {
    ...match,
    cards: {
      ...cards,
      remaining: dealt.remaining,
      hands: { ...cards.hands, [handId]: [...dealt.drawn, ...cards.hands[handId]] },
      events: [...drawEvents, ...extraEvents, ...cards.events],
    },
  };
}

export function triggerMatchCardRefill(match: BilliardsMatch, trigger: "game" | "round", now = Date.now(), randomIndex = secureRandomIndex, allowReshuffle = false): BilliardsMatch {
  if (!match.cards || match.cards.autoDrawPolicy !== trigger || match.status !== "active") return match;
  let updated = match;
  const handIds = Object.keys(match.cards.hands);
  handIds.forEach((handId, index) => {
    const cards = updated.cards!;
    const needed = Math.max(0, cardHandLimit(cards) - cards.hands[handId].length);
    updated = drawMatchCards(updated, handId, needed, now + index * 100, randomIndex, { allowReshuffle, labelPrefix: trigger === "game" ? "小局补牌" : "轮次补牌" });
  });
  return updated;
}

export function playMatchCard(match: BilliardsMatch, handId: string, instanceId: string, now = Date.now(), linkedScore?: LinkedCardScore, randomIndex = secureRandomIndex, allowReshuffle = false): BilliardsMatch {
  const card = match.cards?.hands[handId]?.find((item) => item.instanceId === instanceId);
  if (!match.cards || !card || match.status !== "active") return match;
  const actionId = makeId("card-action", now);
  const cardEventId = makeId("card", now);
  const linkedPlayer = linkedScore && match.players.find((player) => player.id === linkedScore.playerId);
  const delta = linkedPlayer ? Math.trunc(linkedScore!.delta) : 0;
  const scoreEvent = linkedPlayer && delta ? {
    id: makeId("card-score", now), type: "score" as const, label: `卡牌 · ${card.title}`, playerId: linkedPlayer.id,
    changes: { [linkedPlayer.id]: delta }, previousCurrentPlayerId: match.currentPlayerId, occurredAt: now + 1,
    note: linkedScore?.note?.trim() || "卡牌效果计分", linkedCardEventId: cardEventId,
  } : undefined;
  const cardEvent: CardEvent = { id: cardEventId, type: "play", label: `使用「${card.title}」`, handId, card, occurredAt: now, actionId, ...(scoreEvent ? { relatedScoreEventId: scoreEvent.id } : {}) };
  let updated: BilliardsMatch = {
    ...match,
    players: scoreEvent ? match.players.map((player) => player.id === linkedPlayer!.id ? { ...player, score: player.score + delta } : player) : match.players,
    scoreEvents: scoreEvent ? [scoreEvent, ...match.scoreEvents] : match.scoreEvents,
    cards: {
      ...match.cards,
      hands: { ...match.cards.hands, [handId]: match.cards.hands[handId].filter((item) => item.instanceId !== instanceId) },
      used: [card, ...match.cards.used],
      events: [cardEvent, ...match.cards.events],
    },
  };
  if (updated.cards?.autoDrawPolicy === "after_play") updated = drawMatchCards(updated, handId, 1, now + 2, randomIndex, { allowReshuffle, actionId, labelPrefix: "用牌补牌" });
  return updated;
}

export function skipMatchCard(match: BilliardsMatch, handId: string, instanceId: string, now = Date.now(), randomIndex = secureRandomIndex, allowReshuffle = false): BilliardsMatch {
  const card = match.cards?.hands[handId]?.find((item) => item.instanceId === instanceId);
  if (!match.cards || !card || match.status !== "active") return match;
  const actionId = makeId("card-action", now);
  const base: BilliardsMatch = {
    ...match,
    cards: {
      ...match.cards,
      hands: { ...match.cards.hands, [handId]: match.cards.hands[handId].filter((item) => item.instanceId !== instanceId) },
      skipped: [card, ...match.cards.skipped],
      events: [{ id: makeId("card", now), type: "skip", label: `安全跳过「${card.title}」`, handId, card, occurredAt: now, actionId }, ...match.cards.events],
    },
  };
  return drawMatchCards(base, handId, 1, now + 1, randomIndex, { allowReshuffle, actionId, labelPrefix: "安全补牌" });
}

export function undoCardAction(match: BilliardsMatch, eventId: string): BilliardsMatch {
  if (!match.cards || match.status !== "active") return match;
  const target = match.cards.events.find((event) => event.id === eventId);
  if (!target) return match;
  const actionEvents = match.cards.events.filter((event) => target.actionId ? event.actionId === target.actionId : event.id === eventId);
  let remaining = [...match.cards.remaining];
  const hands = Object.fromEntries(Object.entries(match.cards.hands).map(([id, hand]) => [id, [...hand]]));
  let used = [...match.cards.used];
  let skipped = [...match.cards.skipped];
  actionEvents.forEach((event) => {
    if (event.type === "draw" && event.card) {
      hands[event.handId] = (hands[event.handId] ?? []).filter((card) => card.instanceId !== event.card!.instanceId);
      remaining = [event.card, ...remaining];
    } else if (event.type === "play" && event.card) {
      used = used.filter((card) => card.instanceId !== event.card!.instanceId);
      hands[event.handId] = [event.card, ...(hands[event.handId] ?? [])];
    } else if (event.type === "skip" && event.card) {
      skipped = skipped.filter((card) => card.instanceId !== event.card!.instanceId);
      hands[event.handId] = [event.card, ...(hands[event.handId] ?? [])];
    } else if (event.type === "reshuffle") {
      const recycledIds = new Set([...(event.reshuffledUsed ?? []), ...(event.reshuffledSkipped ?? [])].map((card) => card.instanceId));
      remaining = remaining.filter((card) => !recycledIds.has(card.instanceId));
      used = [...(event.reshuffledUsed ?? []), ...used];
      skipped = [...(event.reshuffledSkipped ?? []), ...skipped];
    }
  });
  const relatedScoreIds = new Set(actionEvents.map((event) => event.relatedScoreEventId).filter((id): id is string => !!id));
  const relatedScores = match.scoreEvents.filter((event) => relatedScoreIds.has(event.id));
  return {
    ...match,
    players: match.players.map((player) => ({ ...player, score: player.score - relatedScores.reduce((sum, event) => sum + (event.changes[player.id] ?? 0), 0) })),
    scoreEvents: match.scoreEvents.filter((event) => !relatedScoreIds.has(event.id)),
    cards: { ...match.cards, remaining, hands, used, skipped, events: match.cards.events.filter((event) => !actionEvents.some((item) => item.id === event.id)) },
  };
}

export function getRankings(match: BilliardsMatch): MatchPlayer[] {
  return [...match.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "zh-CN"));
}

export function isStoredMatch(value: unknown): value is BilliardsMatch {
  if (!value || typeof value !== "object") return false;
  const match = value as Partial<BilliardsMatch>;
  return match.version === 1 && typeof match.id === "string" && Array.isArray(match.players) && Array.isArray(match.rules) && Array.isArray(match.scoreEvents);
}
