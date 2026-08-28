import { createMatchCardState, type MatchCardState } from "./match";
import type { DeckSnapshot } from "./custom-decks";
import { secureRandomIndex } from "./deck";

export const SNOOKER_RULESET = "wpbsa-2024-09" as const;

export const SNOOKER_BALL_VALUES = {
  red: 1,
  yellow: 2,
  green: 3,
  brown: 4,
  blue: 5,
  pink: 6,
  black: 7,
} as const;

export type SnookerBall = keyof typeof SNOOKER_BALL_VALUES;
export type SnookerColour = Exclude<SnookerBall, "red">;
export type SnookerPhase = "reds" | "colour_after_red" | "colours_clearance" | "final_black" | "respotted_black" | "completed";
export type SnookerVariant = "standard" | "trick_cards";
export type OfficialSnookerFoulPoints = 4 | 5 | 6 | 7;

export const SNOOKER_COLOUR_CLEARANCE_ORDER = ["yellow", "green", "brown", "blue", "pink", "black"] as const;
export const SNOOKER_OFFICIAL_FOUL_POINTS = [4, 5, 6, 7] as const;
export const SNOOKER_BREAK_PROMPT_MIN_POINTS = 31;
export const SNOOKER_MIN_REDS = 1;
export const SNOOKER_MAX_REDS = 15;
export const SNOOKER_VARIANT_LABELS: Record<SnookerVariant, string> = {
  standard: "标准斯诺克",
  trick_cards: "奇招牌变体局",
};

export const SNOOKER_V1_REFEREE_BOUNDARY = {
  tracksBallPositions: false,
  freeBall: "manual",
  foulAndMiss: "manual",
  ballReplacement: "manual",
} as const;

export function shouldShowSnookerBreakPrompt(points: number) {
  return points >= SNOOKER_BREAK_PROMPT_MIN_POINTS;
}

export function getSnookerBreakBallCounts(snookerBreak: Pick<SnookerBreak, "pots">): Record<SnookerBall, number> {
  const counts: Record<SnookerBall, number> = { red: 0, yellow: 0, green: 0, brown: 0, blue: 0, pink: 0, black: 0 };
  for (const pot of snookerBreak.pots) counts[pot.ball] += 1;
  return counts;
}

export function getSnookerScoreSituation(frame: Pick<SnookerFrameState, "phase" | "scores" | "playerIds" | "redsRemaining" | "nextColour" | "pendingFreeBall">) {
  let remainingPoints = 0;
  if (frame.phase === "reds") remainingPoints = frame.redsRemaining * 8 + 27;
  else if (frame.phase === "colour_after_red") remainingPoints = frame.redsRemaining * 8 + 34;
  else if (frame.phase === "colours_clearance") {
    const nextIndex = SNOOKER_COLOUR_CLEARANCE_ORDER.indexOf(frame.nextColour ?? "yellow");
    remainingPoints = SNOOKER_COLOUR_CLEARANCE_ORDER.slice(Math.max(0, nextIndex))
      .reduce((total, ball) => total + SNOOKER_BALL_VALUES[ball], 0);
  } else if (frame.phase === "final_black" || frame.phase === "respotted_black") remainingPoints = 7;
  if (frame.pendingFreeBall && frame.phase !== "colour_after_red") remainingPoints += SNOOKER_BALL_VALUES[frame.pendingFreeBall.valueAs];

  const [firstId, secondId] = frame.playerIds;
  const firstScore = frame.scores[firstId] ?? 0;
  const secondScore = frame.scores[secondId] ?? 0;
  const leaderId = firstScore === secondScore ? undefined : firstScore > secondScore ? firstId : secondId;
  const trailingId = leaderId === firstId ? secondId : leaderId === secondId ? firstId : undefined;
  const lead = Math.abs(firstScore - secondScore);
  return { remainingPoints, leaderId, trailingId, lead, excessPoints: Math.max(0, lead - remainingPoints) };
}

export function isOfficialSnookerFoulPoints(points: number): points is OfficialSnookerFoulPoints {
  return SNOOKER_OFFICIAL_FOUL_POINTS.some((allowed) => allowed === points);
}

export function isValidSnookerBestOf(bestOf: number | null) {
  return bestOf === null || (Number.isInteger(bestOf) && bestOf > 0 && bestOf % 2 === 1);
}

export function isValidSnookerInitialReds(reds: number) {
  return Number.isInteger(reds) && reds >= SNOOKER_MIN_REDS && reds <= SNOOKER_MAX_REDS;
}

export interface SnookerPlayer {
  id: string;
  name: string;
}

export interface SnookerPot {
  ball: SnookerBall;
  valueAs: SnookerBall;
  points: number;
  freeBall: boolean;
}

export interface SnookerBreak {
  visitId: string;
  playerId: string;
  points: number;
  pots: SnookerPot[];
  redsPotted: number;
  coloursPotted: number;
  colourSequence: SnookerColour[];
  redBlackPairs: number;
  route: "none" | "147" | "155-free-ball";
  freeBallUsed: boolean;
}

