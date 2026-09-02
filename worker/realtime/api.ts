import { requireMatchRead, requireSession } from "../business/authorization";
import { scopedUuid } from "../business/api";
import type { AuthEnv } from "../auth/api";
import type { MatchRoom, RoomCommandResult, RoomMember, RoomRole } from "./match-room";
import type { ChaseScoreRule, ChaseScoreState } from "./chase-scoring";
import { hydrateEightBallState, type RealtimeEightBallState } from "./eight-ball-scoring";
import { initRoomCards, type RoomCardMode, type RoomCardState } from "./room-cards";
import { OFFICIAL_DECKS, type OfficialDeckId } from "../../src/lib/official-decks";
import { parseDeckSnapshot, type DeckRef, type DeckSnapshot } from "../../src/lib/custom-decks";
import { isSnookerMatch, isValidSnookerInitialReds, SNOOKER_MAX_REDS } from "../../src/lib/snooker";
import {
  createTeamBattleMatch,
  isTeamBattleMatch,
  TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH,
} from "../../src/lib/team-battle";
import { createRealtimeSnookerState, type RealtimeSnookerState } from "./snooker-scoring";
import type { RealtimeTeamBattleState } from "./team-battle-scoring";
import { JsonBodyError, readJsonObject } from "../http/read-json";

export type RealtimeEnv = AuthEnv & {
  MATCH_ROOM: DurableObjectNamespace<MatchRoom>;
};

class RealtimeValidationError extends Error {}

type CreateRoomStage = "route_request" | "validate_match" | "allocate_room" | "project_host" | "initialize_do" | "return_snapshot";

export type RealtimeRequestContext = {
  requestId: string;
  stage: CreateRoomStage;
  matchId?: string;
  reusedRoom: boolean;
  attempt: number;
};

export type RoomInitializationInput = {
  matchId: string;
  roomCode: string;
  host: RoomMember;
  chaseScore?: ChaseScoreState;
  eightBall?: RealtimeEightBallState;
  snooker?: RealtimeSnookerState;
  teamBattle?: RealtimeTeamBattleState;
};

type RoomInitializer<T> = {
  initialize(input: RoomInitializationInput): PromiseLike<T>;
};

class RealtimeUnavailableError extends Error {
  constructor(
    message: string,
    readonly room: { code: string; matchId: string },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RealtimeUnavailableError";
  }
}

function errorFields(error: unknown): { errorName: string; errorMessage: string } {
  if (error instanceof Error) {
    const source = error.cause instanceof Error ? error.cause : error;
    return { errorName: source.name || "Error", errorMessage: source.message || "Unknown error" };
  }
  return { errorName: "UnknownError", errorMessage: String(error) };
}

function logRealtimeFailure(
  context: RealtimeRequestContext,
  error: unknown,
  level: "warn" | "error" = "error",
  event = "realtime_api_failure",
): void {
  const fields = errorFields(error);
  console[level](JSON.stringify({
    level,
    event,
    requestId: context.requestId,
    stage: context.stage,
    ...fields,
    matchId: context.matchId,
    reusedRoom: context.reusedRoom,
    attempt: context.attempt,
  }));
}

function withRequestId(response: Response, requestId: string): Response {
  // A 101 WebSocket upgrade response must pass through untouched: it cannot be
  // reconstructed (status out of the 200-599 range and the webSocket handle
  // would be lost), which previously broke every realtime room connection.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("X-Request-Id", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function initializeRoomWithRetry<T>(
  room: RoomInitializer<T>,
  input: RoomInitializationInput,
  context: RealtimeRequestContext,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    context.attempt = attempt;
    try {
      return await room.initialize(input);
    } catch (error) {
      lastError = error;
      if (attempt === 1) {
        logRealtimeFailure(context, error, "warn", "realtime_room_initialize_retry");
        continue;
      }
    }
  }
  throw new RealtimeUnavailableError(
    "实时房间暂时不可用，请重新连接房间",
    { code: input.roomCode, matchId: input.matchId },
    { cause: lastError },
  );
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) throw new RealtimeValidationError("请求来源无效");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return await readJsonObject(request, 64 * 1024);
  } catch (error) {
    if (error instanceof JsonBodyError) throw new RealtimeValidationError(error.message);
    throw error;
  }
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new RealtimeValidationError(`${field} 无效`);
  }
  return value;
}

function operationId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new RealtimeValidationError("operationId 无效");
  }
  return value;
}

function expectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RealtimeValidationError("expectedVersion 无效");
  }
  return value;
}

type DirectDraft =
  | {
      mode: "score" | "score_cards";
      players: Array<{ name: string; initialScore: number }>;
      rules: ChaseScoreRule[];
      turnStrategy: "fixed" | "winner_stays";
      cards?: DirectCardDraft;
    }
  | {
      mode: "chinese_eight";
      players: Array<{ name: string }>;
      raceTo: number | null;
      serveRule: "alternate" | "winner";
      firstServer: 0 | 1;
      cards?: DirectCardDraft;
    }
  | {
      mode: "snooker";
      players: [{ name: string }, { name: string }];
      bestOf: number | null;
      firstStriker: 0 | 1;
      initialReds: number;
      title: string;
      location: string;
      note: string;
      cards?: DirectCardDraft;
    }
  | {
      mode: "team_battle";
      players: Array<{ name: string }>;
      title: string;
      location: string;
      note: string;
      cards?: undefined;
    };

type DirectCardDraft = {
  cardMode: Exclude<RoomCardMode, "none">;
  deckId: OfficialDeckId;
  deckRef: DeckRef;
  deckSnapshot?: DeckSnapshot;
  handSizes: number[];
};

function directCardDraft(body: Record<string, unknown>, playerCount: number): DirectCardDraft | undefined {
  const cardMode = body.cardMode ?? "none";
  if (cardMode === "none" || cardMode === undefined) return undefined;
  if (cardMode === "shared") throw new RealtimeValidationError("房间内仅支持不抽或独立手牌");
  if (cardMode !== "independent") throw new RealtimeValidationError("cardMode 无效");
  const deckId = typeof body.deckId === "string" && OFFICIAL_DECKS.some((deck) => deck.id === body.deckId)
    ? body.deckId as OfficialDeckId
    : "complete";
  const rawRef = body.deckRef;
  let deckRef: DeckRef = { kind: "official", id: "complete", version: 1 };
  if (rawRef && typeof rawRef === "object" && !Array.isArray(rawRef)) {
    const ref = rawRef as Record<string, unknown>;
    if (ref.kind === "user") {
      deckRef = { kind: "user", deckId: uuid(ref.deckId, "deckRef.deckId"), versionNo: safeInteger(ref.versionNo, -1) };
      if (deckRef.versionNo < 1) throw new RealtimeValidationError("deckRef.versionNo 无效");
    } else if (ref.kind !== "official" || ref.id !== "complete" || ref.version !== 1) {
      throw new RealtimeValidationError("deckRef 无效");
    }
  }
  const rawHandSizes = Array.isArray(body.handSizes) ? body.handSizes : [];
  if (rawHandSizes.length !== playerCount) throw new RealtimeValidationError("handSizes 无效");
  const handSizes = rawHandSizes.map((value) => safeInteger(value, -1));
  if (handSizes.some((value) => value < 0 || value > 10)) throw new RealtimeValidationError("handSizes 无效");
  return { cardMode, deckId, deckRef, handSizes };
}

