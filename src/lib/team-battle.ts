export type TeamBattleWinType = "normal" | "break_clear" | "runout";
export type TeamBattleReportDetail = "auto" | "full" | "summary";

export const TEAM_BATTLE_MIN_PLAYERS = 2;
export const TEAM_BATTLE_MAX_PLAYERS = 8;
export const TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH = 20;
export const TEAM_BATTLE_REPORT_AUTO_DETAIL_MAX_HEIGHT = 20_000;
export const TEAM_BATTLE_REPORT_HARD_MAX_HEIGHT = 30_000;

export interface TeamBattlePlayer {
  id: string;
  name: string;
  joinedAt: number;
}

export interface TeamBattleDraft {
  playerNames: string[];
  title?: string;
  location?: string;
  note?: string;
}

export interface TeamBattleRoundPayload {
  playerIds: [string, string];
  winnerId: string;
  winType: TeamBattleWinType;
  fouls: Record<string, number>;
  note: string;
  startedAt: number;
  confirmedAt: number;
}

export interface TeamBattleEvent {
  id: string;
  sequenceNo: number;
  type: "join" | "rename" | "round" | "correction" | "pause" | "resume" | "finish";
  occurredAt: number;
  playerNames: Record<string, string>;
  round?: TeamBattleRoundPayload;
  correctsEventId?: string;
  replacement?: TeamBattleRoundPayload;
  playerId?: string;
  previousName?: string;
  nextName?: string;
}

export interface TeamBattleMatch {
  schemaVersion: 1;
  id: string;
  mode: "team_battle";
  status: "active" | "completed";
  title: string;
  location: string;
  note: string;
  createdAt: number;
  startedAt: number;
  endedAt?: number;
  pausedAt?: number;
  pausedDurationMs: number;
  players: TeamBattlePlayer[];
  events: TeamBattleEvent[];
}

export interface EffectiveTeamBattleRound extends TeamBattleRoundPayload {
  eventId: string;
  sequenceNo: number;
  before: Record<string, number>;
  after: Record<string, number>;
  originalEvent: TeamBattleEvent;
}

export interface TeamBattlePlayerStats {
  wins: number;
  losses: number;
  differential: number;
  normalWins: number;
  breakClears: number;
  runouts: number;
  fouls: number;
}

export interface PairProjection {
  pairKey: string;
  players: [TeamBattlePlayer, TeamBattlePlayer];
  scores: Record<string, number>;
  rounds: EffectiveTeamBattleRound[];
  lastPlayedAt?: number;
}

export interface PlayerStanding {
  rank: number;
  tied: boolean;
  player: TeamBattlePlayer;
  wins: number;
  losses: number;
  differential: number;
  opponentsPlayed: number;
}

export interface TeamBattleProjection {
  rounds: EffectiveTeamBattleRound[];
  pairs: PairProjection[];
  standings: PlayerStanding[];
  playerStats: Record<string, TeamBattlePlayerStats>;
}

export interface PlayerOpponentProjection {
  opponent: TeamBattlePlayer;
  scores: Record<string, number>;
  played: boolean;
  rounds: EffectiveTeamBattleRound[];
}

export interface PlayerReportProjection {
  player: TeamBattlePlayer;
  wins: number;
  losses: number;
  differential: number;
  opponents: PlayerOpponentProjection[];
  rounds: EffectiveTeamBattleRound[];
}

export type TeamBattleReportScope =
  | { kind: "all" }
  | { kind: "player"; playerId: string };

export interface TeamBattleReportOptions {
  scope: TeamBattleReportScope;
  detail: TeamBattleReportDetail;
}

