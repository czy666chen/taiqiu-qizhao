import { CardMode, createMatchCardState, MatchCardFilter, MatchCardState, redealMatchCardState } from "./match";
import { secureRandomIndex } from "./deck";
import { OfficialDeckId } from "./official-decks";
import type { DeckSnapshot } from "./custom-decks";

export type EightBallLayout = "stacked" | "split";
export type EightBallWinType = "normal" | "break_clear" | "runout";
export type EightBallServeRule = "alternate" | "winner";

export interface EightBallPlayer {
  id: string;
  name: string;
}

export interface EightBallRoundPayload {
  winnerId: string;
  winType: EightBallWinType;
  fouls: Record<string, number>;
  note: string;
  startedAt: number;
  confirmedAt: number;
}

export interface EightBallEvent {
  id: string;
  operationId: string;
  sequenceNo: number;
  matchVersion: number;
  type: "round" | "correction" | "rename" | "pause" | "resume" | "finish";
  occurredAt: number;
  source: "user" | "undo" | "correction";
  playerNames: Record<string, string>;
  round?: EightBallRoundPayload;
  correctsEventId?: string;
  replacement?: EightBallRoundPayload;
  playerId?: string;
  previousName?: string;
  nextName?: string;
}

export interface EightBallMatch {
  schemaVersion: 1;
  id: string;
  matchVersion: number;
  mode: "chinese_eight";
  status: "active" | "completed";
  createdAt: number;
  startedAt: number;
  endedAt?: number;
  pausedAt?: number;
  pausedDurationMs: number;
  players: [EightBallPlayer, EightBallPlayer];
  raceTo: number | null;
  firstServerId: string;
  serveRule: EightBallServeRule;
  layout: EightBallLayout;
  title: string;
  location: string;
  note: string;
  events: EightBallEvent[];
  cards?: MatchCardState;
}

export interface EightBallDraft {
  playerNames: [string, string];
  raceTo: number | null;
  firstServer: 0 | 1;
  serveRule: EightBallServeRule;
  layout: EightBallLayout;
  title?: string;
  location?: string;
  note?: string;
  cardMode?: CardMode;
  initialHandSize?: number;
  initialHandSizes?: [number, number];
  deckId?: OfficialDeckId;
  deckSnapshot?: DeckSnapshot;
  cardFilter?: Partial<MatchCardFilter>;
}

export interface EightBallPlayerStats {
  score: number;
  normal: number;
  breakClear: number;
  runout: number;
  fouls: number;
}

export interface EffectiveEightBallRound extends EightBallRoundPayload {
  eventId: string;
  sequenceNo: number;
  serverId: string;
  before: Record<string, number>;
  after: Record<string, number>;
  originalEvent: EightBallEvent;
}

const makeId = (prefix: string, now: number) => `${prefix}-${now}-${Math.random().toString(36).slice(2, 9)}`;

export function createEightBallMatch(draft: EightBallDraft, now = Date.now(), randomIndex = secureRandomIndex): EightBallMatch {
  const names = draft.playerNames.map((name) => name.trim()) as [string, string];
  if (!names[0] || !names[1]) throw new Error("双方姓名不能为空");
  if (draft.raceTo !== null && (!Number.isInteger(draft.raceTo) || draft.raceTo < 1 || draft.raceTo > 99)) throw new Error("抢局数必须为 1–99");
  const players: [EightBallPlayer, EightBallPlayer] = [
    { id: `match-player-${now}-1`, name: names[0] },
    { id: `match-player-${now}-2`, name: names[1] },
  ];
  const cards = draft.cardMode && draft.cardMode !== "none"
    ? createMatchCardState({
      cardMode: draft.cardMode,
      handIds: players.map((player) => player.id),
      initialHandSize: draft.initialHandSize ?? 0,
      initialHandSizes: draft.initialHandSizes,
      deckId: draft.deckId,
      deckSnapshot: draft.deckSnapshot,
      cardFilter: draft.cardFilter,
    }, randomIndex)
    : undefined;
  return {
    schemaVersion: 1, id: makeId("eight", now), matchVersion: 0, mode: "chinese_eight", status: "active",
    createdAt: now, startedAt: now, pausedDurationMs: 0, players, raceTo: draft.raceTo,
    firstServerId: players[draft.firstServer].id, serveRule: draft.serveRule, layout: draft.layout,
    title: draft.title?.trim() ?? "", location: draft.location?.trim() ?? "", note: draft.note?.trim() ?? "", events: [],
    ...(cards ? { cards } : {}),
  };
}

function appendEvent(match: EightBallMatch, event: Omit<EightBallEvent, "id" | "operationId" | "sequenceNo" | "matchVersion" | "playerNames">, now: number): EightBallMatch {
  const sequenceNo = match.events.length ? Math.max(...match.events.map((item) => item.sequenceNo)) + 1 : 1;
  const version = match.matchVersion + 1;
  const id = makeId("eight-event", now);
  const next: EightBallEvent = {
    ...event, id, operationId: makeId("operation", now), sequenceNo, matchVersion: version,
    playerNames: Object.fromEntries(match.players.map((player) => [player.id, player.name])),
  };
  return { ...match, matchVersion: version, events: [...match.events, next] };
}

function validRound(round: EightBallRoundPayload, match: EightBallMatch) {
  return match.players.some((player) => player.id === round.winnerId)
    && Object.values(round.fouls).every((count) => Number.isInteger(count) && count >= 0);
}

