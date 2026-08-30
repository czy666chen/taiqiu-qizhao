import {
  AuthValidationError,
  digestPassword,
  digestSession,
  generateSessionToken,
  parseCookie,
  validatePassword,
  verifySecret,
} from "../auth/core";
import { getTeamBattleProjection, isTeamBattleMatch } from "../../src/lib/team-battle";

const ADMIN_COOKIE_NAME = "__Host-hei8_admin_session";
const MAX_JSON_BYTES = 16 * 1024;
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const DEFAULT_RESET_PASSWORD = "123456";

export type AdminEnv = Env & {
  PASSWORD_HMAC_KEY: string;
  SESSION_HMAC_KEY: string;
};

type AdminUser = {
  id: string;
  normalized_username: string;
  display_username: string;
  password_digest: string;
  status: string;
};

export type AdminSession = {
  tokenDigest: string;
  admin: Pick<AdminUser, "id" | "normalized_username" | "display_username" | "password_digest">;
};

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.append(key, value));
  return new Response(JSON.stringify(data), { status, headers });
}

function normalizeAdminUsername(input: unknown): { normalized: string; display: string } {
  if (typeof input !== "string") throw new AuthValidationError("用户名格式无效", "username");
  const display = input.trim();
  const normalized = display.toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(normalized)) {
    throw new AuthValidationError("用户名格式无效", "username");
  }
  return { normalized, display };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new AuthValidationError("请求必须使用 application/json", "request");
  }
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new AuthValidationError("请求体过大", "request");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw new AuthValidationError("请求体过大", "request");
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new AuthValidationError("请求体不是有效 JSON 对象", "request");
  }
}

function requireSameOrigin(request: Request): void {
  if (request.headers.get("Origin") !== new URL(request.url).origin) {
    throw new AuthValidationError("请求来源无效", "request");
  }
}

function requireSecrets(env: AdminEnv): void {
  if (!env.PASSWORD_HMAC_KEY || !env.SESSION_HMAC_KEY) {
    throw new Error("Authentication secrets are not configured");
  }
}