async function resolveDirectDeck(env: RealtimeEnv, userId: string, cards: DirectCardDraft | undefined): Promise<void> {
  if (!cards || cards.deckRef.kind === "official") return;
  const row = await env.DB.prepare(
    `SELECT dv.snapshot_json FROM deck_versions dv JOIN decks d ON d.id = dv.deck_id
      WHERE d.id = ?1 AND d.owner_user_id = ?2 AND d.deleted_at IS NULL AND dv.version_no = ?3`,
  ).bind(cards.deckRef.deckId, userId, cards.deckRef.versionNo).first<string>("snapshot_json");
  if (!row) throw new RealtimeValidationError("牌组不存在或不属于当前账号");
  const snapshot = parseDeckSnapshot(JSON.parse(row));
  if (!snapshot) throw new RealtimeValidationError("牌组快照无效");
  cards.deckSnapshot = snapshot;
}

function directDraft(body: Record<string, unknown>): DirectDraft {
  const mode = body.mode;
  const rawPlayers = Array.isArray(body.players) ? body.players : null;
  if (!rawPlayers || rawPlayers.length < 2 || rawPlayers.length > 8) {
    throw new RealtimeValidationError("players 无效");
  }
  const players = rawPlayers.map((item): { name: string; initialScore: number } => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new RealtimeValidationError("players 无效");
    const player = item as Record<string, unknown>;
    const name = typeof player.name === "string" ? player.name.trim() : "";
    if (!name || name.length > 80) throw new RealtimeValidationError("players 无效");
    const initialScore = player.initialScore === undefined ? 0 : safeInteger(player.initialScore, -1);
    if (initialScore < 0) throw new RealtimeValidationError("players 无效");
    return { name, initialScore };
  });

  if (mode === "chinese_eight") {
    if (players.length !== 2) throw new RealtimeValidationError("中八需要 2 名选手");
    const raceTo = body.raceTo === null || body.raceTo === undefined ? null : safeInteger(body.raceTo, -1);
    if (raceTo !== null && (raceTo < 1 || raceTo > 99)) throw new RealtimeValidationError("raceTo 无效");
    const serveRule = body.serveRule === "winner" ? "winner" : "alternate";
    const firstServer = body.firstServer === 0 || body.firstServer === 1 ? body.firstServer : 0;
    return { mode, players: players.map(({ name }) => ({ name })), raceTo, serveRule, firstServer, cards: directCardDraft(body, players.length) };
  }
  if (mode === "snooker") {
    if (players.length !== 2) throw new RealtimeValidationError("斯诺克需要 2 名选手");
    const bestOf = body.bestOf === null || body.bestOf === undefined ? null : safeInteger(body.bestOf, -1);
    if (bestOf !== null && (bestOf < 1 || bestOf % 2 === 0 || bestOf > 99)) throw new RealtimeValidationError("bestOf 无效");
    const initialReds = body.initialReds === undefined ? SNOOKER_MAX_REDS : safeInteger(body.initialReds, -1);
    if (!isValidSnookerInitialReds(initialReds)) throw new RealtimeValidationError("initialReds 无效");
    const firstStriker = body.firstStriker === 0 || body.firstStriker === 1 ? body.firstStriker : 0;
    const limited = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
    return {
      mode,
      players: players.map(({ name }) => ({ name })) as [{ name: string }, { name: string }],
      bestOf,
      firstStriker,
      initialReds,
      title: limited(body.title, 40),
      location: limited(body.location, 40),
      note: limited(body.note, 120),
      cards: directCardDraft(body, 2),
    };
  }
  if (mode === "team_battle") {
    const names = players.map(({ name }) => name);
    if (names.some((name) => Array.from(name).length > TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH)
      || new Set(names).size !== names.length) {
      throw new RealtimeValidationError("players 无效");
    }
    const limited = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
    return {
      mode,
      players: players.map(({ name }) => ({ name })),
      title: limited(body.title, 40),
      location: limited(body.location, 40),
      note: limited(body.note, 120),
    };
  }
  if (mode !== "score" && mode !== "score_cards") throw new RealtimeValidationError("mode 无效");
  const rawRules = Array.isArray(body.rules) ? body.rules : null;
  const rules: ChaseScoreRule[] = (rawRules ?? [])
    .flatMap((item): ChaseScoreRule[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const rule = item as Record<string, unknown>;
      if (typeof rule.id !== "string" || !rule.id.trim() || rule.id.length > 80) return [];
      if (typeof rule.label !== "string" || !rule.label.trim() || rule.label.length > 80) return [];
      if (rule.kind !== "gain" && rule.kind !== "penalty") return [];
      const value = safeInteger(rule.value, -1);
      if (value < 0 || value > 1_000_000) return [];
      return [{ id: rule.id.trim(), label: rule.label.trim(), value, kind: rule.kind, enabled: rule.enabled !== false }];
    });
  if (!rules.length) throw new RealtimeValidationError("rules 无效");
  const turnStrategy = body.turnStrategy === "winner_stays" ? "winner_stays" : "fixed";
  return { mode, players, rules, turnStrategy, cards: directCardDraft(body, players.length) };
}

function directDraftBaseline(draft: DirectDraft, playerIds: string[], now: number, matchId: string): string {
  if (draft.mode === "team_battle") {
    const match = createTeamBattleMatch({
      playerNames: draft.players.map(({ name }) => name),
      title: draft.title,
      location: draft.location,
      note: draft.note,
    }, now);
    return JSON.stringify({
      ...match,
      id: matchId,
      players: match.players.map((player, index) => ({ ...player, id: playerIds[index] })),
    });
  }
  if (draft.mode === "snooker") {
    const state = createRealtimeSnookerState({
      playerIds: playerIds as [string, string],
      playerNames: draft.players.map(({ name }) => name) as [string, string],
      bestOf: draft.bestOf,
      firstStriker: draft.firstStriker,
      initialReds: draft.initialReds,
      title: draft.title,
      location: draft.location,
      note: draft.note,
      now,
    });
    return JSON.stringify({
      ...state.match,
      variant: draft.cards ? "trick_cards" : "standard",
      cards: draft.cards ? { cardMode: draft.cards.cardMode, deckId: draft.cards.deckId, deckSnapshot: draft.cards.deckSnapshot, handSizes: draft.cards.handSizes } : undefined,
    });
  }
  if (draft.mode === "chinese_eight") {
    return JSON.stringify({
      schemaVersion: 1,
      realtimeDraft: true,
      mode: "chinese_eight",
      players: draft.players.map((player, index) => ({ id: playerIds[index], name: player.name })),
      raceTo: draft.raceTo,
      firstServerId: playerIds[draft.firstServer],
      serveRule: draft.serveRule,
      cards: draft.cards ? { cardMode: draft.cards.cardMode, deckId: draft.cards.deckId, deckSnapshot: draft.cards.deckSnapshot, handSizes: draft.cards.handSizes } : undefined,
      startedAt: now,
      events: [],
    });
  }
  return JSON.stringify({
    schemaVersion: 1,
    realtimeDraft: true,
    mode: draft.mode,
    players: draft.players.map((player, index) => ({
      id: playerIds[index],
      name: player.name,
      initialScore: player.initialScore,
      score: player.initialScore,
      active: true,
    })),
    rules: draft.rules,
    currentPlayerId: playerIds[0],
    turnStrategy: draft.turnStrategy,
    cards: draft.cards ? { cardMode: draft.cards.cardMode, deckId: draft.cards.deckId, deckSnapshot: draft.cards.deckSnapshot, handSizes: draft.cards.handSizes } : undefined,
  });
}