export function recordEightBallRound(match: EightBallMatch, input: Omit<EightBallRoundPayload, "confirmedAt">, now = Date.now()): EightBallMatch {
  const round = { ...input, note: input.note.trim(), confirmedAt: now };
  if (match.status !== "active" || match.pausedAt || !validRound(round, match)) return match;
  const updated = appendEvent(match, { type: "round", occurredAt: now, source: "user", round }, now);
  return updated.cards ? { ...updated, cards: redealMatchCardState(updated.cards, now + 1) } : updated;
}

export function correctEightBallRound(match: EightBallMatch, eventId: string, replacement: EightBallRoundPayload | null, now = Date.now()): EightBallMatch {
  const original = match.events.find((event) => event.id === eventId && event.type === "round");
  if (!original || (replacement && !validRound(replacement, match))) return match;
  return appendEvent(match, {
    type: "correction", occurredAt: now, source: replacement ? "correction" : "undo", correctsEventId: eventId,
    replacement: replacement ? { ...replacement, note: replacement.note.trim(), confirmedAt: now } : undefined,
  }, now);
}

export function undoLastEightBallRound(match: EightBallMatch, now = Date.now()): EightBallMatch {
  const target = getEffectiveEightBallRounds(match).at(-1);
  return target ? correctEightBallRound(match, target.eventId, null, now) : match;
}

export function renameEightBallPlayer(match: EightBallMatch, playerId: string, name: string, now = Date.now()): EightBallMatch {
  const nextName = name.trim();
  const player = match.players.find((item) => item.id === playerId);
  if (!player || !nextName || player.name === nextName) return match;
  const updated = appendEvent(match, { type: "rename", occurredAt: now, source: "user", playerId, previousName: player.name, nextName }, now);
  return { ...updated, players: updated.players.map((item) => item.id === playerId ? { ...item, name: nextName } : item) as [EightBallPlayer, EightBallPlayer] };
}

export function pauseEightBallMatch(match: EightBallMatch, now = Date.now()): EightBallMatch {
  if (match.status !== "active" || match.pausedAt) return match;
  const updated = appendEvent(match, { type: "pause", occurredAt: now, source: "user" }, now);
  return { ...updated, pausedAt: now };
}

export function resumeEightBallMatch(match: EightBallMatch, now = Date.now()): EightBallMatch {
  if (match.status !== "active" || !match.pausedAt) return match;
  const pausedDurationMs = match.pausedDurationMs + Math.max(0, now - match.pausedAt);
  const updated = appendEvent(match, { type: "resume", occurredAt: now, source: "user" }, now);
  return { ...updated, pausedAt: undefined, pausedDurationMs };
}

export function finishEightBallMatch(match: EightBallMatch, now = Date.now()): EightBallMatch {
  if (match.status === "completed") return match;
  const pausedDurationMs = match.pausedDurationMs + (match.pausedAt ? Math.max(0, now - match.pausedAt) : 0);
  const updated = appendEvent(match, { type: "finish", occurredAt: now, source: "user" }, now);
  return { ...updated, status: "completed", endedAt: now, pausedAt: undefined, pausedDurationMs };
}

export function eightBallElapsedMs(match: EightBallMatch, now = Date.now()) {
  const end = match.endedAt ?? now;
  const currentPause = match.pausedAt ? Math.max(0, end - match.pausedAt) : 0;
  return Math.max(0, end - match.startedAt - match.pausedDurationMs - currentPause);
}

export function getEffectiveEightBallRounds(match: EightBallMatch): EffectiveEightBallRound[] {
  const corrections = new Map(match.events.filter((event) => event.type === "correction" && event.correctsEventId).map((event) => [event.correctsEventId!, event]));
  const stats = Object.fromEntries(match.players.map((player) => [player.id, 0]));
  const rounds: EffectiveEightBallRound[] = [];
  for (const event of match.events.filter((item) => item.type === "round")) {
    const correction = corrections.get(event.id);
    const round = correction ? correction.replacement : event.round;
    if (!round) continue;
    const before = { ...stats };
    stats[round.winnerId] = (stats[round.winnerId] ?? 0) + 1;
    const roundIndex = rounds.length;
    let serverId = match.firstServerId;
    if (match.serveRule === "alternate") serverId = match.players[(match.players.findIndex((player) => player.id === match.firstServerId) + roundIndex) % 2].id;
    else if (roundIndex > 0) serverId = rounds[roundIndex - 1].winnerId;
    rounds.push({ ...round, eventId: event.id, sequenceNo: event.sequenceNo, serverId, before, after: { ...stats }, originalEvent: event });
  }
  return rounds;
}

export function calculateEightBallStats(match: EightBallMatch): Record<string, EightBallPlayerStats> {
  const result = Object.fromEntries(match.players.map((player) => [player.id, { score: 0, normal: 0, breakClear: 0, runout: 0, fouls: 0 }]));
  for (const round of getEffectiveEightBallRounds(match)) {
    const winner = result[round.winnerId];
    winner.score += 1;
    if (round.winType === "normal") winner.normal += 1;
    if (round.winType === "break_clear") winner.breakClear += 1;
    if (round.winType === "runout") winner.runout += 1;
    for (const [playerId, count] of Object.entries(round.fouls)) if (result[playerId]) result[playerId].fouls += count;
  }
  return result;
}

export function isEightBallMatch(value: unknown): value is EightBallMatch {
  if (!value || typeof value !== "object") return false;
  const match = value as Partial<EightBallMatch>;
  return match.schemaVersion === 1 && match.mode === "chinese_eight" && Array.isArray(match.players) && match.players.length === 2 && Array.isArray(match.events);
}

export const EIGHT_BALL_WIN_LABELS: Record<EightBallWinType, string> = { normal: "普胜", break_clear: "炸清", runout: "接清" };