function sessionCookie(token: string): string {
  return `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function clearSessionCookie(): string {
  return `${ADMIN_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

async function audit(
  env: AdminEnv,
  action: string,
  outcome: "success" | "failure",
  requestId: string,
  adminUserId: string | null,
  metadata: Record<string, string> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO admin_audit_events
       (id, admin_user_id, action, outcome, request_id, metadata_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(crypto.randomUUID(), adminUserId, action, outcome, requestId, JSON.stringify(metadata)).run();
}

async function isRateLimited(env: AdminEnv, normalizedUsername: string): Promise<boolean> {
  const count = await env.DB.prepare(
    `SELECT count(*) AS count FROM admin_audit_events
      WHERE action = 'login' AND outcome = 'failure' AND created_at >= ?1
        AND json_extract(metadata_json, '$.normalized_username') = ?2`,
  ).bind(Date.now() - LOGIN_FAILURE_WINDOW_MS, normalizedUsername).first<number>("count");
  return (count ?? 0) >= LOGIN_FAILURE_LIMIT;
}

export async function findAdminSession(env: AdminEnv, request: Request): Promise<AdminSession | null> {
  const token = parseCookie(request.headers.get("Cookie"), ADMIN_COOKIE_NAME);
  if (!token) return null;
  const tokenDigest = await digestSession(env.SESSION_HMAC_KEY, token);
  const admin = await env.DB.prepare(
    `SELECT a.id, a.normalized_username, a.display_username, a.password_digest
       FROM admin_sessions s
       JOIN admin_users a ON a.id = s.admin_user_id
      WHERE s.token_digest = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2
        AND a.status = 'active'`,
  ).bind(tokenDigest, Date.now()).first<AdminSession["admin"]>();
  return admin ? { tokenDigest, admin } : null;
}

export async function requireAdminSession(env: AdminEnv, request: Request): Promise<AdminSession> {
  const session = await findAdminSession(env, request);
  if (!session) throw json({ error: "未登录或管理员会话已失效" }, 401);
  return session;
}

async function login(request: Request, env: AdminEnv, requestId: string): Promise<Response> {
  requireSameOrigin(request);
  const body = await readJson(request);
  const { normalized } = normalizeAdminUsername(body.username);
  const password = validatePassword(body.password);
  if (await isRateLimited(env, normalized)) return json({ error: "尝试次数过多，请稍后再试" }, 429);

  const admin = await env.DB.prepare(
    `SELECT id, normalized_username, display_username, password_digest, status
       FROM admin_users WHERE normalized_username = ?1`,
  ).bind(normalized).first<AdminUser>();
  const candidate = await digestPassword(env.PASSWORD_HMAC_KEY, normalized, password);
  const valid = admin?.status === "active"
    && await verifySecret(candidate, admin.password_digest);
  if (!valid) {
    await audit(env, "login", "failure", requestId, admin?.id ?? null, { normalized_username: normalized });
    return json({ error: "用户名或密码错误" }, 401);
  }

  const token = generateSessionToken();
  const tokenDigest = await digestSession(env.SESSION_HMAC_KEY, token);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO admin_sessions (id, admin_user_id, token_digest, expires_at)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind(crypto.randomUUID(), admin.id, tokenDigest, now + SESSION_MAX_AGE_SECONDS * 1000),
    env.DB.prepare("UPDATE admin_users SET last_login_at = ?1, updated_at = ?1 WHERE id = ?2")
      .bind(now, admin.id),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (id, admin_user_id, action, outcome, request_id, metadata_json)
       VALUES (?1, ?2, 'login', 'success', ?3, '{}')`,
    ).bind(crypto.randomUUID(), admin.id, requestId),
  ]);
  return json(
    { admin: { id: admin.id, username: admin.display_username }, session: { authenticated: true } },
    200,
    { "Set-Cookie": sessionCookie(token) },
  );
}

async function session(request: Request, env: AdminEnv): Promise<Response> {
  const current = await findAdminSession(env, request);
  if (!current) return json({ admin: null, session: { authenticated: false } });
  await env.DB.prepare(
    "UPDATE admin_sessions SET last_used_at = ?1 WHERE token_digest = ?2 AND last_used_at < ?3",
  ).bind(Date.now(), current.tokenDigest, Date.now() - 5 * 60 * 1000).run();
  return json({
    admin: { id: current.admin.id, username: current.admin.display_username },
    session: { authenticated: true },
  });
}

async function logout(request: Request, env: AdminEnv, requestId: string): Promise<Response> {
  requireSameOrigin(request);
  const current = await findAdminSession(env, request);
  if (current) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM admin_sessions WHERE token_digest = ?1").bind(current.tokenDigest),
      env.DB.prepare(
        `INSERT INTO admin_audit_events (id, admin_user_id, action, outcome, request_id, metadata_json)
         VALUES (?1, ?2, 'logout', 'success', ?3, '{}')`,
      ).bind(crypto.randomUUID(), current.admin.id, requestId),
    ]);
  }
  return json({ session: { authenticated: false } }, 200, { "Set-Cookie": clearSessionCookie() });
}

async function changePassword(request: Request, env: AdminEnv, requestId: string): Promise<Response> {
  requireSameOrigin(request);
  const current = await requireAdminSession(env, request);
  const body = await readJson(request);
  const currentPassword = validatePassword(body.currentPassword);
  const newPassword = validatePassword(body.newPassword);
  const currentDigest = await digestPassword(
    env.PASSWORD_HMAC_KEY,
    current.admin.normalized_username,
    currentPassword,
  );
  if (!(await verifySecret(currentDigest, current.admin.password_digest))) {
    await audit(env, "change_password", "failure", requestId, current.admin.id);
    return json({ error: "当前密码错误" }, 401);
  }

  const newDigest = await digestPassword(
    env.PASSWORD_HMAC_KEY,
    current.admin.normalized_username,
    newPassword,
  );
  const token = generateSessionToken();
  const tokenDigest = await digestSession(env.SESSION_HMAC_KEY, token);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE admin_users SET password_digest = ?1, password_version = password_version + 1, updated_at = ?2 WHERE id = ?3",
    ).bind(newDigest, now, current.admin.id),
    env.DB.prepare("DELETE FROM admin_sessions WHERE admin_user_id = ?1").bind(current.admin.id),
    env.DB.prepare(
      `INSERT INTO admin_sessions (id, admin_user_id, token_digest, expires_at)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind(crypto.randomUUID(), current.admin.id, tokenDigest, now + SESSION_MAX_AGE_SECONDS * 1000),
    env.DB.prepare(
      `INSERT INTO admin_audit_events (id, admin_user_id, action, outcome, request_id, metadata_json)
       VALUES (?1, ?2, 'change_password', 'success', ?3, '{}')`,
    ).bind(crypto.randomUUID(), current.admin.id, requestId),
  ]);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
}

type AdminUserListRow = {
  id: string;
  display_username: string;
  public_code: string;
  nickname: string;
  status: string;
  created_at: number;
  updated_at: number;
  match_count: number;
  last_match_at: number | null;
};

type AdminUserDetailRow = {
  id: string;
  display_username: string;
  public_code: string;
  nickname: string;
  avatar_url: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  password_reset_at: number | null;
  active_session_count: number;
  match_count: number;
};

type AdminUserMatchRow = {
  id: string;
  mode: string;
  status: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  is_owner: number;
};

type AdminUserAuthEventRow = {
  id: string;
  action: string;
  outcome: string;
  created_at: number;
};

type AdminMatchListRow = {
  id: string;
  mode: string;
  status: string;
  privacy: string;
  version: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
  owner_user_id: string;
  owner_username: string | null;
  owner_nickname: string | null;
  owner_status: string | null;
  is_realtime: number;
};

type AdminMatchPlayerRow = {
  id: string;
  match_id: string;
  seat_no: number;
  user_id: string | null;
  role: string;
  nickname_snapshot: string;
  username: string | null;
  nickname: string | null;
  user_status: string | null;
  joined_at: number;
  left_at: number | null;
  kicked_at: number | null;
  final_score?: number;
};

type AdminMatchDetailRow = AdminMatchListRow & {
  snapshot_json: string | null;
  snapshot_checksum: string | null;
  room_code: string | null;
  room_status: string | null;
};

type AdminScoreEventRow = {
  id: string;
  operation_id: string;
  sequence_no: number;
  actor_user_id: string | null;
  actor_username: string | null;
  player_id: string;
  player_nickname: string;
  score_delta: number;
  correction_event_id: string | null;
  payload_json: string;
  occurred_at: number;
  created_at: number;
};

type AdminCardEventRow = {
  id: string;
  operation_id: string;
  sequence_no: number;
  actor_user_id: string | null;
  actor_username: string | null;
  card_instance_snapshot_json: string;
  score_event_id: string | null;
  occurred_at: number;
  created_at: number;
};

type AdminMatchAuditRow = {
  id: string;
  actor_user_id: string | null;
  actor_username: string | null;
  action: string;
  reason: string | null;
  before_version: number | null;
  after_version: number | null;
  metadata_json: string;
  created_at: number;
};

type SnapshotRecord = Record<string, unknown>;

function snapshotRecord(value: unknown): SnapshotRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as SnapshotRecord : null;
}