async function convergePlayerName(env: RealtimeEnv, matchId: string, playerId: string, nickname: string): Promise<boolean> {
  try {
    await env.DB.prepare(
      "UPDATE match_players SET nickname_snapshot = ?1 WHERE id = ?2 AND match_id = ?3",
    ).bind(nickname, playerId, matchId).run();
    const row = await env.DB.prepare(
      "SELECT snapshot_json FROM matches WHERE id = ?1",
    ).bind(matchId).first<{ snapshot_json: string | null }>();
    if (row?.snapshot_json) {
      const snapshot: unknown = JSON.parse(row.snapshot_json);
      if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
        const record = snapshot as Record<string, unknown>;
        const players = Array.isArray(record.players) ? record.players : [];
        const rows = await env.DB.prepare(
          "SELECT id FROM match_players WHERE match_id = ?1 AND role != 'spectator' ORDER BY seat_no",
        ).bind(matchId).all<{ id: string }>();
        const playerIndex = rows.results.slice(0, players.length).findIndex((player) => player.id === playerId);
        const nextPlayers = players.map((player, index) => {
          if (!player || typeof player !== "object" || Array.isArray(player)) return player;
          const item = player as Record<string, unknown>;
          return item.id === playerId || index === playerIndex ? { ...item, name: nickname } : item;
        });
        await env.DB.prepare(
          "UPDATE matches SET snapshot_json = ?1, updated_at = ?2 WHERE id = ?3",
        ).bind(JSON.stringify({ ...record, players: nextPlayers }), Date.now(), matchId).run();
      }
    }
    return true;
  } catch {
    return false;
  }
}

function commandResponse(result: RoomCommandResult, successStatus = 200): Response {
  if (result.ok) return json(result, result.duplicate ? 200 : successStatus);
  if (result.code === "forbidden") return json({ error: "无权执行此房间操作" }, 403);
  if (result.code === "not_found") return json({ error: "房间成员不存在" }, 404);
  if (result.code === "version_conflict") {
    return json({ error: "房间版本冲突，请刷新后重试", currentVersion: result.currentVersion }, 409);
  }
  if (result.code === "not_initialized") return json({ error: "实时房间尚未初始化" }, 409);
  return json({ error: "房间命令无效" }, 400);
}

function createRoomCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

async function allocateRoom(env: RealtimeEnv, matchId: string, now: number): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const roomCode = createRoomCode();
    try {
      await env.DB.prepare(
        "INSERT INTO realtime_rooms (match_id, room_code, status, created_at, updated_at) VALUES (?1, ?2, 'draft', ?3, ?3)",
      ).bind(matchId, roomCode, now).run();
      return roomCode;
    } catch (error) {
      const message = String(error).toLowerCase();
      if (message.includes("unique")) {
        // A concurrent direct-create with the same operationId may have already
        // allocated this room: reuse it instead of spinning on the PK conflict.
        const existing = await env.DB.prepare(
          "SELECT room_code FROM realtime_rooms WHERE match_id = ?1",
        ).bind(matchId).first<string>("room_code");
        if (existing) return existing;
        if (attempt === 7) throw error;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Unable to allocate room code");
}

function safeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000 ? value : fallback;
}

function loadDraftCards(snapshot: Record<string, unknown> | undefined, playerIds: string[], game: "chinese_eight" | "snooker" = "chinese_eight"): RoomCardState | undefined {
  const raw = snapshot?.cards;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const cards = raw as Record<string, unknown>;
  if (cards.cardMode !== "independent") return undefined;
  const handSizes = Array.isArray(cards.handSizes) ? cards.handSizes.map((value) => safeInteger(value, -1)) : [];
  if (handSizes.length !== playerIds.length || handSizes.some((value) => value < 0 || value > 10)) return undefined;
  const deckId = typeof cards.deckId === "string" && OFFICIAL_DECKS.some((deck) => deck.id === cards.deckId)
    ? cards.deckId as OfficialDeckId
    : "complete";
  const deckSnapshot = cards.deckSnapshot && typeof cards.deckSnapshot === "object" && !Array.isArray(cards.deckSnapshot)
    ? cards.deckSnapshot as unknown as DeckSnapshot
    : undefined;
  return initRoomCards({ deckId, deckSnapshot, playerIds, handSizes, game });
}