export interface TeamBattleReportProjection {
  scope: TeamBattleReportScope;
  requestedDetail: TeamBattleReportDetail;
  resolvedDetail: Exclude<TeamBattleReportDetail, "auto">;
  omittedRounds: boolean;
  omissionReason?: string;
  estimatedHeight: number;
  match: TeamBattleProjection;
  player?: PlayerReportProjection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStoredRound(value: unknown, playerIds: Set<string>): value is TeamBattleRoundPayload {
  if (!isRecord(value) || !Array.isArray(value.playerIds) || value.playerIds.length !== 2) return false;
  const pair = value.playerIds;
  return pair.every((id) => typeof id === "string" && playerIds.has(id))
    && pair[0] !== pair[1]
    && typeof value.winnerId === "string" && pair.includes(value.winnerId)
    && typeof value.winType === "string" && WIN_TYPES.includes(value.winType as TeamBattleWinType)
    && isRecord(value.fouls)
    && Object.entries(value.fouls).every(([id, count]) => pair.includes(id) && Number.isInteger(count) && (count as number) >= 0)
    && typeof value.note === "string"
    && isFiniteNumber(value.startedAt)
    && isFiniteNumber(value.confirmedAt);
}

export function isTeamBattleMatch(value: unknown): value is TeamBattleMatch {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.mode !== "team_battle"
    || (value.status !== "active" && value.status !== "completed")
    || typeof value.id !== "string" || !value.id
    || typeof value.title !== "string" || typeof value.location !== "string" || typeof value.note !== "string"
    || !isFiniteNumber(value.createdAt) || !isFiniteNumber(value.startedAt)
    || !isFiniteNumber(value.pausedDurationMs) || value.pausedDurationMs < 0
    || (value.endedAt !== undefined && !isFiniteNumber(value.endedAt))
    || (value.pausedAt !== undefined && !isFiniteNumber(value.pausedAt))
    || !Array.isArray(value.players)
    || value.players.length < TEAM_BATTLE_MIN_PLAYERS || value.players.length > TEAM_BATTLE_MAX_PLAYERS
    || !Array.isArray(value.events)) return false;

  const players = value.players;
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const player of players) {
    if (!isRecord(player) || typeof player.id !== "string" || !player.id || ids.has(player.id)
      || typeof player.name !== "string" || player.name !== player.name.trim()
      || !player.name || Array.from(player.name).length > TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH || names.has(player.name)
      || !isFiniteNumber(player.joinedAt)) return false;
    ids.add(player.id);
    names.add(player.name);
  }

  const eventIds = new Set<string>();
  const roundEventIds = new Set<string>();
  let previousSequenceNo = 0;
  let hasFinishEvent = false;
  for (const event of value.events) {
    if (!isRecord(event) || typeof event.id !== "string" || !event.id || eventIds.has(event.id)
      || !Number.isInteger(event.sequenceNo) || event.sequenceNo !== previousSequenceNo + 1
      || !["join", "rename", "round", "correction", "pause", "resume", "finish"].includes(event.type as string)
      || !isFiniteNumber(event.occurredAt) || !isRecord(event.playerNames)
      || !Object.entries(event.playerNames).every(([id, name]) => ids.has(id) && typeof name === "string")) return false;
    eventIds.add(event.id);
    previousSequenceNo = event.sequenceNo as number;
    if (event.type === "round") {
      if (!isStoredRound(event.round, ids)) return false;
      roundEventIds.add(event.id);
    }
    if (event.type === "correction") {
      if (typeof event.correctsEventId !== "string" || !roundEventIds.has(event.correctsEventId)
        || (event.replacement !== undefined && !isStoredRound(event.replacement, ids))) return false;
    }
    if ((event.type === "join" || event.type === "rename")
      && (typeof event.playerId !== "string" || !ids.has(event.playerId))) return false;
    if (event.type === "finish") {
      if (hasFinishEvent) return false;
      hasFinishEvent = true;
    }
  }
  return value.status === "active"
    ? value.endedAt === undefined && !hasFinishEvent
    : isFiniteNumber(value.endedAt) && value.pausedAt === undefined && hasFinishEvent;
}

export function teamBattlePairKey(firstPlayerId: string, secondPlayerId: string) {
  return firstPlayerId < secondPlayerId
    ? `${firstPlayerId}::${secondPlayerId}`
    : `${secondPlayerId}::${firstPlayerId}`;
}

export function compareTeamBattleStandings(first: PlayerStanding, second: PlayerStanding) {
  return second.wins - first.wins
    || first.losses - second.losses
    || second.differential - first.differential
    || first.player.joinedAt - second.player.joinedAt
    || first.player.id.localeCompare(second.player.id);
}

const WIN_TYPES: TeamBattleWinType[] = ["normal", "break_clear", "runout"];

function makeMatchId(now: number) {
  return `team-battle-${now}-${Math.random().toString(36).slice(2, 9)}`;
}

function nextSequenceNo(match: TeamBattleMatch) {
  return match.events.length ? Math.max(...match.events.map(({ sequenceNo }) => sequenceNo)) + 1 : 1;
}

function appendTeamBattleEvent(match: TeamBattleMatch, event: Omit<TeamBattleEvent, "id" | "sequenceNo" | "playerNames">): TeamBattleMatch {
  const sequenceNo = nextSequenceNo(match);
  return {
    ...match,
    events: [...match.events, {
      ...event,
      id: `${match.id}-event-${sequenceNo}`,
      sequenceNo,
      playerNames: Object.fromEntries(match.players.map(({ id, name }) => [id, name])),
    }],
  };
}