export type SnookerFrameEndReason = "normal" | "resignation" | "award";

export interface SnookerFrameState {
  id: string;
  number: number;
  playerIds: readonly [string, string];
  initialReds: number;
  phase: SnookerPhase;
  status: "active" | "completed";
  scores: Record<string, number>;
  strikerId: string;
  visitNo: number;
  currentBreak: SnookerBreak;
  breaks: SnookerBreak[];
  redsRemaining: number;
  nextColour?: SnookerColour;
  pendingFreeBall?: { nominatedBall: SnookerBall; valueAs: SnookerBall };
  lastFoul?: { offenderId: string; beneficiaryId: string; points: OfficialSnookerFoulPoints; isMiss: boolean };
  restarts: number;
  startedAt: number;
  endedAt?: number;
  winnerId?: string;
  endReason?: SnookerFrameEndReason;
}

export interface SnookerFrameResult extends Omit<SnookerFrameState, "currentBreak" | "pendingFreeBall" | "lastFoul"> {
  breaks: SnookerBreak[];
  status: "completed";
  winnerId: string;
  endedAt: number;
  endReason: SnookerFrameEndReason;
}

export type SnookerFrameCommand =
  | { type: "snooker.pot.record"; ball: SnookerBall }
  | { type: "snooker.visit.end"; reason: "miss" | "safety" | "voluntary" }
  | { type: "snooker.foul.record"; values: readonly OfficialSnookerFoulPoints[]; isMiss?: boolean }
  | { type: "snooker.free_ball.declare"; nominatedBall: SnookerBall; valueAs: SnookerBall }
  | { type: "snooker.replay.request"; kind: "from_position" | "restore" }
  | { type: "snooker.respotted_black.start"; firstStrikerId: string }
  | { type: "snooker.frame.finish"; winnerId?: string; reason: SnookerFrameEndReason }
  | { type: "snooker.frame.restart"; firstStrikerId?: string };

export type SnookerMatchCommand =
  | { type: "snooker.player.rename"; playerId: string; name: string }
  | { type: "snooker.pause" }
  | { type: "snooker.resume" }
  | { type: "snooker.finish" };

export type SnookerCommand = SnookerFrameCommand | SnookerMatchCommand;

export interface SnookerEvent {
  id: string;
  operationId: string;
  sequenceNo: number;
  matchVersion: number;
  type: SnookerCommand["type"] | "snooker.event.correct";
  occurredAt: number;
  command?: SnookerCommand;
  correctsEventId?: string;
  replacement?: SnookerCommand;
}

export interface SnookerMatch {
  schemaVersion: 1;
  id: string;
  matchVersion: number;
  mode: "snooker";
  ruleset: typeof SNOOKER_RULESET;
  variant: SnookerVariant;
  status: "active" | "completed";
  players: [SnookerPlayer, SnookerPlayer];
  initialPlayerNames: readonly [string, string];
  bestOf: number | null;
  firstStrikerId: string;
  initialReds: number;
  framesWon: Record<string, number>;
  currentFrame: SnookerFrameState | null;
  completedFrames: SnookerFrameResult[];
  events: SnookerEvent[];
  cards?: MatchCardState;
  startedAt: number;
  endedAt?: number;
  pausedAt?: number;
  pausedDurationMs: number;
  title: string;
  location: string;
  note: string;
}

export interface SnookerDraft {
  playerNames: [string, string];
  bestOf: number | null;
  firstStriker: 0 | 1;
  initialReds?: number;
  variant?: SnookerVariant;
  cardMode?: "none" | "independent";
  initialHandSize?: number;
  deckSnapshot?: DeckSnapshot;
  title?: string;
  location?: string;
  note?: string;
}

const makeId = (prefix: string, now: number) => `${prefix}-${now}-${Math.random().toString(36).slice(2, 9)}`;

function makeBreak(frameNumber: number, visitNo: number, playerId: string, route: SnookerBreak["route"]): SnookerBreak {
  return {
    visitId: `snooker-frame-${frameNumber}-visit-${visitNo}`,
    playerId,
    points: 0,
    pots: [],
    redsPotted: 0,
    coloursPotted: 0,
    colourSequence: [],
    redBlackPairs: 0,
    route,
    freeBallUsed: false,
  };
}

function makeFrame(number: number, playerIds: readonly [string, string], firstStrikerId: string, reds: number, now: number, restarts = 0): SnookerFrameState {
  const route = reds === 15 ? "147" : "none";
  return {
    id: `snooker-frame-${number}-restart-${restarts}`,
    number,
    playerIds,
    initialReds: reds,
    phase: "reds",
    status: "active",
    scores: { [playerIds[0]]: 0, [playerIds[1]]: 0 },
    strikerId: firstStrikerId,
    visitNo: 1,
    currentBreak: makeBreak(number, 1, firstStrikerId, route),
    breaks: [],
    redsRemaining: reds,
    restarts,
    startedAt: now,
  };
}