async function loadChaseScoreState(env: RealtimeEnv, matchId: string): Promise<ChaseScoreState | undefined> {
  const match = await env.DB.prepare(
    "SELECT mode, snapshot_json FROM matches WHERE id = ?1",
  ).bind(matchId).first<{ mode: string; snapshot_json: string | null }>();
  if (!match || (match.mode !== "score" && match.mode !== "score_cards")) return undefined;
  const rows = await env.DB.prepare(
    `SELECT id, nickname_snapshot, user_id, left_at FROM match_players
      WHERE match_id = ?1 AND role != 'spectator' ORDER BY seat_no`,
  ).bind(matchId).all<{ id: string; nickname_snapshot: string; user_id: string | null; left_at: number | null }>();

  let snapshot: Record<string, unknown> | undefined;
  if (match.snapshot_json) {
    try {
      const parsed: unknown = JSON.parse(match.snapshot_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) snapshot = parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  const snapshotPlayers = Array.isArray(snapshot?.players) ? snapshot.players : [];
  const playerCount = snapshotPlayers.length || rows.results.length;
  if (playerCount < 2 || rows.results.length < playerCount) return undefined;

  const localIdToStableId = new Map<string, string>();
  const players = rows.results.slice(0, playerCount).map((row, index) => {
    const source = snapshotPlayers[index] && typeof snapshotPlayers[index] === "object" && !Array.isArray(snapshotPlayers[index])
      ? snapshotPlayers[index] as Record<string, unknown>
      : {};
    if (typeof source.id === "string") localIdToStableId.set(source.id, row.id);
    const initialScore = safeInteger(source.initialScore, 0);
    return {
      id: row.id,
      nickname: typeof source.name === "string" && source.name.trim() ? source.name.trim().slice(0, 80) : row.nickname_snapshot,
      ...(row.user_id ? { userId: row.user_id } : {}),
      initialScore,
      score: safeInteger(source.score, initialScore),
      active: typeof source.active === "boolean" ? source.active : row.left_at === null,
    };
  });
  if (players.filter((player) => player.active).length < 2) return undefined;

  const rules: ChaseScoreRule[] = (Array.isArray(snapshot?.rules) ? snapshot.rules : [])
    .flatMap((item): ChaseScoreRule[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const rule = item as Record<string, unknown>;
      if (typeof rule.id !== "string" || !rule.id.trim() || rule.id.length > 80) return [];
      if (typeof rule.label !== "string" || !rule.label.trim() || rule.label.length > 80) return [];
      if (rule.kind !== "gain" && rule.kind !== "penalty") return [];
      const value = safeInteger(rule.value, -1);
      if (value < 0 || value > 1_000_000) return [];
      return [{ id: rule.id, label: rule.label.trim(), value, kind: rule.kind, enabled: rule.enabled !== false }];
    });
  if (!rules.length) return undefined;
  const snapshotCurrentPlayerId = typeof snapshot?.currentPlayerId === "string"
    ? localIdToStableId.get(snapshot.currentPlayerId)
    : undefined;
  const currentPlayerId = players.some((player) => player.id === snapshotCurrentPlayerId && player.active)
    ? snapshotCurrentPlayerId!
    : players.find((player) => player.active)!.id;
  return {
    mode: match.mode,
    players,
    rules,
    currentPlayerId,
    turnStrategy: snapshot?.turnStrategy === "winner_stays" ? "winner_stays" : "fixed",
    cards: loadDraftCards(snapshot, players.map((player) => player.id)),
  };
}

async function loadEightBallState(env: RealtimeEnv, matchId: string): Promise<RealtimeEightBallState | undefined> {
  const match = await env.DB.prepare(
    "SELECT mode, snapshot_json FROM matches WHERE id = ?1",
  ).bind(matchId).first<{ mode: string; snapshot_json: string | null }>();
  if (!match || match.mode !== "chinese_eight" || !match.snapshot_json) return undefined;
  let snapshot: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(match.snapshot_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    snapshot = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const rows = await env.DB.prepare(
    `SELECT id, nickname_snapshot, user_id FROM match_players
      WHERE match_id = ?1 AND role != 'spectator' ORDER BY seat_no LIMIT 2`,
  ).bind(matchId).all<{ id: string; nickname_snapshot: string; user_id: string | null }>();
  if (rows.results.length !== 2) return undefined;
  const state = hydrateEightBallState(snapshot, [
    { id: rows.results[0].id, nickname: rows.results[0].nickname_snapshot },
    { id: rows.results[1].id, nickname: rows.results[1].nickname_snapshot },
  ]);
  if (state) state.cards = loadDraftCards(snapshot, state.players.map((player) => player.id));
  if (state) {
    state.players = state.players.map((player, index) => ({
      ...player,
      ...(rows.results[index].user_id ? { userId: rows.results[index].user_id! } : {}),
    })) as typeof state.players;
  }
  return state;
}

async function loadSnookerState(env: RealtimeEnv, matchId: string): Promise<RealtimeSnookerState | undefined> {
  const row = await env.DB.prepare(
    "SELECT mode, snapshot_json FROM matches WHERE id = ?1",
  ).bind(matchId).first<{ mode: string; snapshot_json: string | null }>();
  if (!row || row.mode !== "snooker" || !row.snapshot_json) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(row.snapshot_json); } catch { return undefined; }
  if (!isSnookerMatch(parsed)) return undefined;
  const seats = await env.DB.prepare(
    `SELECT id, nickname_snapshot, user_id FROM match_players
      WHERE match_id = ?1 AND role != 'spectator' ORDER BY seat_no LIMIT 2`,
  ).bind(matchId).all<{ id: string; nickname_snapshot: string; user_id: string | null }>();
  if (seats.results.length !== 2 || seats.results.some((seat, index) => seat.id !== parsed.players[index].id)) return undefined;
  return {
    mode: "snooker",
    match: parsed,
    players: parsed.players.map((player, index) => ({
      id: player.id,
      nickname: player.name || seats.results[index].nickname_snapshot,
      ...(seats.results[index].user_id ? { userId: seats.results[index].user_id! } : {}),
    })) as RealtimeSnookerState["players"],
    cards: loadDraftCards(parsed as unknown as Record<string, unknown>, parsed.players.map(({ id }) => id), "snooker"),
  };
}

async function loadTeamBattleState(env: RealtimeEnv, matchId: string): Promise<RealtimeTeamBattleState | undefined> {
  const row = await env.DB.prepare(
    "SELECT mode, snapshot_json FROM matches WHERE id = ?1",
  ).bind(matchId).first<{ mode: string; snapshot_json: string | null }>();
  if (!row || row.mode !== "team_battle" || !row.snapshot_json) return undefined;
  let match: unknown;
  try { match = JSON.parse(row.snapshot_json); } catch { return undefined; }
  if (!isTeamBattleMatch(match) || match.status !== "active") return undefined;
  const seats = await env.DB.prepare(
    `SELECT id, user_id FROM match_players
      WHERE match_id = ?1 AND role = 'player' ORDER BY seat_no LIMIT 8`,
  ).bind(matchId).all<{ id: string; user_id: string | null }>();
  if (seats.results.length < match.players.length
    || match.players.some((player, index) => seats.results[index]?.id !== player.id)) return undefined;
  return {
    mode: "team_battle",
    match,
    seats: seats.results.slice(0, match.players.length).map((seat) => ({
      playerId: seat.id,
      ...(seat.user_id ? { userId: seat.user_id } : {}),
    })),
    currentPairIds: [match.players[0].id, match.players[1].id],
  };
}

async function ensureHostPlayer(env: RealtimeEnv, matchId: string, userId: string, nickname: string, now: number): Promise<void> {
  const hostPlayer = await env.DB.prepare(
    "SELECT id FROM match_players WHERE match_id = ?1 AND user_id = ?2 AND left_at IS NULL LIMIT 1",
  ).bind(matchId, userId).first<string>("id");
  if (hostPlayer) {
    await env.DB.prepare("UPDATE match_players SET role = 'host', nickname_snapshot = ?2 WHERE id = ?1").bind(hostPlayer, nickname).run();
    return;
  }
  const seatNo = await env.DB.prepare(
    "SELECT COALESCE(MAX(seat_no), -1) + 1 AS seat_no FROM match_players WHERE match_id = ?1",
  ).bind(matchId).first<number>("seat_no") ?? 0;
  await env.DB.prepare(
    `INSERT INTO match_players (id, match_id, seat_no, user_id, role, nickname_snapshot, joined_at)
     VALUES (?1, ?2, ?3, ?4, 'host', ?5, ?6)`,
  ).bind(crypto.randomUUID(), matchId, seatNo, userId, nickname, now).run();
}

async function createRoom(request: Request, env: RealtimeEnv, context: RealtimeRequestContext): Promise<Response> {
  context.stage = "validate_match";
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const matchId = uuid(body.matchId, "matchId");
  context.matchId = matchId;
  const match = await requireMatchRead(env, session, matchId);
  if (match.owner_user_id !== session.user.id) return json({ error: "只有对局房主可以创建实时房间" }, 403);
  if (match.status === "completed" || match.status === "cancelled") return json({ error: "已结束的对局不能创建实时房间" }, 409);

  context.stage = "allocate_room";
  const existing = await env.DB.prepare(
    "SELECT room_code, status FROM realtime_rooms WHERE match_id = ?1",
  ).bind(matchId).first<{ room_code: string; status: string }>();
  if (existing) {
    context.reusedRoom = true;
    const now = Date.now();
    context.stage = "project_host";
    const [chaseScore, eightBall, snooker, teamBattle] = await Promise.all([
      loadChaseScoreState(env, matchId),
      loadEightBallState(env, matchId),
      loadSnookerState(env, matchId),
      loadTeamBattleState(env, matchId),
    ]);
    const hostNickname = session.user.nickname;
    await ensureHostPlayer(env, matchId, session.user.id, hostNickname, now);
    context.stage = "initialize_do";
    const snapshot = await initializeRoomWithRetry(env.MATCH_ROOM.getByName(matchId), {
      matchId,
      roomCode: existing.room_code,
      host: { userId: session.user.id, nickname: hostNickname, role: "host", joinedAt: now },
      chaseScore,
      eightBall,
      snooker,
      teamBattle,
    }, context);
    context.stage = "return_snapshot";
    return json({ room: { code: existing.room_code, matchId, status: existing.status }, snapshot });
  }

  const now = Date.now();
  let roomCode = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    context.attempt = attempt + 1;
    roomCode = createRoomCode();
    try {
      await env.DB.prepare(
        "INSERT INTO realtime_rooms (match_id, room_code, status, created_at, updated_at) VALUES (?1, ?2, 'draft', ?3, ?3)",
      ).bind(matchId, roomCode, now).run();
      break;
    } catch (error) {
      if (!String(error).toLowerCase().includes("unique")) throw error;
      if (attempt === 7) throw error;
      roomCode = "";
    }
  }
  if (!roomCode) throw new Error("Unable to allocate room code");

  context.stage = "project_host";
  const [chaseScore, eightBall, snooker, teamBattle] = await Promise.all([
    loadChaseScoreState(env, matchId),
    loadEightBallState(env, matchId),
    loadSnookerState(env, matchId),
    loadTeamBattleState(env, matchId),
  ]);
  const hostNickname = session.user.nickname;
  await ensureHostPlayer(env, matchId, session.user.id, hostNickname, now);

  context.stage = "initialize_do";
  const snapshot = await initializeRoomWithRetry(env.MATCH_ROOM.getByName(matchId), {
    matchId,
    roomCode,
    host: { userId: session.user.id, nickname: hostNickname, role: "host", joinedAt: now },
    chaseScore,
    eightBall,
    snooker,
    teamBattle,
  }, context);
  context.stage = "return_snapshot";
  return json({ room: { code: roomCode, matchId, status: "draft" }, snapshot }, 201);
}

async function createDirectRoom(request: Request, env: RealtimeEnv, context: RealtimeRequestContext): Promise<Response> {
  context.stage = "validate_match";
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const requestOperationId = operationId(body.operationId);
  const draft = directDraft(body);
  await resolveDirectDeck(env, session.user.id, draft.cards);
  const matchId = await scopedUuid("hei8-direct-room", `${session.user.id}:${requestOperationId}`);
  context.matchId = matchId;

  const existing = await env.DB.prepare(
    "SELECT id, mode, status FROM matches WHERE id = ?1 AND owner_user_id = ?2",
  ).bind(matchId, session.user.id).first<{ id: string; mode: string; status: string }>();
  const now = Date.now();

  const converge = async (roomCode: string, reused: boolean): Promise<Response> => {
    context.stage = "project_host";
    const [chaseScore, eightBall, snooker, teamBattle] = await Promise.all([
      loadChaseScoreState(env, matchId),
      loadEightBallState(env, matchId),
      loadSnookerState(env, matchId),
      loadTeamBattleState(env, matchId),
    ]);
    const hostNickname = session.user.nickname;
    const host = { userId: session.user.id, nickname: hostNickname, role: "host" as const, joinedAt: now };
    await ensureHostPlayer(env, matchId, session.user.id, hostNickname, now);
    context.stage = "initialize_do";
    const snapshot = await initializeRoomWithRetry(env.MATCH_ROOM.getByName(matchId), {
      matchId,
      roomCode,
      host,
      chaseScore,
      eightBall,
      snooker,
      teamBattle,
    }, context);
    context.stage = "return_snapshot";
    const room = { code: roomCode, matchId, status: existing?.status ?? "draft" };
    return json({ matchId, room, host, snapshot, reused }, reused ? 200 : 201);
  };

  if (existing) {
    context.reusedRoom = true;
    context.stage = "allocate_room";
    const room = await env.DB.prepare(
      "SELECT room_code, status FROM realtime_rooms WHERE match_id = ?1",
    ).bind(matchId).first<{ room_code: string; status: string }>();
    const roomCode = room?.room_code ?? await allocateRoom(env, matchId, now);
    return converge(roomCode, true);
  }

  // Fresh creation: write the match and the temporary draft players + host
  // member in one atomic batch first (the room row references the match), then
  // allocate the room code and initialize the Durable Object. A retry with the
  // same operationId finds the same deterministic matchId and reuses every
  // resource instead of duplicating them.
  context.stage = "allocate_room";
  const stablePlayerIds = draft.players.map(() => crypto.randomUUID());
  const statements = [
    env.DB.prepare(
      `INSERT INTO matches (id, owner_user_id, mode, status, privacy, version, snapshot_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'draft', 'private', 0, ?4, ?5, ?5)`,
    ).bind(matchId, session.user.id, draft.mode, directDraftBaseline(draft, stablePlayerIds, now, matchId), now),
  ];
  draft.players.forEach((player, index) => {
    statements.push(env.DB.prepare(
      `INSERT INTO match_players (id, match_id, seat_no, user_id, role, nickname_snapshot, joined_at)
       VALUES (?1, ?2, ?3, NULL, 'player', ?4, ?5)`,
    ).bind(stablePlayerIds[index], matchId, index, player.name, now));
  });
  statements.push(env.DB.prepare(
    `INSERT INTO match_players (id, match_id, seat_no, user_id, role, nickname_snapshot, joined_at)
     VALUES (?1, ?2, ?3, ?4, 'host', ?5, ?6)`,
  ).bind(crypto.randomUUID(), matchId, draft.players.length, session.user.id, draft.players[0].name, now));

  try {
    await env.DB.batch(statements);
  } catch (error) {
    // A concurrent retry with the same operationId may have won the batch;
    // reuse its resources instead of surfacing a constraint error.
    const raced = await env.DB.prepare(
      "SELECT id, mode, status FROM matches WHERE id = ?1 AND owner_user_id = ?2",
    ).bind(matchId, session.user.id).first<{ id: string; mode: string; status: string }>();
    if (!raced) throw error;
    context.reusedRoom = true;
    const room = await env.DB.prepare(
      "SELECT room_code, status FROM realtime_rooms WHERE match_id = ?1",
    ).bind(matchId).first<{ room_code: string; status: string }>();
    const racedRoomCode = room?.room_code ?? await allocateRoom(env, matchId, now);
    return converge(racedRoomCode, true);
  }
  const roomCode = await allocateRoom(env, matchId, now);
  return converge(roomCode, false);
}

async function getRoom(request: Request, env: RealtimeEnv, roomCode: string): Promise<Response> {
  const session = await requireSession(env, request);
  const room = await env.DB.prepare(
    "SELECT match_id, room_code, status FROM realtime_rooms WHERE room_code = ?1",
  ).bind(roomCode).first<{ match_id: string; room_code: string; status: string }>();
  if (!room) return json({ error: "房间不存在" }, 404);
  const match = await requireMatchRead(env, session, room.match_id);
  const memberRole = await env.DB.prepare(
    "SELECT role FROM match_players WHERE match_id = ?1 AND user_id = ?2 AND left_at IS NULL ORDER BY joined_at LIMIT 1",
  ).bind(room.match_id, session.user.id).first<RoomRole>("role");
  const role: RoomRole = match.owner_user_id === session.user.id ? "host" : memberRole ?? "spectator";
  const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
  const [snapshot, kickedRows] = await Promise.all([
    env.MATCH_ROOM.getByName(room.match_id).getSnapshotFor({ userId: session.user.id, role }, Number.isSafeInteger(after) ? after : 0),
    env.DB.prepare(
      `SELECT user_id, nickname_snapshot, kicked_at FROM match_players
        WHERE match_id = ?1 AND kicked_at IS NOT NULL AND user_id IS NOT NULL ORDER BY kicked_at DESC`,
    ).bind(room.match_id).all<{ user_id: string; nickname_snapshot: string; kicked_at: number }>(),
  ]);
  return json({
    room: { code: room.room_code, matchId: room.match_id, status: room.status },
    snapshot,
    kicked: kickedRows.results.map((row) => ({ userId: row.user_id, nickname: row.nickname_snapshot, kickedAt: row.kicked_at })),
  });
}

async function joinRoom(request: Request, env: RealtimeEnv, roomCode: string): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const requestOperationId = operationId(body.operationId);
  const room = await env.DB.prepare(
    `SELECT rr.match_id, rr.status, m.status AS match_status
       FROM realtime_rooms rr JOIN matches m ON m.id = rr.match_id
      WHERE rr.room_code = ?1`,
  ).bind(roomCode).first<{ match_id: string; status: string; match_status: string }>();
  if (!room) return json({ error: "房间不存在" }, 404);
  if (room.status === "completed" || room.status === "archiving_failed" || room.match_status === "completed" || room.match_status === "cancelled") {
    return json({ error: "房间已结束或正在归档，不能加入" }, 409);
  }

  const now = Date.now();
  const existing = await env.DB.prepare(
    `SELECT id, role, left_at, kicked_at FROM match_players
      WHERE match_id = ?1 AND user_id = ?2 ORDER BY joined_at DESC LIMIT 1`,
  ).bind(room.match_id, session.user.id).first<{ id: string; role: RoomRole; left_at: number | null; kicked_at: number | null }>();
  if (existing?.kicked_at !== null && existing?.kicked_at !== undefined) {
    return json({ error: "你已被移出房间，需房主解除限制后才能重新加入" }, 403);
  }
  let role: RoomRole = "spectator";
  if (existing) {
    role = existing.left_at === null ? existing.role : "spectator";
    if (existing.left_at !== null) {
      await env.DB.prepare(
        "UPDATE match_players SET role = 'spectator', nickname_snapshot = ?1, joined_at = ?2, left_at = NULL WHERE id = ?3",
      ).bind(session.user.nickname, now, existing.id).run();
    }
  } else {
    const seatNo = await env.DB.prepare(
      "SELECT COALESCE(MAX(seat_no), -1) + 1 AS seat_no FROM match_players WHERE match_id = ?1",
    ).bind(room.match_id).first<number>("seat_no") ?? 0;
    await env.DB.prepare(
      `INSERT INTO match_players (id, match_id, seat_no, user_id, role, nickname_snapshot, joined_at)
       VALUES (?1, ?2, ?3, ?4, 'spectator', ?5, ?6)`,
    ).bind(crypto.randomUUID(), room.match_id, seatNo, session.user.id, session.user.nickname, now).run();
  }

  const result = await env.MATCH_ROOM.getByName(room.match_id).addMember({
    operationId: requestOperationId,
    userId: session.user.id,
    nickname: session.user.nickname,
    role,
    joinedAt: now,
  });
  if (!result.ok) return commandResponse(result, 201);
  const snapshot = await env.MATCH_ROOM.getByName(room.match_id).getSnapshotFor({ userId: session.user.id, role });
  return json({ ...result, room: { code: roomCode, matchId: room.match_id }, role, snapshot }, result.duplicate ? 200 : 201);
}