function snapshotArray(value: unknown): SnapshotRecord[] {
  return Array.isArray(value) ? value.map(snapshotRecord).filter((item): item is SnapshotRecord => item !== null) : [];
}

function snapshotNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function snapshotString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function snapshotMatchFallbacks(snapshot: SnapshotRecord, players: AdminMatchPlayerRow[]): {
  finalScores: Map<string, number>;
  scoreEvents: Array<Record<string, unknown>>;
  cardEvents: Array<Record<string, unknown>>;
  auditEvents: Array<Record<string, unknown>>;
} {
  const snapshotPlayers = snapshotArray(snapshot.players);
  const playerBySnapshotId = new Map<string, AdminMatchPlayerRow>();
  const finalScores = new Map<string, number>();
  snapshotPlayers.forEach((player, seat) => {
    const stored = players[seat];
    if (!stored) return;
    const snapshotId = snapshotString(player.id);
    if (snapshotId) playerBySnapshotId.set(snapshotId, stored);
    if (typeof player.score === "number" && Number.isFinite(player.score)) finalScores.set(stored.id, player.score);
  });

  const rawEvents = snapshotArray(snapshot.events);
  const corrections = new Map(rawEvents
    .filter((event) => event.type === "correction" && typeof event.correctsEventId === "string")
    .map((event) => [String(event.correctsEventId), event]));
  const scoreEvents: Array<Record<string, unknown>> = [];
  if (isTeamBattleMatch(snapshot)) {
    const projection = getTeamBattleProjection(snapshot);
    for (const round of projection.rounds) {
      const player = playerBySnapshotId.get(round.winnerId);
      if (!player) continue;
      const correction = corrections.get(round.eventId);
      finalScores.set(player.id, (finalScores.get(player.id) ?? 0) + 1);
      scoreEvents.push({
        id: round.eventId,
        operationId: round.eventId,
        sequenceNo: round.sequenceNo,
        actorUserId: null,
        actorUsername: null,
        playerId: player.id,
        playerNickname: player.nickname ?? player.nickname_snapshot,
        scoreDelta: 1,
        correctionEventId: correction ? snapshotString(correction.id) || null : null,
        payload: round,
        occurredAt: round.confirmedAt,
        createdAt: round.confirmedAt,
      });
    }
  } else if (snapshot.mode === "chinese_eight") {
    for (const event of rawEvents.filter((item) => item.type === "round")) {
      const correction = corrections.get(snapshotString(event.id));
      const round = snapshotRecord(correction ? correction.replacement : event.round);
      if (!round) continue;
      const player = playerBySnapshotId.get(snapshotString(round.winnerId));
      if (!player) continue;
      finalScores.set(player.id, (finalScores.get(player.id) ?? 0) + 1);
      scoreEvents.push({
        id: snapshotString(event.id, `snapshot-score-${scoreEvents.length + 1}`),
        operationId: snapshotString(event.operationId, snapshotString(event.id)),
        sequenceNo: snapshotNumber(event.sequenceNo, scoreEvents.length + 1),
        actorUserId: null,
        actorUsername: null,
        playerId: player.id,
        playerNickname: player.nickname ?? player.nickname_snapshot,
        scoreDelta: 1,
        correctionEventId: correction ? snapshotString(correction.id) || null : null,
        payload: round,
        occurredAt: snapshotNumber(correction?.occurredAt, snapshotNumber(event.occurredAt)),
        createdAt: snapshotNumber(correction?.occurredAt, snapshotNumber(event.occurredAt)),
      });
    }
  } else {
    const rawScoreEvents = snapshotArray(snapshot.scoreEvents).sort((left, right) => snapshotNumber(left.occurredAt) - snapshotNumber(right.occurredAt));
    rawScoreEvents.forEach((event, index) => {
      const player = playerBySnapshotId.get(snapshotString(event.playerId));
      if (!player) return;
      const changes = snapshotRecord(event.changes);
      const scoreDelta = snapshotNumber(changes?.[snapshotString(event.playerId)]);
      scoreEvents.push({
        id: snapshotString(event.id, `snapshot-score-${index + 1}`),
        operationId: snapshotString(event.id, `snapshot-score-${index + 1}`),
        sequenceNo: index + 1,
        actorUserId: null,
        actorUsername: null,
        playerId: player.id,
        playerNickname: player.nickname ?? player.nickname_snapshot,
        scoreDelta,
        correctionEventId: typeof event.correctsEventId === "string" ? event.correctsEventId : null,
        payload: event,
        occurredAt: snapshotNumber(event.occurredAt),
        createdAt: snapshotNumber(event.occurredAt),
      });
    });
  }

  const cards = snapshotRecord(snapshot.cards);
  const rawCardEvents = snapshotArray(cards?.events).sort((left, right) => snapshotNumber(left.occurredAt) - snapshotNumber(right.occurredAt));
  const cardEvents = rawCardEvents.map((event, index) => {
    const card = snapshotRecord(event.card);
    return {
      id: snapshotString(event.id, `snapshot-card-${index + 1}`),
      operationId: snapshotString(event.actionId, snapshotString(event.id, `snapshot-card-${index + 1}`)),
      sequenceNo: index + 1,
      actorUserId: null,
      actorUsername: null,
      cardInstanceSnapshot: snapshotRecord(card?.snapshot) ?? card ?? { title: snapshotString(event.label, "卡牌操作") },
      scoreEventId: typeof event.relatedScoreEventId === "string" ? event.relatedScoreEventId : null,
      occurredAt: snapshotNumber(event.occurredAt),
      createdAt: snapshotNumber(event.occurredAt),
    };
  });
  const auditEvents = rawEvents.map((event, index) => ({
    id: snapshotString(event.id, `snapshot-audit-${index + 1}`),
    actorUserId: null,
    actorUsername: null,
    action: snapshotString(event.type, "snapshot_event"),
    reason: null,
    beforeVersion: Math.max(0, snapshotNumber(event.matchVersion, index + 1) - 1),
    afterVersion: snapshotNumber(event.matchVersion, index + 1),
    metadata: event,
    createdAt: snapshotNumber(event.occurredAt),
  }));
  return { finalScores, scoreEvents, cardEvents, auditEvents };
}