function opponentId(frame: SnookerFrameState, playerId = frame.strikerId) {
  return frame.playerIds[0] === playerId ? frame.playerIds[1] : frame.playerIds[0];
}

function withFinishedBreak(frame: SnookerFrameState) {
  return frame.currentBreak.points > 0 ? { ...frame, breaks: [...frame.breaks, frame.currentBreak] } : frame;
}

function withNewVisit(frame: SnookerFrameState, strikerId: string) {
  const finished = withFinishedBreak(frame);
  const visitNo = finished.visitNo + 1;
  const route = finished.initialReds === 15 && finished.redsRemaining === 15 ? "147" : "none";
  return {
    ...finished,
    strikerId,
    visitNo,
    currentBreak: makeBreak(finished.number, visitNo, strikerId, route),
    pendingFreeBall: undefined,
    lastFoul: undefined,
  };
}

function assertFrameActive(frame: SnookerFrameState) {
  if (frame.status !== "active") throw new Error("当前局已结束");
}

function expectedBall(frame: SnookerFrameState): SnookerBall | "colour" {
  if (frame.phase === "reds") return "red";
  if (frame.phase === "colour_after_red") return "colour";
  return frame.nextColour ?? "black";
}

function ballLabel(ball: SnookerBall | "colour") {
  return ({ red: "红球", yellow: "黄球", green: "绿球", brown: "棕球", blue: "蓝球", pink: "粉球", black: "黑球", colour: "彩球" } as const)[ball];
}

function assertLegalPot(frame: SnookerFrameState, ball: SnookerBall, valueAs: SnookerBall) {
  const target = expectedBall(frame);
  if (target === "colour") {
    if (valueAs === "red") throw new Error("当前目标是彩球");
  } else if (valueAs !== target) {
    throw new Error(`当前目标是${ballLabel(target)}`);
  }
  if (frame.pendingFreeBall && ball !== frame.pendingFreeBall.nominatedBall) throw new Error("进球与自由球声明不一致");
}

function potBall(frame: SnookerFrameState, ball: SnookerBall, occurredAt: number) {
  assertFrameActive(frame);
  const pending = frame.pendingFreeBall;
  const valueAs = pending?.valueAs ?? ball;
  assertLegalPot(frame, ball, valueAs);
  const beforePhase = frame.phase;
  const points = SNOOKER_BALL_VALUES[valueAs];
  const freeBall = Boolean(pending);
  const scores = { ...frame.scores, [frame.strikerId]: frame.scores[frame.strikerId] + points };
  let route = frame.currentBreak.route;
  if (freeBall && !(beforePhase === "reds" && valueAs === "red" && route === "155-free-ball")) route = "none";
  if (beforePhase === "colour_after_red" && ball !== "black") route = "none";
  const currentBreak: SnookerBreak = {
    ...frame.currentBreak,
    points: frame.currentBreak.points + points,
    pots: [...frame.currentBreak.pots, { ball, valueAs, points, freeBall }],
    redsPotted: frame.currentBreak.redsPotted + (ball === "red" && !freeBall ? 1 : 0),
    coloursPotted: frame.currentBreak.coloursPotted + (ball === "red" ? 0 : 1),
    colourSequence: ball === "red" ? frame.currentBreak.colourSequence : [...frame.currentBreak.colourSequence, ball],
    redBlackPairs: frame.currentBreak.redBlackPairs + (beforePhase === "colour_after_red" && ball === "black" ? 1 : 0),
    route,
    freeBallUsed: frame.currentBreak.freeBallUsed || freeBall,
  };
  let next: SnookerFrameState = { ...frame, scores, currentBreak, pendingFreeBall: undefined, lastFoul: undefined };

  if (beforePhase === "reds") {
    next = { ...next, redsRemaining: frame.redsRemaining - (valueAs === "red" && !freeBall ? 1 : 0), phase: "colour_after_red", nextColour: undefined };
  } else if (beforePhase === "colour_after_red") {
    next = frame.redsRemaining > 0
      ? { ...next, phase: "reds", nextColour: undefined }
      : { ...next, phase: "colours_clearance", nextColour: "yellow" };
  } else if (beforePhase === "colours_clearance") {
    const index = SNOOKER_COLOUR_CLEARANCE_ORDER.indexOf(valueAs as SnookerColour);
    const nextColour = SNOOKER_COLOUR_CLEARANCE_ORDER[index + 1];
    next = nextColour === "black"
      ? { ...next, phase: "final_black", nextColour: "black" }
      : { ...next, nextColour };
  } else if (beforePhase === "final_black" || beforePhase === "respotted_black") {
    const tied = scores[frame.playerIds[0]] === scores[frame.playerIds[1]];
    if (beforePhase === "respotted_black" || !tied) {
      next = { ...next, phase: "completed", status: "completed", winnerId: frame.strikerId, endReason: "normal", endedAt: occurredAt, nextColour: undefined };
    }
  }
  return next;
}