async function assignMemberRole(
  request: Request,
  env: RealtimeEnv,
  roomCode: string,
  targetUserId: string,
  context: RealtimeRequestContext,
): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const requestOperationId = operationId(body.operationId);
  const version = expectedVersion(body.expectedVersion);
  if (body.role !== "player" && body.role !== "spectator") throw new RealtimeValidationError("role 无效");
  const room = await env.DB.prepare(
    "SELECT rr.match_id, m.owner_user_id FROM realtime_rooms rr JOIN matches m ON m.id = rr.match_id WHERE rr.room_code = ?1",
  ).bind(roomCode).first<{ match_id: string; owner_user_id: string }>();
  if (!room) return json({ error: "房间不存在" }, 404);
  if (room.owner_user_id !== session.user.id) return json({ error: "只有房主可以调整成员角色" }, 403);

  const result = await env.MATCH_ROOM.getByName(room.match_id).assignRole({
    operationId: requestOperationId,
    expectedVersion: version,
    actorUserId: session.user.id,
    targetUserId,
    role: body.role,
  });
  if (!result.ok) return commandResponse(result);
  // The D1 member projection must converge with the Durable Object role. A
  // transient projection failure returns a retryable 503: the same operation_id
  // makes the idempotent DO command report a duplicate while the D1 write is
  // retried, so DO, D1 and every client converge instead of diverging forever.
  const converged = async (): Promise<boolean> => {
    try {
      await env.DB.prepare(
        "UPDATE match_players SET role = ?1 WHERE match_id = ?2 AND user_id = ?3 AND left_at IS NULL AND role != 'host'",
      ).bind(body.role, room.match_id, targetUserId).run();
      const projected = await env.DB.prepare(
        "SELECT role FROM match_players WHERE match_id = ?1 AND user_id = ?2 AND left_at IS NULL AND role != 'host'",
      ).bind(room.match_id, targetUserId).first<string>("role");
      return projected === body.role;
    } catch {
      return false;
    }
  };
  if (!(await converged())) {
    return json({
      error: "角色已切换，云端成员状态正在同步；请重试",
      requestId: context.requestId,
      retryable: true,
      operationId: requestOperationId,
      room: { code: roomCode, matchId: room.match_id },
    }, 503);
  }
  return commandResponse(result);
}