function listUsersParameters(request: Request): {
  query: string;
  status: string | null;
  limit: number;
  cursor: { createdAt: number; id: string } | null;
} {
  const params = new URL(request.url).searchParams;
  const query = (params.get("query") ?? "").trim();
  const status = params.get("status");
  const limitText = params.get("limit");
  const limit = limitText === null ? DEFAULT_PAGE_SIZE : Number(limitText);
  if (query.length > 80 || (status !== null && !["active", "disabled", "deleted"].includes(status))
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new AuthValidationError("查询参数无效", "request");
  }

  const cursorText = params.get("cursor");
  if (!cursorText) return { query, status, limit, cursor: null };
  const separator = cursorText.indexOf(":");
  const createdAt = Number(cursorText.slice(0, separator));
  const id = cursorText.slice(separator + 1);
  if (separator < 1 || !Number.isSafeInteger(createdAt) || createdAt < 0 || id.length !== 36) {
    throw new AuthValidationError("查询参数无效", "request");
  }
  return { query, status, limit, cursor: { createdAt, id } };
}

function listMatchesParameters(request: Request): {
  query: string;
  mode: string | null;
  status: string | null;
  from: number | null;
  to: number | null;
  limit: number;
  cursor: { createdAt: number; id: string } | null;
} {
  const params = new URL(request.url).searchParams;
  const query = (params.get("query") ?? "").trim();
  const mode = params.get("mode");
  const status = params.get("status");
  const fromText = params.get("from");
  const toText = params.get("to");
  const from = fromText === null ? null : Number(fromText);
  const to = toText === null ? null : Number(toText);
  const limitText = params.get("limit");
  const limit = limitText === null ? DEFAULT_PAGE_SIZE : Number(limitText);
  if (query.length > 80 || (mode !== null && (!mode || mode.length > 40))
    || (status !== null && !["draft", "active", "completed", "cancelled"].includes(status))
    || (from !== null && (!Number.isSafeInteger(from) || from < 0))
    || (to !== null && (!Number.isSafeInteger(to) || to < 0))
    || (from !== null && to !== null && from > to)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new AuthValidationError("查询参数无效", "request");
  }

  const cursorText = params.get("cursor");
  if (!cursorText) return { query, mode, status, from, to, limit, cursor: null };
  const separator = cursorText.indexOf(":");
  const createdAt = Number(cursorText.slice(0, separator));
  const id = cursorText.slice(separator + 1);
  if (separator < 1 || !Number.isSafeInteger(createdAt) || createdAt < 0 || id.length !== 36) {
    throw new AuthValidationError("查询参数无效", "request");
  }
  return { query, mode, status, from, to, limit, cursor: { createdAt, id } };
}

function adminMatchPlayer(row: AdminMatchPlayerRow): Record<string, unknown> {
  return {
    id: row.id,
    seatNo: row.seat_no,
    userId: row.user_id,
    role: row.role,
    nicknameSnapshot: row.nickname_snapshot,
    username: row.username,
    nickname: row.nickname,
    userStatus: row.user_status,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    kickedAt: row.kicked_at,
    ...(row.final_score === undefined ? {} : { finalScore: row.final_score }),
  };
}

function adminMatchSummary(row: AdminMatchListRow, players: AdminMatchPlayerRow[]): Record<string, unknown> {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    privacy: row.privacy,
    version: row.version,
    owner: {
      userId: row.owner_user_id,
      username: row.owner_username,
      nickname: row.owner_nickname,
      userStatus: row.owner_status,
    },
    players: players.map(adminMatchPlayer),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    isRealtime: Boolean(row.is_realtime),
  };
}