export function projectSnookerEvent(state: SnookerFrameState, command: SnookerFrameCommand, occurredAt = state.startedAt): SnookerFrameState {
  if (command.type === "snooker.pot.record") return potBall(state, command.ball, occurredAt);
  if (command.type === "snooker.frame.finish") {
    if (command.reason !== "normal" && !command.winnerId) throw new Error("必须指定局胜者");
    if (command.reason === "normal" && state.status !== "completed") throw new Error("当前局尚未自然结束");
    const naturalWinnerId = state.winnerId ?? (state.scores[state.playerIds[0]] > state.scores[state.playerIds[1]] ? state.playerIds[0] : state.playerIds[1]);
    if (command.reason === "normal" && command.winnerId && command.winnerId !== naturalWinnerId) throw new Error("局胜者与比分不一致");
    const winnerId = command.reason === "normal" ? naturalWinnerId : command.winnerId!;
    if (!state.playerIds.includes(winnerId)) throw new Error("局胜者无效");
    return { ...state, phase: "completed", status: "completed", winnerId, endReason: command.reason, endedAt: occurredAt, pendingFreeBall: undefined };
  }
  assertFrameActive(state);

  if (command.type === "snooker.visit.end") return withNewVisit(state, opponentId(state));
  if (command.type === "snooker.free_ball.declare") {
    if (state.pendingFreeBall) throw new Error("已有待处理的自由球声明");
    const target = expectedBall(state);
    if (target !== "colour" && command.valueAs !== target) throw new Error(`自由球应作为${ballLabel(target)}`);
    if (target === "colour" && command.valueAs === "red") throw new Error("自由球应作为彩球");
    const special155 = state.phase === "reds" && command.valueAs === "red" && state.initialReds === 15
      && state.redsRemaining === 15 && state.currentBreak.points === 0;
    return {
      ...state,
      pendingFreeBall: { nominatedBall: command.nominatedBall, valueAs: command.valueAs },
      currentBreak: { ...state.currentBreak, route: special155 ? "155-free-ball" : "none", freeBallUsed: true },
      lastFoul: undefined,
    };
  }
  if (command.type === "snooker.foul.record") {
    if (!command.values.length || !command.values.every(isOfficialSnookerFoulPoints)) throw new Error("正式罚分只能为 4–7");
    const points = Math.max(...command.values) as OfficialSnookerFoulPoints;
    if ((state.phase === "final_black" || state.phase === "respotted_black") && points !== 7) throw new Error("黑球犯规罚 7 分");
    const offenderId = state.strikerId;
    const beneficiaryId = opponentId(state);
    let next: SnookerFrameState = withNewVisit(state, beneficiaryId);
    next = { ...next, scores: { ...next.scores, [beneficiaryId]: next.scores[beneficiaryId] + points }, lastFoul: { offenderId, beneficiaryId, points, isMiss: Boolean(command.isMiss) } };
    if (state.phase === "final_black" || state.phase === "respotted_black") {
      const tied = next.scores[state.playerIds[0]] === next.scores[state.playerIds[1]];
      if (state.phase === "respotted_black" || !tied) next = { ...next, phase: "completed", status: "completed", winnerId: beneficiaryId, endReason: "normal", endedAt: occurredAt, nextColour: undefined };
    }
    return next;
  }
  if (command.type === "snooker.replay.request") {
    if (!state.lastFoul) throw new Error("没有可重打的犯规");
    return withNewVisit(state, state.lastFoul.offenderId);
  }
  if (command.type === "snooker.respotted_black.start") {
    if (state.phase !== "final_black" || state.scores[state.playerIds[0]] !== state.scores[state.playerIds[1]]) throw new Error("当前不满足重置黑球条件");
    if (!state.playerIds.includes(command.firstStrikerId)) throw new Error("重置黑球先手无效");
    return { ...withNewVisit(state, command.firstStrikerId), phase: "respotted_black", nextColour: "black" };
  }
  if (command.type === "snooker.frame.restart") {
    const firstStrikerId = command.firstStrikerId ?? state.strikerId;
    if (!state.playerIds.includes(firstStrikerId)) throw new Error("重开先手无效");
    return makeFrame(state.number, state.playerIds, firstStrikerId, state.initialReds, occurredAt, state.restarts + 1);
  }
  return state;
}

function frameResult(frame: SnookerFrameState): SnookerFrameResult {
  if (frame.status !== "completed" || !frame.winnerId || frame.endedAt === undefined || !frame.endReason) throw new Error("当前局尚未结束");
  const finished = withFinishedBreak(frame);
  const result = { ...finished };
  Reflect.deleteProperty(result, "currentBreak");
  Reflect.deleteProperty(result, "pendingFreeBall");
  Reflect.deleteProperty(result, "lastFoul");
  return result as unknown as SnookerFrameResult;
}