async function kickMember(
  request: Request,
  env: RealtimeEnv,
  roomCode: string,
  targetUserId: string,
  context: RealtimeRequestContext,
): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const requestOperationId = operationId(body.operationId);
  const version = expectedVersion(body.expectedVersion);
  const room = await env.DB.prepare(
    "SELECT rr.match_id, m.owner_user_id FROM realtime_rooms rr JOIN matches m ON m.id = rr.match_id WHERE rr.room_code = ?1",
  ).bind(roomCode).first<{ match_id: string; owner_user_id: string }>();
  if (!room) return json({ error: "房间不存在" }, 404);
  if (room.owner_user_id !== session.user.id) return json({ error: "只有房主可以踢出成员" }, 403);

  const result = await env.MATCH_ROOM.getByName(room.match_id).kickMember({
    operationId: requestOperationId,
    expectedVersion: version,
    actorUserId: session.user.id,
    targetUserId,
  });
  if (!result.ok) return commandResponse(result);

  // The D1 member projection must converge with the Durable Object kick: the
  // member is banned from rejoining with the same room code until the host
  // lifts the restriction. A transient projection failure returns a retryable
  // 503; the same operation_id makes the idempotent DO command report a
  // duplicate while the D1 write is retried. left_at alone must not be reused
  // as the kick state: a voluntary leave still allows rejoin, so the ban is
  // recorded explicitly even when the member already left.
  const converged = async (): Promise<boolean> => {
    try {
      const now = Date.now();
      await env.DB.prepare(
        `UPDATE match_players
            SET kicked_at = ?1, kicked_by_user_id = ?2, left_at = COALESCE(left_at, ?1)
          WHERE match_id = ?3 AND user_id = ?4 AND role != 'host'`,
      ).bind(now, session.user.id, room.match_id, targetUserId).run();
      const projected = await env.DB.prepare(
        "SELECT kicked_at FROM match_players WHERE match_id = ?1 AND user_id = ?2 AND kicked_at IS NOT NULL AND role != 'host'",
      ).bind(room.match_id, targetUserId).first<number>("kicked_at");
      return projected !== null;
    } catch {
      return false;
    }
  };
  if (!(await converged())) {
    return json({
      error: "成员已移出，云端状态正在同步；请重试",
      requestId: context.requestId,
      retryable: true,
      operationId: requestOperationId,
      room: { code: roomCode, matchId: room.match_id },
    }, 503);
  }
  return commandResponse(result);
}