function normalizePlayerName(name: string) {
  const normalized = name.trim();
  if (!normalized || Array.from(normalized).length > TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH) {
    throw new Error(`成员姓名必须为 1–${TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH} 个字符`);
  }
  return normalized;
}

function assertUniquePlayerName(players: TeamBattlePlayer[], name: string, exceptPlayerId?: string) {
  if (players.some((player) => player.id !== exceptPlayerId && player.name === name)) throw new Error("同场成员姓名不能重复");
}

function assertActive(match: TeamBattleMatch) {
  if (match.status !== "active") throw new Error("团战已结束");
}

function findPlayer(match: TeamBattleMatch, playerId: string) {
  const player = match.players.find(({ id }) => id === playerId);
  if (!player) throw new Error("成员不存在");
  return player;
}

function assertPair(match: TeamBattleMatch, playerIds: [string, string]) {
  if (playerIds[0] === playerIds[1]) throw new Error("对阵成员不能相同");
  findPlayer(match, playerIds[0]);
  findPlayer(match, playerIds[1]);
}

function normalizeRound(match: TeamBattleMatch, round: TeamBattleRoundPayload): TeamBattleRoundPayload {
  assertPair(match, round.playerIds);
  if (!round.playerIds.includes(round.winnerId)) throw new Error("胜者必须属于当前对阵");
  if (!WIN_TYPES.includes(round.winType)) throw new Error("获胜类型无效");
  for (const [playerId, count] of Object.entries(round.fouls)) {
    if (!round.playerIds.includes(playerId) || !Number.isInteger(count) || count < 0) throw new Error("犯规必须属于当前对阵且为非负整数");
  }
  return { ...round, playerIds: [...round.playerIds], fouls: { ...round.fouls }, note: round.note.trim() };
}

export function createTeamBattleMatch(draft: TeamBattleDraft, now = Date.now()): TeamBattleMatch {
  if (draft.playerNames.length < TEAM_BATTLE_MIN_PLAYERS || draft.playerNames.length > TEAM_BATTLE_MAX_PLAYERS) {
    throw new Error(`团战成员必须为 ${TEAM_BATTLE_MIN_PLAYERS}–${TEAM_BATTLE_MAX_PLAYERS} 人`);
  }
  const names = draft.playerNames.map(normalizePlayerName);
  if (new Set(names).size !== names.length) throw new Error("同场成员姓名不能重复");
  const id = makeMatchId(now);
  return {
    schemaVersion: 1,
    id,
    mode: "team_battle",
    status: "active",
    title: draft.title?.trim() ?? "",
    location: draft.location?.trim() ?? "",
    note: draft.note?.trim() ?? "",
    createdAt: now,
    startedAt: now,
    pausedDurationMs: 0,
    players: names.map((name, index) => ({ id: `${id}-player-${index + 1}`, name, joinedAt: now })),
    events: [],
  };
}

export function addTeamBattlePlayer(match: TeamBattleMatch, name: string, now = Date.now()): TeamBattleMatch {
  assertActive(match);
  if (match.players.length >= TEAM_BATTLE_MAX_PLAYERS) throw new Error("团战最多 8 名成员");
  const normalized = normalizePlayerName(name);
  assertUniquePlayerName(match.players, normalized);
  const player = { id: `${match.id}-player-${match.players.length + 1}`, name: normalized, joinedAt: now };
  return appendTeamBattleEvent({ ...match, players: [...match.players, player] }, {
    type: "join", occurredAt: now, playerId: player.id, nextName: player.name,
  });
}

export function renameTeamBattlePlayer(match: TeamBattleMatch, playerId: string, name: string, now = Date.now()): TeamBattleMatch {
  assertActive(match);
  const player = findPlayer(match, playerId);
  const normalized = normalizePlayerName(name);
  assertUniquePlayerName(match.players, normalized, playerId);
  if (player.name === normalized) return match;
  const renamed = { ...match, players: match.players.map((item) => item.id === playerId ? { ...item, name: normalized } : item) };
  return appendTeamBattleEvent(renamed, {
    type: "rename", occurredAt: now, playerId, previousName: player.name, nextName: normalized,
  });
}