function resetProjection(match: SnookerMatch): SnookerMatch {
  const players: [SnookerPlayer, SnookerPlayer] = match.players.map((player, index) => ({ id: player.id, name: match.initialPlayerNames[index] })) as [SnookerPlayer, SnookerPlayer];
  const playerIds = players.map(({ id }) => id) as [string, string];
  return {
    ...match,
    status: "active",
    players,
    framesWon: { [playerIds[0]]: 0, [playerIds[1]]: 0 },
    currentFrame: makeFrame(1, playerIds, match.firstStrikerId, match.initialReds, match.startedAt),
    completedFrames: [],
    endedAt: undefined,
    pausedAt: undefined,
    pausedDurationMs: 0,
  };
}

function applyMatchCommand(match: SnookerMatch, command: SnookerCommand, occurredAt: number): SnookerMatch {
  if (match.status === "completed") throw new Error("比赛已结束");
  if (command.type === "snooker.player.rename") {
    const name = command.name.trim();
    if (!name || !match.players.some(({ id }) => id === command.playerId)) throw new Error("选手姓名无效");
    return { ...match, players: match.players.map((player) => player.id === command.playerId ? { ...player, name } : player) as [SnookerPlayer, SnookerPlayer] };
  }
  if (command.type === "snooker.pause") {
    if (match.pausedAt) throw new Error("比赛已暂停");
    return { ...match, pausedAt: occurredAt };
  }
  if (command.type === "snooker.resume") {
    if (!match.pausedAt) throw new Error("比赛未暂停");
    return { ...match, pausedDurationMs: match.pausedDurationMs + Math.max(0, occurredAt - match.pausedAt), pausedAt: undefined };
  }
  if (command.type === "snooker.finish") {
    const pausedDurationMs = match.pausedDurationMs + (match.pausedAt ? Math.max(0, occurredAt - match.pausedAt) : 0);
    return { ...match, status: "completed", endedAt: occurredAt, pausedAt: undefined, pausedDurationMs };
  }
  if (match.pausedAt) throw new Error("比赛已暂停");
  if (!match.currentFrame) throw new Error("没有进行中的局");
  const currentFrame = projectSnookerEvent(match.currentFrame, command, occurredAt);
  if (command.type !== "snooker.frame.finish") return { ...match, currentFrame };
  const result = frameResult(currentFrame);
  const framesWon = { ...match.framesWon, [result.winnerId]: match.framesWon[result.winnerId] + 1 };
  const nextNumber = result.number + 1;
  const playerIds = match.players.map(({ id }) => id) as [string, string];
  const firstIndex = playerIds.indexOf(match.firstStrikerId);
  const nextStrikerId = playerIds[(firstIndex + nextNumber - 1) % 2];
  return {
    ...match,
    framesWon,
    completedFrames: [...match.completedFrames, result],
    currentFrame: makeFrame(nextNumber, playerIds, nextStrikerId, match.initialReds, occurredAt),
  };
}

export function createSnookerMatch(draft: SnookerDraft, now = Date.now()): SnookerMatch {
  const names = draft.playerNames.map((name) => name.trim()) as [string, string];
  if (!names[0] || !names[1]) throw new Error("双方姓名不能为空");
  if (!isValidSnookerBestOf(draft.bestOf)) throw new Error("Best of 必须为正奇数或自由局");
  const reds = draft.initialReds ?? SNOOKER_MAX_REDS;
  if (!isValidSnookerInitialReds(reds)) throw new Error(`红球数必须是 ${SNOOKER_MIN_REDS}–${SNOOKER_MAX_REDS} 的整数`);
  const players: [SnookerPlayer, SnookerPlayer] = [
    { id: `snooker-player-${now}-1`, name: names[0] },
    { id: `snooker-player-${now}-2`, name: names[1] },
  ];
  const playerIds = players.map(({ id }) => id) as [string, string];
  const variant = draft.variant ?? "standard";
  const cards = variant === "trick_cards" && draft.cardMode !== "none"
    ? createMatchCardState({
        cardMode: "independent",
        handIds: playerIds,
        initialHandSize: Math.max(1, Math.min(10, Math.trunc(draft.initialHandSize ?? 3))),
        deckSnapshot: draft.deckSnapshot,
        game: "snooker",
      })
    : undefined;
  if (variant === "trick_cards" && !cards?.deckSnapshot.cardCount) throw new Error("所选牌组没有斯诺克兼容牌");
  return {
    schemaVersion: 1,
    id: makeId("snooker", now),
    matchVersion: 0,
    mode: "snooker",
    ruleset: SNOOKER_RULESET,
    variant,
    status: "active",
    players,
    initialPlayerNames: names,
    bestOf: draft.bestOf,
    firstStrikerId: players[draft.firstStriker].id,
    initialReds: reds,
    framesWon: { [playerIds[0]]: 0, [playerIds[1]]: 0 },
    currentFrame: makeFrame(1, playerIds, players[draft.firstStriker].id, reds, now),
    completedFrames: [],
    events: [],
    ...(cards ? { cards } : {}),
    startedAt: now,
    pausedDurationMs: 0,
    title: draft.title?.trim() ?? "",
    location: draft.location?.trim() ?? "",
    note: draft.note?.trim() ?? "",
  };
}