async function liftKick(request: Request, env: RealtimeEnv, roomCode: string, targetUserId: string): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const room = await env.DB.prepare(
    "SELECT rr.match_id, m.owner_user_id FROM realtime_rooms rr JOIN matches m ON m.id = rr.match_id WHERE rr.room_code = ?1",
  ).bind(roomCode).first<{ match_id: string; owner_user_id: string }>();
  if (!room) return json({ error: "房间不存在" }, 404);
  if (room.owner_user_id !== session.user.id) return json({ error: "只有房主可以解除限制" }, 403);
  await env.DB.prepare(
    "UPDATE match_players SET kicked_at = NULL, kicked_by_user_id = NULL WHERE match_id = ?1 AND user_id = ?2 AND role != 'host'",
  ).bind(room.match_id, targetUserId).run();
  return json({ ok: true, userId: targetUserId });
}

async function removePlayer(
  request: Request,
  env: RealtimeEnv,
  roomCode: string,
  playerId: string,
  context: RealtimeRequestContext,
): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const requestOperationId = operationId(body.operationId);
  const version = expectedVersion(body.expectedVersion);
  const room = await env.DB.prepare(
    "SELECT rr.match_id, m.owner_user_id FROM realtime_rooms rr JOIN matches m ON m.id = rr.match_id WHERE rr.room_code = ?1",
  ).bind(roomCode).first<{ match_id: string; owner_user_id: string }>();
  if (!room) return json({ error: "房间不存在" }, 404);
  if (room.owner_user_id !== session.user.id) return json({ error: "只有房主可以移除临时选手" }, 403);

  const result = await env.MATCH_ROOM.getByName(room.match_id).removePlayer({
    operationId: requestOperationId,
    expectedVersion: version,
    actorUserId: session.user.id,
    playerId,
  });
  if (!result.ok) return commandResponse(result);

  // Converge the D1 seat projection: a seat removed without scoring history is
  // deleted outright; a seat with history is only marked left so the append-only
  // ledger and its score attribution stay intact.
  const converged = async (): Promise<boolean> => {
    try {
      if (result.event.kind === "player.removed") {
        await env.DB.prepare(
          "DELETE FROM match_players WHERE id = ?1 AND match_id = ?2 AND user_id IS NULL AND left_at IS NULL",
        ).bind(playerId, room.match_id).run();
      } else {
        await env.DB.prepare(
          "UPDATE match_players SET left_at = ?1 WHERE id = ?2 AND match_id = ?3 AND left_at IS NULL",
        ).bind(Date.now(), playerId, room.match_id).run();
      }
      return true;
    } catch {
      return false;
    }
  };
  if (!(await converged())) {
    return json({
      error: "选手已移除，云端状态正在同步；请重试",
      requestId: context.requestId,
      retryable: true,
      operationId: requestOperationId,
      room: { code: roomCode, matchId: room.match_id },
    }, 503);
  }
  return commandResponse(result);
}

async function claimSeat(
  request: Request,
  env: RealtimeEnv,
  roomCode: string,
  playerId: string,
  context: RealtimeRequestContext,
): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const requestOperationId = operationId(body.operationId);
  const version = expectedVersion(body.expectedVersion);
  const targetUserId = uuid(body.userId, "userId");
  const room = await env.DB.prepare(
    "SELECT rr.match_id, m.owner_user_id FROM realtime_rooms rr JOIN matches m ON m.id = rr.match_id WHERE rr.room_code = ?1",
  ).bind(roomCode).first<{ match_id: string; owner_user_id: string }>();
  if (!room) return json({ error: "房间不存在" }, 404);
  if (room.owner_user_id !== session.user.id) return json({ error: "只有房主可以把席位绑定到成员" }, 403);

  const result = await env.MATCH_ROOM.getByName(room.match_id).claimSeat({
    operationId: requestOperationId,
    expectedVersion: version,
    actorUserId: session.user.id,
    playerId,
    targetUserId,
  });
  if (!result.ok) return commandResponse(result);

  // Converge the D1 seat projection: persist the claimed display name so the
  // archived record and any D1-based rebuild keep the registered nickname.
  // The seat row deliberately stays user_id NULL (a temporary seat): binding
  // user_id here would break the host's later "remove without history" path.
  const nickname = result.event.payload.nickname;
  if (typeof nickname === "string" && nickname && !(await convergePlayerName(env, room.match_id, playerId, nickname))) {
    return json({
      error: "席位已绑定，云端归档状态正在同步；请重试",
      requestId: context.requestId,
      retryable: true,
      operationId: requestOperationId,
      room: { code: roomCode, matchId: room.match_id },
    }, 503);
  }
  return commandResponse(result);
}

async function renameSeat(
  request: Request,
  env: RealtimeEnv,
  roomCode: string,
  playerId: string,
  context: RealtimeRequestContext,
): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const requestOperationId = operationId(body.operationId);
  const version = expectedVersion(body.expectedVersion);
  const nickname = typeof body.nickname === "string" ? body.nickname.trim().slice(0, 80) : "";
  if (!nickname) throw new RealtimeValidationError("nickname 无效");
  const room = await env.DB.prepare(
    "SELECT rr.match_id, m.owner_user_id FROM realtime_rooms rr JOIN matches m ON m.id = rr.match_id WHERE rr.room_code = ?1",
  ).bind(roomCode).first<{ match_id: string; owner_user_id: string }>();
  if (!room) return json({ error: "房间不存在" }, 404);
  if (room.owner_user_id !== session.user.id) return json({ error: "只有房主可以修改临时席位名称" }, 403);

  const result = await env.MATCH_ROOM.getByName(room.match_id).renameSeat({
    operationId: requestOperationId,
    expectedVersion: version,
    actorUserId: session.user.id,
    playerId,
    nickname,
  });
  if (!result.ok) return commandResponse(result);
  const eventNickname = result.event.payload.nickname;
  if (typeof eventNickname === "string" && eventNickname && !(await convergePlayerName(env, room.match_id, playerId, eventNickname))) {
    return json({
      error: "席位已改名，云端归档状态正在同步；请重试",
      requestId: context.requestId,
      retryable: true,
      operationId: requestOperationId,
      room: { code: roomCode, matchId: room.match_id },
    }, 503);
  }
  return commandResponse(result);
}

async function listMyRooms(request: Request, env: RealtimeEnv): Promise<Response> {
  const session = await requireSession(env, request);
  // Match-level membership projection: the current user is host or player of an
  // ongoing cloud room. Spectators stay room-level and never appear here.
  const result = await env.DB.prepare(
    `SELECT rr.match_id AS matchId, rr.room_code AS roomCode, rr.status AS roomStatus,
            m.mode, m.status AS matchStatus, m.created_at AS createdAt, m.started_at AS startedAt,
            mp.role AS myRole
       FROM realtime_rooms rr
       JOIN matches m ON m.id = rr.match_id
       JOIN match_players mp ON mp.match_id = rr.match_id AND mp.user_id = ?1 AND mp.left_at IS NULL
      WHERE rr.status IN ('draft', 'active')
        AND m.status IN ('draft', 'active')
        AND mp.role IN ('host', 'player')
      ORDER BY rr.updated_at DESC`,
  ).bind(session.user.id).all();
  return json({ rooms: result.results });
}