async function listMatches(request: Request, env: AdminEnv): Promise<Response> {
  await requireAdminSession(env, request);
  const { query, mode, status, from, to, limit, cursor } = listMatchesParameters(request);
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];
  if (query) {
    const escaped = query.replace(/[\\%_]/g, "\\$&");
    const contains = `%${escaped}%`;
    conditions.push(`(m.id LIKE ? ESCAPE '\\'
      OR ou.normalized_username LIKE ? ESCAPE '\\' OR op.nickname LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM match_players qp
        LEFT JOIN users qu ON qu.id = qp.user_id
        LEFT JOIN profiles qpr ON qpr.user_id = qp.user_id
        WHERE qp.match_id = m.id AND (qp.nickname_snapshot LIKE ? ESCAPE '\\'
          OR qu.normalized_username LIKE ? ESCAPE '\\' OR qpr.nickname LIKE ? ESCAPE '\\')
      ))`);
    bindings.push(contains, contains.toLowerCase(), contains, contains, contains.toLowerCase(), contains);
  }
  if (mode) {
    conditions.push("m.mode = ?");
    bindings.push(mode);
  }
  if (status) {
    conditions.push("m.status = ?");
    bindings.push(status);
  }
  if (from !== null) {
    conditions.push("m.created_at >= ?");
    bindings.push(from);
  }
  if (to !== null) {
    conditions.push("m.created_at <= ?");
    bindings.push(to);
  }
  if (cursor) {
    conditions.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  const result = await env.DB.prepare(
    `SELECT m.id, m.mode, m.status, m.privacy, m.version, m.created_at, m.updated_at,
            m.started_at, m.ended_at, m.owner_user_id,
            ou.display_username AS owner_username, op.nickname AS owner_nickname,
            ou.status AS owner_status, CASE WHEN rr.match_id IS NULL THEN 0 ELSE 1 END AS is_realtime
       FROM matches m
       LEFT JOIN users ou ON ou.id = m.owner_user_id
       LEFT JOIN profiles op ON op.user_id = m.owner_user_id
       LEFT JOIN realtime_rooms rr ON rr.match_id = m.id
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
  ).bind(...bindings, limit + 1).all<AdminMatchListRow>();

  const rows = result.results.slice(0, limit);
  const playersByMatch = new Map<string, AdminMatchPlayerRow[]>();
  if (rows.length) {
    const ids = rows.map((row) => row.id);
    const players = await env.DB.prepare(
      `SELECT mp.id, mp.match_id, mp.seat_no, mp.user_id, mp.role, mp.nickname_snapshot,
              u.display_username AS username, p.nickname, u.status AS user_status,
              mp.joined_at, mp.left_at, mp.kicked_at
         FROM match_players mp
         LEFT JOIN users u ON u.id = mp.user_id
         LEFT JOIN profiles p ON p.user_id = mp.user_id
        WHERE mp.match_id IN (${ids.map(() => "?").join(",")})
        ORDER BY mp.match_id, mp.seat_no`,
    ).bind(...ids).all<AdminMatchPlayerRow>();
    for (const player of players.results) {
      const group = playersByMatch.get(player.match_id) ?? [];
      group.push(player);
      playersByMatch.set(player.match_id, group);
    }
  }

  const last = rows.at(-1);
  return json({
    matches: rows.map((row) => adminMatchSummary(row, playersByMatch.get(row.id) ?? [])),
    nextCursor: result.results.length > limit && last ? `${last.created_at}:${last.id}` : null,
  });
}

async function listUsers(request: Request, env: AdminEnv): Promise<Response> {
  await requireAdminSession(env, request);
  const { query, status, limit, cursor } = listUsersParameters(request);
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];
  if (query) {
    const escaped = query.replace(/[\\%_]/g, "\\$&");
    conditions.push("(u.normalized_username LIKE ? ESCAPE '\\' OR p.nickname LIKE ? ESCAPE '\\')");
    bindings.push(`%${escaped.toLowerCase()}%`, `%${escaped}%`);
  }
  if (status) {
    conditions.push("u.status = ?");
    bindings.push(status);
  }
  if (cursor) {
    conditions.push("(u.created_at < ? OR (u.created_at = ? AND u.id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  const result = await env.DB.prepare(
    `WITH page AS (
       SELECT u.id, u.display_username, p.public_code, p.nickname, u.status, u.created_at, u.updated_at
         FROM users u JOIN profiles p ON p.user_id = u.id
        ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY u.created_at DESC, u.id DESC LIMIT ?
     ), user_matches AS (
       SELECT page.id AS user_id, m.id AS match_id, m.created_at AS match_created_at
         FROM page JOIN matches m ON m.owner_user_id = page.id
       UNION
       SELECT page.id, m.id, m.created_at
         FROM page JOIN match_players mp ON mp.user_id = page.id
                   JOIN matches m ON m.id = mp.match_id
        WHERE mp.role != 'spectator'
     )
     SELECT page.*, count(user_matches.match_id) AS match_count,
            max(user_matches.match_created_at) AS last_match_at
       FROM page LEFT JOIN user_matches ON user_matches.user_id = page.id
      GROUP BY page.id, page.display_username, page.public_code, page.nickname,
               page.status, page.created_at, page.updated_at
      ORDER BY page.created_at DESC, page.id DESC`,
  ).bind(...bindings, limit + 1).all<AdminUserListRow>();

  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return json({
    users: rows.map((row) => ({
      id: row.id,
      username: row.display_username,
      publicCode: row.public_code,
      nickname: row.nickname,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      matchCount: row.match_count,
      lastMatchAt: row.last_match_at,
    })),
    nextCursor: result.results.length > limit && last ? `${last.created_at}:${last.id}` : null,
  });
}

async function userDetail(request: Request, env: AdminEnv, userId: string): Promise<Response> {
  await requireAdminSession(env, request);
  const [userResult, matchesResult, auditResult] = await env.DB.batch([
    env.DB.prepare(
      `SELECT u.id, u.display_username, p.public_code, p.nickname, p.avatar_url,
              u.status, u.created_at, u.updated_at, u.deleted_at,
              u.password_reset_at,
              (SELECT count(*) FROM sessions s
                WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS active_session_count,
              (SELECT count(*) FROM (
                 SELECT m.id FROM matches m WHERE m.owner_user_id = u.id
                 UNION
                 SELECT m.id FROM match_players mp JOIN matches m ON m.id = mp.match_id
                  WHERE mp.user_id = u.id AND mp.role != 'spectator'
               )) AS match_count
         FROM users u JOIN profiles p ON p.user_id = u.id
        WHERE u.id = ?1`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT DISTINCT m.id, m.mode, m.status, m.created_at, m.started_at, m.ended_at,
              CASE WHEN m.owner_user_id = ?1 THEN 1 ELSE 0 END AS is_owner
         FROM matches m LEFT JOIN match_players mp ON mp.match_id = m.id
        WHERE m.owner_user_id = ?1 OR (mp.user_id = ?1 AND mp.role != 'spectator')
        ORDER BY m.created_at DESC, m.id DESC LIMIT 20`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT id, action, outcome, created_at FROM auth_audit_events
        WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 20`,
    ).bind(userId),
  ]);
  const user = userResult.results[0] as AdminUserDetailRow | undefined;
  if (!user) return json({ error: "用户不存在" }, 404);

  return json({
    user: {
      id: user.id,
      username: user.display_username,
      publicCode: user.public_code,
      nickname: user.nickname,
      avatarUrl: user.avatar_url,
      status: user.status,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
      deletedAt: user.deleted_at,
      passwordResetAt: user.password_reset_at,
      activeSessionCount: user.active_session_count,
      matchCount: user.match_count,
    },
    recentMatches: (matchesResult.results as AdminUserMatchRow[]).map((match) => ({
      id: match.id,
      mode: match.mode,
      status: match.status,
      createdAt: match.created_at,
      startedAt: match.started_at,
      endedAt: match.ended_at,
      isOwner: Boolean(match.is_owner),
    })),
    recentAuthEvents: (auditResult.results as AdminUserAuthEventRow[]).map((event) => ({
      id: event.id,
      action: event.action,
      outcome: event.outcome,
      createdAt: event.created_at,
    })),
  });
}

async function matchDetail(request: Request, env: AdminEnv, matchId: string): Promise<Response> {
  await requireAdminSession(env, request);
  const [matchResult, playersResult, scoresResult, cardsResult, auditResult] = await env.DB.batch([
    env.DB.prepare(
      `SELECT m.id, m.mode, m.status, m.privacy, m.version, m.created_at, m.updated_at,
              m.started_at, m.ended_at, m.owner_user_id, m.snapshot_json, m.snapshot_checksum,
              ou.display_username AS owner_username, op.nickname AS owner_nickname,
              ou.status AS owner_status, CASE WHEN rr.match_id IS NULL THEN 0 ELSE 1 END AS is_realtime,
              rr.room_code, rr.status AS room_status
         FROM matches m
         LEFT JOIN users ou ON ou.id = m.owner_user_id
         LEFT JOIN profiles op ON op.user_id = m.owner_user_id
         LEFT JOIN realtime_rooms rr ON rr.match_id = m.id
        WHERE m.id = ?1`,
    ).bind(matchId),
    env.DB.prepare(
      `SELECT mp.id, mp.match_id, mp.seat_no, mp.user_id, mp.role, mp.nickname_snapshot,
              u.display_username AS username, p.nickname, u.status AS user_status,
              mp.joined_at, mp.left_at, mp.kicked_at,
              coalesce(sum(se.score_delta), 0) AS final_score
         FROM match_players mp
         LEFT JOIN users u ON u.id = mp.user_id
         LEFT JOIN profiles p ON p.user_id = mp.user_id
         LEFT JOIN score_events se ON se.player_id = mp.id
        WHERE mp.match_id = ?1
        GROUP BY mp.id, mp.match_id, mp.seat_no, mp.user_id, mp.role, mp.nickname_snapshot,
                 u.display_username, p.nickname, u.status, mp.joined_at, mp.left_at, mp.kicked_at
        ORDER BY mp.seat_no`,
    ).bind(matchId),
    env.DB.prepare(
      `SELECT se.id, se.operation_id, se.sequence_no, se.actor_user_id,
              au.display_username AS actor_username, se.player_id,
              mp.nickname_snapshot AS player_nickname, se.score_delta, se.correction_event_id,
              se.payload_json, se.occurred_at, se.created_at
         FROM score_events se
         JOIN match_players mp ON mp.id = se.player_id
         LEFT JOIN users au ON au.id = se.actor_user_id
        WHERE se.match_id = ?1 ORDER BY se.sequence_no`,
    ).bind(matchId),
    env.DB.prepare(
      `SELECT ce.id, ce.operation_id, ce.sequence_no, ce.actor_user_id,
              au.display_username AS actor_username, ce.card_instance_snapshot_json,
              ce.score_event_id, ce.occurred_at, ce.created_at
         FROM card_events ce LEFT JOIN users au ON au.id = ce.actor_user_id
        WHERE ce.match_id = ?1 ORDER BY ce.sequence_no`,
    ).bind(matchId),
    env.DB.prepare(
      `SELECT mae.id, mae.actor_user_id, u.display_username AS actor_username,
              mae.action, mae.reason, mae.before_version, mae.after_version,
              mae.metadata_json, mae.created_at
         FROM match_audit_events mae LEFT JOIN users u ON u.id = mae.actor_user_id
        WHERE mae.match_id = ?1 ORDER BY mae.created_at, mae.id`,
    ).bind(matchId),
  ]);
  const match = matchResult.results[0] as AdminMatchDetailRow | undefined;
  if (!match) return json({ error: "战绩不存在" }, 404);

  const rawSnapshot = match.snapshot_json === null ? null : JSON.parse(match.snapshot_json) as unknown;
  const players = playersResult.results as AdminMatchPlayerRow[];
  const parsedSnapshot = snapshotRecord(rawSnapshot);
  const fallback = parsedSnapshot ? snapshotMatchFallbacks(parsedSnapshot, players) : null;
  const scoreEvents = (scoresResult.results as AdminScoreEventRow[]).map((event) => ({
    id: event.id,
    operationId: event.operation_id,
    sequenceNo: event.sequence_no,
    actorUserId: event.actor_user_id,
    actorUsername: event.actor_username,
    playerId: event.player_id,
    playerNickname: event.player_nickname,
    scoreDelta: event.score_delta,
    correctionEventId: event.correction_event_id,
    payload: JSON.parse(event.payload_json),
    occurredAt: event.occurred_at,
    createdAt: event.created_at,
  }));
  const cardEvents = (cardsResult.results as AdminCardEventRow[]).map((event) => ({
    id: event.id,
    operationId: event.operation_id,
    sequenceNo: event.sequence_no,
    actorUserId: event.actor_user_id,
    actorUsername: event.actor_username,
    cardInstanceSnapshot: JSON.parse(event.card_instance_snapshot_json),
    scoreEventId: event.score_event_id,
    occurredAt: event.occurred_at,
    createdAt: event.created_at,
  }));
  const auditEvents = (auditResult.results as AdminMatchAuditRow[]).map((event) => ({
    id: event.id,
    actorUserId: event.actor_user_id,
    actorUsername: event.actor_username,
    action: event.action,
    reason: event.reason,
    beforeVersion: event.before_version,
    afterVersion: event.after_version,
    metadata: JSON.parse(event.metadata_json),
    createdAt: event.created_at,
  }));
  const detailPlayers = scoreEvents.length || !fallback
    ? players
    : players.map((player) => ({ ...player, final_score: fallback.finalScores.get(player.id) ?? player.final_score }));

  return json({
    match: {
      ...adminMatchSummary(match, detailPlayers),
      snapshotChecksum: match.snapshot_checksum,
      rawSnapshot,
      realtime: match.is_realtime ? { roomCode: match.room_code, status: match.room_status } : null,
    },
    scoreEvents: scoreEvents.length ? scoreEvents : fallback?.scoreEvents ?? [],
    cardEvents: cardEvents.length ? cardEvents : fallback?.cardEvents ?? [],
    auditEvents: auditEvents.length ? auditEvents : fallback?.auditEvents ?? [],
  });
}

async function resetUserPassword(
  request: Request,
  env: AdminEnv,
  requestId: string,
  userId: string,
): Promise<Response> {
  requireSameOrigin(request);
  const current = await requireAdminSession(env, request);
  const body = await readJson(request);
  const currentPassword = validatePassword(body.currentPassword);
  const currentDigest = await digestPassword(
    env.PASSWORD_HMAC_KEY,
    current.admin.normalized_username,
    currentPassword,
  );
  if (!(await verifySecret(currentDigest, current.admin.password_digest))) {
    await env.DB.prepare(
      `INSERT INTO admin_audit_events
         (id, admin_user_id, action, target_type, target_id, outcome, request_id, metadata_json)
       VALUES (?1, ?2, 'reset_user_password', 'user', ?3, 'failure', ?4, '{"reason":"admin_password"}')`,
    ).bind(crypto.randomUUID(), current.admin.id, userId, requestId).run();
    return json({ error: "当前管理员密码错误" }, 401);
  }

  const user = await env.DB.prepare(
    "SELECT normalized_username, status FROM users WHERE id = ?1",
  ).bind(userId).first<{ normalized_username: string; status: string }>();
  if (!user || user.status !== "active") {
    const reason = user ? "user_not_active" : "user_not_found";
    await env.DB.prepare(
      `INSERT INTO admin_audit_events
         (id, admin_user_id, action, target_type, target_id, outcome, request_id, metadata_json)
       VALUES (?1, ?2, 'reset_user_password', 'user', ?3, 'failure', ?4, ?5)`,
    ).bind(crypto.randomUUID(), current.admin.id, userId, requestId, JSON.stringify({ reason })).run();
    return json({ error: user ? "该用户当前不可重置密码" : "用户不存在" }, user ? 409 : 404);
  }

  const password = DEFAULT_RESET_PASSWORD;
  const passwordDigest = await digestPassword(env.PASSWORD_HMAC_KEY, user.normalized_username, password);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET password_digest = ?1, password_version = password_version + 1,
              password_reset_at = ?2, updated_at = ?2
        WHERE id = ?3 AND status = 'active'`,
    ).bind(passwordDigest, now, userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId),
    env.DB.prepare(
      `INSERT INTO auth_audit_events
         (id, user_id, action, outcome, request_id, metadata_json, created_at)
       VALUES (?1, ?2, 'admin_reset_password', 'success', ?3, '{}', ?4)`,
    ).bind(crypto.randomUUID(), userId, requestId, now),
    env.DB.prepare(
      `INSERT INTO admin_audit_events
         (id, admin_user_id, action, target_type, target_id, outcome, request_id, metadata_json, created_at)
       VALUES (?1, ?2, 'reset_user_password', 'user', ?3, 'success', ?4, '{}', ?5)`,
    ).bind(crypto.randomUUID(), current.admin.id, userId, requestId, now),
  ]);
  return json({ newPassword: password });
}