export function recordSnookerCardAction(
  match: SnookerMatch,
  playerId: string,
  instanceId: string,
  action: "play" | "skip",
  now = Date.now(),
  randomIndex = secureRandomIndex,
): SnookerMatch {
  const hand = match.cards?.hands[playerId];
  const card = hand?.find((item) => item.instanceId === instanceId);
  if (match.status !== "active" || match.pausedAt || !match.cards || !hand || !card) throw new Error("卡牌操作无效");
  const remaining = [...match.cards.remaining];
  let nextHand = hand.filter((item) => item.instanceId !== instanceId);
  const events = [{ id: makeId("card", now), type: action, label: action === "play" ? `使用「${card.title}」` : `安全跳过「${card.title}」`, handId: playerId, card, occurredAt: now }, ...match.cards.events];
  if (action === "skip" && remaining.length) {
    const index = randomIndex(remaining.length);
    const drawn = remaining[index];
    remaining[index] = remaining[remaining.length - 1];
    remaining.pop();
    nextHand = [drawn, ...nextHand];
    events.unshift({ id: makeId("card", now + 1), type: "draw", label: `安全补牌「${drawn.title}」`, handId: playerId, card: drawn, occurredAt: now + 1 });
  }
  return {
    ...match,
    matchVersion: match.matchVersion + 1,
    cards: {
      ...match.cards,
      remaining,
      hands: { ...match.cards.hands, [playerId]: nextHand },
      used: action === "play" ? [card, ...match.cards.used] : match.cards.used,
      skipped: action === "skip" ? [card, ...match.cards.skipped] : match.cards.skipped,
      events,
    },
  };
}

function appendEvent(match: SnookerMatch, input: Omit<SnookerEvent, "id" | "operationId" | "sequenceNo" | "matchVersion">, now: number) {
  const version = match.matchVersion + 1;
  const event: SnookerEvent = {
    ...input,
    id: makeId("snooker-event", now),
    operationId: makeId("operation", now),
    sequenceNo: match.events.length + 1,
    matchVersion: version,
  };
  return { ...match, matchVersion: version, events: [...match.events, event] };
}

export function projectSnookerMatch(match: SnookerMatch): SnookerMatch {
  let projected = resetProjection(match);
  const corrections = new Map<string, SnookerEvent>();
  for (const event of match.events) if (event.type === "snooker.event.correct" && event.correctsEventId) corrections.set(event.correctsEventId, event);
  for (const event of match.events) {
    if (event.type === "snooker.event.correct" || !event.command) continue;
    const correction = corrections.get(event.id);
    const command = correction ? correction.replacement : event.command;
    if (command) projected = applyMatchCommand(projected, command, event.occurredAt);
  }
  return { ...projected, matchVersion: match.matchVersion, events: match.events };
}

export function recordSnookerCommand(match: SnookerMatch, command: SnookerCommand, now = Date.now()) {
  return projectSnookerMatch(appendEvent(match, { type: command.type, occurredAt: now, command }, now));
}

export function correctSnookerEvent(match: SnookerMatch, eventId: string, replacement: SnookerCommand | null, now = Date.now()) {
  const target = match.events.find((event) => event.id === eventId && event.type !== "snooker.event.correct");
  if (!target) throw new Error("待更正事件不存在");
  return projectSnookerMatch(appendEvent(match, {
    type: "snooker.event.correct",
    occurredAt: now,
    correctsEventId: eventId,
    replacement: replacement ?? undefined,
  }, now));
}

export function undoLastSnookerEvent(match: SnookerMatch, now = Date.now()) {
  const corrections = new Map(match.events.filter(({ type, correctsEventId }) => type === "snooker.event.correct" && correctsEventId).map((event) => [event.correctsEventId!, event]));
  const target = match.events.filter(({ type, command, id }) => type !== "snooker.event.correct" && command && (!corrections.has(id) || corrections.get(id)?.replacement !== undefined)).at(-1);
  if (!target) return match;
  return correctSnookerEvent(match, target.id, null, now);
}

export function getSnookerBreakStats(match: SnookerMatch) {
  const breaks = [
    ...match.completedFrames.flatMap((frame) => frame.breaks),
    ...(match.currentFrame ? [...match.currentFrame.breaks, ...(match.currentFrame.currentBreak.points ? [match.currentFrame.currentBreak] : [])] : []),
  ];
  const breaks30Plus = breaks.filter(({ points }) => shouldShowSnookerBreakPrompt(points));
  const highestByPlayer = Object.fromEntries(match.players.map(({ id }) => [id, Math.max(0, ...breaks.filter(({ playerId }) => playerId === id).map(({ points }) => points))]));
  return {
    highestBreak: Math.max(0, ...breaks.map(({ points }) => points)),
    highestByPlayer,
    breaks30Plus,
    breaks30PlusCount: breaks30Plus.length,
    completed147: breaks.filter(({ points, route }) => points === 147 && route === "147").length,
    completed155: breaks.filter(({ points, route }) => points === 155 && route === "155-free-ball").length,
  };
}