async function leaveRoom(request: Request, env: RealtimeEnv, roomCode: string): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const requestOperationId = operationId(body.operationId);
  const version = expectedVersion(body.expectedVersion);
  const room = await env.DB.prepare(
    "SELECT match_id FROM realtime_rooms WHERE room_code = ?1",
  ).bind(roomCode).first<{ match_id: string }>();
  if (!room) return json({ error: "房间不存在" }, 404);

  const result = await env.MATCH_ROOM.getByName(room.match_id).leave({
    operationId: requestOperationId,
    expectedVersion: version,
    actorUserId: session.user.id,
  });
  if (!result.ok) return commandResponse(result);
  await env.DB.prepare(
    "UPDATE match_players SET left_at = ?1 WHERE match_id = ?2 AND user_id = ?3 AND left_at IS NULL AND role != 'host'",
  ).bind(Date.now(), room.match_id, session.user.id).run();
  return commandResponse(result);
}

async function completeRoom(request: Request, env: RealtimeEnv, roomCode: string): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const requestOperationId = operationId(body.operationId);
  const version = expectedVersion(body.expectedVersion);
  const room = await env.DB.prepare(
    "SELECT rr.match_id, m.owner_user_id FROM realtime_rooms rr JOIN matches m ON m.id = rr.match_id WHERE rr.room_code = ?1",
  ).bind(roomCode).first<{ match_id: string; owner_user_id: string }>();
  if (!room) return json({ error: "房间不存在" }, 404);
  if (room.owner_user_id !== session.user.id) return json({ error: "只有房主可以结束并归档对局" }, 403);

  const result = await env.MATCH_ROOM.getByName(room.match_id).complete({
    operationId: requestOperationId,
    expectedVersion: version,
    actorUserId: session.user.id,
  });
  return commandResponse(result);
}

async function connectRoom(request: Request, env: RealtimeEnv, roomCode: string): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "需要 WebSocket Upgrade" }, 426);
  }
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const room = await env.DB.prepare(
    "SELECT match_id FROM realtime_rooms WHERE room_code = ?1",
  ).bind(roomCode).first<{ match_id: string }>();
  if (!room) return json({ error: "房间不存在" }, 404);
  const match = await requireMatchRead(env, session, room.match_id);
  const memberRole = await env.DB.prepare(
    "SELECT role FROM match_players WHERE match_id = ?1 AND user_id = ?2 AND left_at IS NULL ORDER BY joined_at LIMIT 1",
  ).bind(room.match_id, session.user.id).first<RoomRole>("role");
  const role: RoomRole | null = match.owner_user_id === session.user.id ? "host" : memberRole;
  if (!role) return json({ error: "你不是该房间成员" }, 403);

  const forwarded = new Request(request);
  forwarded.headers.set("X-Room-User-Id", session.user.id);
  forwarded.headers.set("X-Room-Role", role);
  return env.MATCH_ROOM.getByName(room.match_id).fetch(forwarded);
}

export async function handleRealtimeApiRequest(request: Request, env: RealtimeEnv): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const context: RealtimeRequestContext = {
    requestId: crypto.randomUUID(),
    stage: "route_request",
    reusedRoom: false,
    attempt: 0,
  };
  try {
    let response: Response | undefined;
    if (pathname === "/api/realtime/rooms" && request.method === "POST") response = await createRoom(request, env, context);
    if (pathname === "/api/realtime/rooms/direct" && request.method === "POST") response = await createDirectRoom(request, env, context);
    if (pathname === "/api/realtime/rooms/mine" && request.method === "GET") response = await listMyRooms(request, env);
    const room = pathname.match(/^\/api\/realtime\/rooms\/([23456789A-HJ-NP-Z]{6})$/i);
    if (!response && room && request.method === "GET") response = await getRoom(request, env, room[1].toUpperCase());
    const join = pathname.match(/^\/api\/realtime\/rooms\/([23456789A-HJ-NP-Z]{6})\/join$/i);
    if (!response && join && request.method === "POST") response = await joinRoom(request, env, join[1].toUpperCase());
    const member = pathname.match(/^\/api\/realtime\/rooms\/([23456789A-HJ-NP-Z]{6})\/members\/([0-9a-f-]{36})$/i);
    if (!response && member && request.method === "PATCH") {
      response = await assignMemberRole(request, env, member[1].toUpperCase(), uuid(member[2], "userId"), context);
    }
    const kick = pathname.match(/^\/api\/realtime\/rooms\/([23456789A-HJ-NP-Z]{6})\/members\/([0-9a-f-]{36})\/kick$/i);
    if (!response && kick && request.method === "POST") {
      response = await kickMember(request, env, kick[1].toUpperCase(), uuid(kick[2], "userId"), context);
    }
    const unban = pathname.match(/^\/api\/realtime\/rooms\/([23456789A-HJ-NP-Z]{6})\/members\/([0-9a-f-]{36})\/unban$/i);
    if (!response && unban && request.method === "POST") {
      response = await liftKick(request, env, unban[1].toUpperCase(), uuid(unban[2], "userId"));
    }
    const playerRemove = pathname.match(/^\/api\/realtime\/rooms\/([23456789A-HJ-NP-Z]{6})\/players\/([0-9a-f-]{36})$/i);
    if (!response && playerRemove && request.method === "POST") {
      response = await removePlayer(request, env, playerRemove[1].toUpperCase(), uuid(playerRemove[2], "playerId"), context);
    }
    const claim = pathname.match(/^\/api\/realtime\/rooms\/([23456789A-HJ-NP-Z]{6})\/players\/([0-9a-f-]{36})\/claim$/i);
    if (!response && claim && request.method === "POST") {
      response = await claimSeat(request, env, claim[1].toUpperCase(), uuid(claim[2], "playerId"), context);
    }
    const rename = pathname.match(/^\/api\/realtime\/rooms\/([23456789A-HJ-NP-Z]{6})\/players\/([0-9a-f-]{36})\/name$/i);
    if (!response && rename && request.method === "PATCH") {
      response = await renameSeat(request, env, rename[1].toUpperCase(), uuid(rename[2], "playerId"), context);
    }
    const leave = pathname.match(/^\/api\/realtime\/rooms\/([23456789A-HJ-NP-Z]{6})\/leave$/i);
    if (!response && leave && request.method === "POST") response = await leaveRoom(request, env, leave[1].toUpperCase());
    const complete = pathname.match(/^\/api\/realtime\/rooms\/([23456789A-HJ-NP-Z]{6})\/complete$/i);
    if (!response && complete && request.method === "POST") response = await completeRoom(request, env, complete[1].toUpperCase());
    const connect = pathname.match(/^\/api\/realtime\/rooms\/([23456789A-HJ-NP-Z]{6})\/connect$/i);
    if (!response && connect && request.method === "GET") response = await connectRoom(request, env, connect[1].toUpperCase());
    response ??= json({ error: "Not found" }, 404);
    return withRequestId(response, context.requestId);
  } catch (error) {
    if (error instanceof Response) return withRequestId(error, context.requestId);
    if (error instanceof RealtimeValidationError) return withRequestId(json({ error: error.message }, 400), context.requestId);
    logRealtimeFailure(context, error);
    if (error instanceof RealtimeUnavailableError) {
      return withRequestId(json({
        error: error.message,
        requestId: context.requestId,
        retryable: true,
        room: error.room,
      }, 503), context.requestId);
    }
    return withRequestId(json({ error: "服务器内部错误", requestId: context.requestId }, 500), context.requestId);
  }
}