export function recordTeamBattleRound(match: TeamBattleMatch, input: Omit<TeamBattleRoundPayload, "confirmedAt">, now = Date.now()): TeamBattleMatch {
  assertActive(match);
  if (match.pausedAt !== undefined) throw new Error("团战已暂停");
  const round = normalizeRound(match, { ...input, confirmedAt: now });
  return appendTeamBattleEvent(match, { type: "round", occurredAt: now, round });
}

export function correctTeamBattleRound(match: TeamBattleMatch, eventId: string, replacement: TeamBattleRoundPayload | null, now = Date.now()): TeamBattleMatch {
  assertActive(match);
  const original = match.events.find((event) => event.id === eventId && event.type === "round");
  if (!original) throw new Error("待更正的局不存在");
  return appendTeamBattleEvent(match, {
    type: "correction",
    occurredAt: now,
    correctsEventId: eventId,
    replacement: replacement ? normalizeRound(match, replacement) : undefined,
  });
}

export function undoLastTeamBattleRound(match: TeamBattleMatch, pair?: [string, string], now = Date.now()): TeamBattleMatch {
  assertActive(match);
  if (pair) assertPair(match, pair);
  const key = pair ? teamBattlePairKey(...pair) : undefined;
  const target = getEffectiveTeamBattleRounds(match).filter((round) => !key || teamBattlePairKey(...round.playerIds) === key).at(-1);
  if (!target) throw new Error("没有可撤销的局");
  return correctTeamBattleRound(match, target.eventId, null, now);
}

export function pauseTeamBattleMatch(match: TeamBattleMatch, now = Date.now()): TeamBattleMatch {
  assertActive(match);
  if (match.pausedAt !== undefined) throw new Error("团战已暂停");
  return { ...appendTeamBattleEvent(match, { type: "pause", occurredAt: now }), pausedAt: now };
}

export function resumeTeamBattleMatch(match: TeamBattleMatch, now = Date.now()): TeamBattleMatch {
  assertActive(match);
  if (match.pausedAt === undefined) throw new Error("团战未暂停");
  return {
    ...appendTeamBattleEvent(match, { type: "resume", occurredAt: now }),
    pausedAt: undefined,
    pausedDurationMs: match.pausedDurationMs + Math.max(0, now - match.pausedAt),
  };
}

export function finishTeamBattleMatch(match: TeamBattleMatch, now = Date.now()): TeamBattleMatch {
  assertActive(match);
  const pausedDurationMs = match.pausedDurationMs + (match.pausedAt === undefined ? 0 : Math.max(0, now - match.pausedAt));
  return {
    ...appendTeamBattleEvent(match, { type: "finish", occurredAt: now }),
    status: "completed",
    endedAt: now,
    pausedAt: undefined,
    pausedDurationMs,
  };
}

export function teamBattleElapsedMs(match: TeamBattleMatch, now = Date.now()) {
  const end = match.endedAt ?? now;
  const currentPause = match.pausedAt === undefined ? 0 : Math.max(0, end - match.pausedAt);
  return Math.max(0, end - match.startedAt - match.pausedDurationMs - currentPause);
}

export function getEffectiveTeamBattleRounds(match: TeamBattleMatch): EffectiveTeamBattleRound[] {
  const corrections = new Map(match.events.filter((event) => event.type === "correction" && event.correctsEventId).map((event) => [event.correctsEventId!, event]));
  const pairScores = new Map<string, Record<string, number>>();
  const rounds: EffectiveTeamBattleRound[] = [];
  for (const event of match.events) {
    if (event.type !== "round") continue;
    const correction = corrections.get(event.id);
    const round = correction ? correction.replacement : event.round;
    if (!round) continue;
    const key = teamBattlePairKey(...round.playerIds);
    const scores = pairScores.get(key) ?? Object.fromEntries(round.playerIds.map((id) => [id, 0]));
    const before = { ...scores };
    scores[round.winnerId] += 1;
    pairScores.set(key, scores);
    rounds.push({ ...round, eventId: event.id, sequenceNo: event.sequenceNo, before, after: { ...scores }, originalEvent: event });
  }
  return rounds;
}

function emptyPlayerStats(): TeamBattlePlayerStats {
  return { wins: 0, losses: 0, differential: 0, normalWins: 0, breakClears: 0, runouts: 0, fouls: 0 };
}

function sameCompetitiveStanding(first: PlayerStanding, second: PlayerStanding) {
  return first.wins === second.wins && first.losses === second.losses && first.differential === second.differential;
}