export function isSnookerMatch(value: unknown): value is SnookerMatch {
  if (!value || typeof value !== "object") return false;
  const match = value as Partial<SnookerMatch>;
  const playersValid = Array.isArray(match.players) && match.players.length === 2
    && match.players.every((player) => player && typeof player.id === "string" && typeof player.name === "string" && player.name.trim());
  const frameValid = (frame: SnookerFrameState | SnookerFrameResult | null | undefined) => frame === null || Boolean(frame
    && Number.isSafeInteger(frame.number) && frame.number > 0
    && Array.isArray(frame.playerIds) && frame.playerIds.length === 2
    && typeof frame.strikerId === "string" && typeof frame.scores === "object"
    && Number.isSafeInteger(frame.initialReds) && isValidSnookerInitialReds(frame.initialReds)
    && Number.isSafeInteger(frame.redsRemaining) && frame.redsRemaining >= 0 && frame.redsRemaining <= frame.initialReds
    && (frame.status === "active" || frame.status === "completed"));
  return match.schemaVersion === 1 && match.mode === "snooker" && match.ruleset === SNOOKER_RULESET
    && (match.status === "active" || match.status === "completed") && playersValid
    && Array.isArray(match.initialPlayerNames) && match.initialPlayerNames.length === 2
    && (match.bestOf === null || typeof match.bestOf === "number") && isValidSnookerBestOf(match.bestOf)
    && typeof match.id === "string" && Number.isSafeInteger(match.matchVersion) && match.matchVersion! >= 0
    && typeof match.firstStrikerId === "string" && match.players!.some(({ id }) => id === match.firstStrikerId)
    && Number.isSafeInteger(match.initialReds) && isValidSnookerInitialReds(match.initialReds)
    && Array.isArray(match.events) && match.events.every((event) => event && typeof event.id === "string" && typeof event.type === "string")
    && Array.isArray(match.completedFrames) && match.completedFrames.every(frameValid) && frameValid(match.currentFrame)
    && typeof match.framesWon === "object" && Number.isSafeInteger(match.startedAt)
    && Number.isSafeInteger(match.pausedDurationMs) && typeof match.title === "string"
    && typeof match.location === "string" && typeof match.note === "string";
}

export type SnookerRuleVectorCommand =
  | { type: "pot"; ball: SnookerBall; freeBallAs?: "red" }
  | { type: "foul"; values: readonly OfficialSnookerFoulPoints[] }
  | { type: "respotted_black.start"; firstStriker: 0 | 1 };

export interface SnookerRuleVectorState {
  phase: SnookerPhase;
  scores: readonly [number, number];
  striker: 0 | 1;
  redsRemaining: number;
  breakPoints: number;
  nextColour?: SnookerColour;
  route: "none" | "147" | "155-free-ball";
  frameStatus: "active" | "completed";
}

export interface SnookerRuleTestVector {
  name: string;
  initial: SnookerRuleVectorState;
  commands: readonly SnookerRuleVectorCommand[];
  expected: SnookerRuleVectorState;
}

const STANDARD_147_SEQUENCE: readonly SnookerRuleVectorCommand[] = [
  ...Array.from({ length: 15 }, () => [
    { type: "pot", ball: "red" },
    { type: "pot", ball: "black" },
  ] as const).flat(),
  ...SNOOKER_COLOUR_CLEARANCE_ORDER.map((ball) => ({ type: "pot", ball }) as const),
];

const FREE_BALL_155_SEQUENCE: readonly SnookerRuleVectorCommand[] = [
  { type: "pot", ball: "black", freeBallAs: "red" },
  { type: "pot", ball: "black" },
  ...STANDARD_147_SEQUENCE,
];