async function deleteUserAccount(
  request: Request,
  env: AdminEnv,
  requestId: string,
  userId: string,
): Promise<Response> {
  requireSameOrigin(request);
  const current = await requireAdminSession(env, request);
  const body = await readJson(request);
  const currentPassword = validatePassword(body.currentPassword);
  const currentDigest = await digestPassword(
    env.PASSWORD_HMAC_KEY,
    current.admin.normalized_username,
    currentPassword,
  );
  if (!(await verifySecret(currentDigest, current.admin.password_digest))) {
    await env.DB.prepare(
      `INSERT INTO admin_audit_events
         (id, admin_user_id, action, target_type, target_id, outcome, request_id, metadata_json)
       VALUES (?1, ?2, 'delete_user_account', 'user', ?3, 'failure', ?4, '{"reason":"admin_password"}')`,
    ).bind(crypto.randomUUID(), current.admin.id, userId, requestId).run();
    return json({ error: "当前管理员密码错误" }, 401);
  }

  const user = await env.DB.prepare(
    "SELECT display_username FROM users WHERE id = ?1",
  ).bind(userId).first<{ display_username: string }>();
  if (!user) return json({ error: "用户不存在" }, 404);
  if (body.confirmation !== user.display_username) {
    return json({ error: "目标用户名确认不匹配" }, 400);
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE matches
          SET owner_user_id = (
                SELECT mp.user_id FROM match_players mp
                 WHERE mp.match_id = matches.id AND mp.user_id IS NOT NULL AND mp.user_id <> ?1
                 ORDER BY mp.seat_no LIMIT 1
              ),
              write_lease_device_id = NULL, write_lease_expires_at = NULL, updated_at = ?2
        WHERE owner_user_id = ?1 AND privacy = 'participants'
          AND EXISTS (
            SELECT 1 FROM match_players mp
             WHERE mp.match_id = matches.id AND mp.user_id IS NOT NULL AND mp.user_id <> ?1
          )`,
    ).bind(userId, now),
    env.DB.prepare("DELETE FROM matches WHERE owner_user_id = ?1").bind(userId),
    env.DB.prepare("UPDATE match_players SET user_id = NULL WHERE user_id = ?1").bind(userId),
    env.DB.prepare(
      `INSERT INTO admin_audit_events
         (id, admin_user_id, action, target_type, target_id, outcome, request_id, metadata_json, created_at)
       VALUES (?1, ?2, 'delete_user_account', 'user', ?3, 'success', ?4, '{}', ?5)`,
    ).bind(crypto.randomUUID(), current.admin.id, userId, requestId, now),
    env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(userId),
  ]);
  return json({ deleted: true });
}

export async function handleAdminApiRequest(request: Request, env: AdminEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const requestId = request.headers.get("CF-Ray") ?? request.headers.get("X-Request-ID") ?? crypto.randomUUID();
  try {
    requireSecrets(env);
    if (pathname === "/api/admin/auth/login" && request.method === "POST") return await login(request, env, requestId);
    if (pathname === "/api/admin/auth/logout" && request.method === "POST") return await logout(request, env, requestId);
    if (pathname === "/api/admin/auth/session" && request.method === "GET") return await session(request, env);
    if (pathname === "/api/admin/auth/change-password" && request.method === "POST") {
      return await changePassword(request, env, requestId);
    }
    if (pathname.startsWith("/api/admin/auth/")) return json({ error: "Method not allowed" }, 405);
    if (pathname === "/api/admin/users" && request.method === "GET") return await listUsers(request, env);
    const resetMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/reset-password$/);
    if (resetMatch && request.method === "POST") {
      return await resetUserPassword(request, env, requestId, resetMatch[1]);
    }
    const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (userMatch && request.method === "GET") return await userDetail(request, env, userMatch[1]);
    if (userMatch && request.method === "DELETE") {
      return await deleteUserAccount(request, env, requestId, userMatch[1]);
    }
    if (pathname === "/api/admin/matches" && request.method === "GET") return await listMatches(request, env);
    const matchMatch = pathname.match(/^\/api\/admin\/matches\/([^/]+)$/);
    if (matchMatch && request.method === "GET") return await matchDetail(request, env, matchMatch[1]);
    await requireAdminSession(env, request);
    if (pathname === "/api/admin/users" || resetMatch || userMatch
      || pathname === "/api/admin/matches" || matchMatch) {
      return json({ error: "Method not allowed" }, 405);
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof AuthValidationError) return json({ error: error.message, field: error.field }, 400);
    if (error instanceof Error && error.message === "Authentication secrets are not configured") {
      return json({ error: "认证服务尚未配置" }, 503);
    }
    console.error(JSON.stringify({ level: "error", event: "admin_api_failure", requestId }));
    return json({ error: "服务器内部错误", requestId }, 500);
  }
}