export function getTeamBattleProjection(match: TeamBattleMatch): TeamBattleProjection {
  const rounds = getEffectiveTeamBattleRounds(match);
  const playerStats = Object.fromEntries(match.players.map(({ id }) => [id, emptyPlayerStats()]));
  const opponents = Object.fromEntries(match.players.map(({ id }) => [id, new Set<string>()]));
  const grouped = new Map<string, EffectiveTeamBattleRound[]>();
  for (const round of rounds) {
    const loserId = round.playerIds.find((id) => id !== round.winnerId)!;
    const winner = playerStats[round.winnerId];
    const loser = playerStats[loserId];
    winner.wins += 1;
    loser.losses += 1;
    if (round.winType === "normal") winner.normalWins += 1;
    if (round.winType === "break_clear") winner.breakClears += 1;
    if (round.winType === "runout") winner.runouts += 1;
    for (const [playerId, count] of Object.entries(round.fouls)) playerStats[playerId].fouls += count;
    opponents[round.playerIds[0]].add(round.playerIds[1]);
    opponents[round.playerIds[1]].add(round.playerIds[0]);
    const key = teamBattlePairKey(...round.playerIds);
    grouped.set(key, [...(grouped.get(key) ?? []), round]);
  }
  for (const stats of Object.values(playerStats)) stats.differential = stats.wins - stats.losses;
  const pairs = [...grouped.entries()].map(([pairKey, pairRounds]): PairProjection => {
    const playerIds = pairRounds[0].playerIds;
    return {
      pairKey,
      players: [findPlayer(match, playerIds[0]), findPlayer(match, playerIds[1])],
      scores: { ...pairRounds.at(-1)!.after },
      rounds: pairRounds,
      lastPlayedAt: pairRounds.at(-1)!.confirmedAt,
    };
  }).sort((first, second) => (second.lastPlayedAt ?? 0) - (first.lastPlayedAt ?? 0)
    || first.players[0].joinedAt - second.players[0].joinedAt
    || first.players[1].joinedAt - second.players[1].joinedAt);
  const standings = match.players.map((player): PlayerStanding => ({
    rank: 0,
    tied: false,
    player,
    wins: playerStats[player.id].wins,
    losses: playerStats[player.id].losses,
    differential: playerStats[player.id].differential,
    opponentsPlayed: opponents[player.id].size,
  })).sort(compareTeamBattleStandings);
  standings.forEach((standing, index) => {
    standing.rank = index > 0 && sameCompetitiveStanding(standing, standings[index - 1]) ? standings[index - 1].rank : index + 1;
    standing.tied = standings.some((other) => other.player.id !== standing.player.id && sameCompetitiveStanding(standing, other));
  });
  return { rounds, pairs, standings, playerStats };
}

export function getPairProjection(match: TeamBattleMatch, firstPlayerId: string, secondPlayerId: string): PairProjection {
  const playerIds: [string, string] = [firstPlayerId, secondPlayerId];
  assertPair(match, playerIds);
  const rounds = getEffectiveTeamBattleRounds(match).filter((round) => teamBattlePairKey(...round.playerIds) === teamBattlePairKey(...playerIds));
  const scores = { [firstPlayerId]: 0, [secondPlayerId]: 0 };
  for (const round of rounds) scores[round.winnerId] += 1;
  return {
    pairKey: teamBattlePairKey(...playerIds),
    players: [findPlayer(match, firstPlayerId), findPlayer(match, secondPlayerId)],
    scores,
    rounds,
    ...(rounds.length ? { lastPlayedAt: rounds.at(-1)!.confirmedAt } : {}),
  };
}

export function getPlayerReport(match: TeamBattleMatch, playerId: string): PlayerReportProjection {
  const player = findPlayer(match, playerId);
  const projection = getTeamBattleProjection(match);
  const stats = projection.playerStats[playerId];
  return {
    player,
    wins: stats.wins,
    losses: stats.losses,
    differential: stats.differential,
    opponents: match.players.filter(({ id }) => id !== playerId).map((opponent) => {
      const pair = projection.pairs.find(({ pairKey }) => pairKey === teamBattlePairKey(playerId, opponent.id));
      return {
        opponent,
        scores: pair ? { [playerId]: pair.scores[playerId], [opponent.id]: pair.scores[opponent.id] } : { [playerId]: 0, [opponent.id]: 0 },
        played: !!pair,
        rounds: pair?.rounds ?? [],
      };
    }),
    rounds: projection.rounds.filter(({ playerIds }) => playerIds.includes(playerId)),
  };
}