export const SNOOKER_RULE_TEST_VECTORS: readonly SnookerRuleTestVector[] = [
  {
    name: "red-colour alternation returns to a red",
    initial: { phase: "reds", scores: [0, 0], striker: 0, redsRemaining: 15, breakPoints: 0, route: "147", frameStatus: "active" },
    commands: [{ type: "pot", ball: "red" }, { type: "pot", ball: "black" }],
    expected: { phase: "reds", scores: [8, 0], striker: 0, redsRemaining: 14, breakPoints: 8, route: "147", frameStatus: "active" },
  },
  {
    name: "last red and colour lead into ordered clearance",
    initial: { phase: "reds", scores: [0, 0], striker: 0, redsRemaining: 1, breakPoints: 0, route: "147", frameStatus: "active" },
    commands: [{ type: "pot", ball: "red" }, { type: "pot", ball: "black" }, { type: "pot", ball: "yellow" }],
    expected: { phase: "colours_clearance", scores: [10, 0], striker: 0, redsRemaining: 0, breakPoints: 10, nextColour: "green", route: "147", frameStatus: "active" },
  },
  {
    name: "fifteen red-black pairs and the clearance score 147",
    initial: { phase: "reds", scores: [0, 0], striker: 0, redsRemaining: 15, breakPoints: 0, route: "147", frameStatus: "active" },
    commands: STANDARD_147_SEQUENCE,
    expected: { phase: "completed", scores: [147, 0], striker: 0, redsRemaining: 0, breakPoints: 147, route: "147", frameStatus: "completed" },
  },
  {
    name: "a pre-red free ball creates a separate 155 route",
    initial: { phase: "reds", scores: [0, 0], striker: 0, redsRemaining: 15, breakPoints: 0, route: "155-free-ball", frameStatus: "active" },
    commands: FREE_BALL_155_SEQUENCE,
    expected: { phase: "completed", scores: [155, 0], striker: 0, redsRemaining: 0, breakPoints: 155, route: "155-free-ball", frameStatus: "completed" },
  },
  {
    name: "only the highest foul value from one stroke is awarded",
    initial: { phase: "reds", scores: [12, 20], striker: 0, redsRemaining: 10, breakPoints: 6, route: "none", frameStatus: "active" },
    commands: [{ type: "foul", values: [4, 6, 7] }],
    expected: { phase: "reds", scores: [12, 27], striker: 1, redsRemaining: 10, breakPoints: 0, route: "none", frameStatus: "active" },
  },
  {
    name: "the final black ends a non-tied frame",
    initial: { phase: "final_black", scores: [60, 53], striker: 0, redsRemaining: 0, breakPoints: 20, nextColour: "black", route: "none", frameStatus: "active" },
    commands: [{ type: "pot", ball: "black" }],
    expected: { phase: "completed", scores: [67, 53], striker: 0, redsRemaining: 0, breakPoints: 27, route: "none", frameStatus: "completed" },
  },
  {
    name: "a tied final black enters respotted black without changing the tie",
    initial: { phase: "final_black", scores: [60, 67], striker: 0, redsRemaining: 0, breakPoints: 20, nextColour: "black", route: "none", frameStatus: "active" },
    commands: [{ type: "pot", ball: "black" }, { type: "respotted_black.start", firstStriker: 1 }],
    expected: { phase: "respotted_black", scores: [67, 67], striker: 1, redsRemaining: 0, breakPoints: 0, nextColour: "black", route: "none", frameStatus: "active" },
  },
  {
    name: "the first score on a respotted black ends the frame",
    initial: { phase: "respotted_black", scores: [67, 67], striker: 1, redsRemaining: 0, breakPoints: 0, nextColour: "black", route: "none", frameStatus: "active" },
    commands: [{ type: "pot", ball: "black" }],
    expected: { phase: "completed", scores: [67, 74], striker: 1, redsRemaining: 0, breakPoints: 7, route: "none", frameStatus: "completed" },
  },
];

export function runSnookerRuleTestVector(vector: SnookerRuleTestVector): SnookerRuleVectorState {
  const playerIds = ["vector-player-0", "vector-player-1"] as const;
  const initialReds = vector.initial.route === "none" ? vector.initial.redsRemaining : 15;
  let frame = makeFrame(1, playerIds, playerIds[vector.initial.striker], initialReds, 0);
  frame = {
    ...frame,
    phase: vector.initial.phase,
    status: vector.initial.frameStatus,
    scores: { [playerIds[0]]: vector.initial.scores[0], [playerIds[1]]: vector.initial.scores[1] },
    redsRemaining: vector.initial.redsRemaining,
    nextColour: vector.initial.nextColour,
    currentBreak: {
      ...frame.currentBreak,
      points: vector.initial.breakPoints,
      route: vector.initial.route,
    },
  };
  for (const command of vector.commands) {
    if (command.type === "pot") {
      if (command.freeBallAs) frame = projectSnookerEvent(frame, {
        type: "snooker.free_ball.declare",
        nominatedBall: command.ball,
        valueAs: command.freeBallAs,
      });
      frame = projectSnookerEvent(frame, { type: "snooker.pot.record", ball: command.ball });
    } else if (command.type === "foul") {
      frame = projectSnookerEvent(frame, { type: "snooker.foul.record", values: command.values });
    } else {
      frame = projectSnookerEvent(frame, { type: "snooker.respotted_black.start", firstStrikerId: playerIds[command.firstStriker] });
    }
  }
  return {
    phase: frame.phase,
    scores: [frame.scores[playerIds[0]], frame.scores[playerIds[1]]],
    striker: frame.strikerId === playerIds[0] ? 0 : 1,
    redsRemaining: frame.redsRemaining,
    breakPoints: frame.currentBreak.points,
    ...(frame.nextColour ? { nextColour: frame.nextColour } : {}),
    route: frame.currentBreak.route,
    frameStatus: frame.status,
  };
}
