import {
  AuthValidationError,
  digestPassword,
  digestSession,
  generateSessionToken,
  normalizeUsername,
  SESSION_COOKIE_NAME,
  validateRegistrationUsername,
  validateNickname,
  validatePassword,
  verifySecret,
} from "./core";
import { findSession, requireSession, type SessionUser } from "./session";

const MAX_JSON_BYTES = 16 * 1024;
const SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

export type AuthEnv = Env & {
  REGISTRATION_INVITE_CODE: string;
  PASSWORD_HMAC_KEY: string;
  SESSION_HMAC_KEY: string;
};

function responseHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = responseHeaders();
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.append(key, value));
  return new Response(JSON.stringify(data), { status, headers });
}

function userJson(user: SessionUser) {
  return {
    id: user.id,
    username: user.display_username,
    normalizedUsername: user.normalized_username,
    publicCode: user.public_code,
    nickname: user.nickname,
    avatarUrl: user.avatar_url,
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AuthValidationError("请求必须使用 application/json", "request");
  }

  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new AuthValidationError("请求体过大", "request");
  }

  if (!request.body) throw new AuthValidationError("请求体不能为空", "request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new AuthValidationError("请求体过大", "request");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new AuthValidationError("请求体不是有效 JSON 对象", "request");
  }
}

function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new AuthValidationError("请求来源无效", "request");
  }
}

function requireSecrets(env: AuthEnv): void {
  if (!env.REGISTRATION_INVITE_CODE || !env.PASSWORD_HMAC_KEY || !env.SESSION_HMAC_KEY) {
    throw new Error("Authentication secrets are not configured");
  }
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function randomPublicCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `u_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function audit(
  env: AuthEnv,
  action: string,
  outcome: "success" | "failure",
  requestId: string,
  userId: string | null,
  metadata: Record<string, string> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO auth_audit_events (id, user_id, action, outcome, request_id, metadata_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(crypto.randomUUID(), userId, action, outcome, requestId, JSON.stringify(metadata))
    .run();
}

async function isRateLimited(env: AuthEnv, action: string, normalizedUsername: string): Promise<boolean> {
  const count = await env.DB.prepare(
    `SELECT count(*) AS count
       FROM auth_audit_events
      WHERE action = ?1
        AND outcome = 'failure'
        AND created_at >= ?2
        AND json_extract(metadata_json, '$.normalized_username') = ?3`,
  )
    .bind(action, Date.now() - LOGIN_FAILURE_WINDOW_MS, normalizedUsername)
    .first<number>("count");
  return (count ?? 0) >= LOGIN_FAILURE_LIMIT;
}

async function createSession(env: AuthEnv, userId: string): Promise<{ token: string; statement: D1PreparedStatement }> {
  const token = generateSessionToken();
  const digest = await digestSession(env.SESSION_HMAC_KEY, token);
  return {
    token,
    statement: env.DB.prepare(
      "INSERT INTO sessions (id, user_id, token_digest) VALUES (?1, ?2, ?3)",
    ).bind(crypto.randomUUID(), userId, digest),
  };
}

function trimSessionsStatement(env: AuthEnv, userId: string): D1PreparedStatement {
  return env.DB.prepare(
    `DELETE FROM sessions
      WHERE id IN (
        SELECT id FROM sessions
         WHERE user_id = ?1 AND revoked_at IS NULL
         ORDER BY last_used_at DESC, created_at DESC
         LIMIT -1 OFFSET 10
      )`,
  ).bind(userId);
}

async function register(request: Request, env: AuthEnv, requestId: string): Promise<Response> {
  requireSameOrigin(request);
  const body = await readJson(request);
  const { normalized, display } = validateRegistrationUsername(body.username);
  const password = validatePassword(body.password);
  const nickname = validateNickname(body.nickname, display);
  const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode : "";

  if (await isRateLimited(env, "register", normalized)) return json({ error: "请求过于频繁，请稍后再试" }, 429);
  if (!(await verifySecret(inviteCode, env.REGISTRATION_INVITE_CODE))) {
    await audit(env, "register", "failure", requestId, null, { normalized_username: normalized });
    return json({ error: "邀请码无效" }, 403);
  }

  const exists = await env.DB.prepare("SELECT 1 AS found FROM users WHERE normalized_username = ?1")
    .bind(normalized)
    .first<number>("found");
  if (exists) return json({ error: "用户名已存在" }, 409);

  const userId = crypto.randomUUID();
  const passwordDigest = await digestPassword(env.PASSWORD_HMAC_KEY, normalized, password);
  const publicCode = randomPublicCode();
  const { token, statement: sessionStatement } = await createSession(env, userId);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, normalized_username, display_username, password_digest, password_version)
         VALUES (?1, ?2, ?3, ?4, 1)`,
      ).bind(userId, normalized, display, passwordDigest),
      env.DB.prepare(
        "INSERT INTO profiles (user_id, public_code, nickname) VALUES (?1, ?2, ?3)",
      ).bind(userId, publicCode, nickname),
      sessionStatement,
      env.DB.prepare(
        `INSERT INTO auth_audit_events (id, user_id, action, outcome, request_id, metadata_json)
         VALUES (?1, ?2, 'register', 'success', ?3, '{}')`,
      ).bind(crypto.randomUUID(), userId, requestId),
      trimSessionsStatement(env, userId),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      return json({ error: "用户名已存在" }, 409);
    }
    throw error;
  }

  return json(
    { user: userJson({
      id: userId,
      normalized_username: normalized,
      display_username: display,
      password_digest: passwordDigest,
      password_version: 1,
      status: "active",
      public_code: publicCode,
      nickname,
      avatar_url: null,
    }), session: { authenticated: true } },
    201,
    { "Set-Cookie": sessionCookie(token) },
  );
}

async function login(request: Request, env: AuthEnv, requestId: string): Promise<Response> {
  requireSameOrigin(request);
  const body = await readJson(request);
  const { normalized } = normalizeUsername(body.username);
  const password = validatePassword(body.password);
  if (await isRateLimited(env, "login", normalized)) return json({ error: "请求过于频繁，请稍后再试" }, 429);

  const user = await env.DB.prepare(
    `SELECT u.id, u.normalized_username, u.display_username, u.password_digest,
            u.password_version, u.status, p.public_code, p.nickname, p.avatar_url
       FROM users u JOIN profiles p ON p.user_id = u.id
      WHERE u.normalized_username = ?1`,
  )
    .bind(normalized)
    .first<SessionUser>();
  const candidateDigest = await digestPassword(env.PASSWORD_HMAC_KEY, normalized, password);
  const valid = await verifySecret(candidateDigest, user?.password_digest ?? "0".repeat(64));
  if (!user || user.status !== "active" || !valid) {
    await audit(env, "login", "failure", requestId, user?.id ?? null, { normalized_username: normalized });
    return json({ error: "用户名或密码错误" }, 401);
  }

  const { token, statement } = await createSession(env, user.id);
  await env.DB.batch([
    statement,
    env.DB.prepare(
      `INSERT INTO auth_audit_events (id, user_id, action, outcome, request_id, metadata_json)
       VALUES (?1, ?2, 'login', 'success', ?3, '{}')`,
    ).bind(crypto.randomUUID(), user.id, requestId),
    trimSessionsStatement(env, user.id),
  ]);
  return json({ user: userJson(user), session: { authenticated: true } }, 200, {
    "Set-Cookie": sessionCookie(token),
  });
}

async function me(request: Request, env: AuthEnv): Promise<Response> {
  const session = await findSession(env, request);
  if (!session) return json({ user: null, session: { authenticated: false } });
  await env.DB.prepare(
    "UPDATE sessions SET last_used_at = ?1 WHERE token_digest = ?2 AND last_used_at < ?3",
  )
    .bind(Date.now(), session.tokenDigest, Date.now() - 5 * 60 * 1000)
    .run();
  return json({ user: userJson(session.user), session: { authenticated: true } });
}

async function logout(request: Request, env: AuthEnv, requestId: string): Promise<Response> {
  requireSameOrigin(request);
  const session = await findSession(env, request);
  if (session) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE token_digest = ?1").bind(session.tokenDigest),
      env.DB.prepare(
        `INSERT INTO auth_audit_events (id, user_id, action, outcome, request_id, metadata_json)
         VALUES (?1, ?2, 'logout', 'success', ?3, '{}')`,
      ).bind(crypto.randomUUID(), session.user.id, requestId),
    ]);
  }
  return json({ session: { authenticated: false } }, 200, { "Set-Cookie": clearSessionCookie() });
}

async function changePassword(request: Request, env: AuthEnv, requestId: string): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const currentPassword = validatePassword(body.currentPassword);
  const newPassword = validatePassword(body.newPassword);
  const currentDigest = await digestPassword(
    env.PASSWORD_HMAC_KEY,
    session.user.normalized_username,
    currentPassword,
  );
  if (!(await verifySecret(currentDigest, session.user.password_digest))) {
    await audit(env, "change_password", "failure", requestId, session.user.id);
    return json({ error: "当前密码错误" }, 401);
  }

  const newDigest = await digestPassword(
    env.PASSWORD_HMAC_KEY,
    session.user.normalized_username,
    newPassword,
  );
  const { token, statement } = await createSession(env, session.user.id);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_digest = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(newDigest, Date.now(), session.user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(session.user.id),
    statement,
    env.DB.prepare(
      `INSERT INTO auth_audit_events (id, user_id, action, outcome, request_id, metadata_json)
       VALUES (?1, ?2, 'change_password', 'success', ?3, '{}')`,
    ).bind(crypto.randomUUID(), session.user.id, requestId),
  ]);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
}

async function updateProfile(request: Request, env: AuthEnv): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const nickname = validateNickname(body.nickname, session.user.nickname);
  let avatarUrl: string | null = session.user.avatar_url;
  if (body.avatarUrl === null || body.avatarUrl === "") avatarUrl = null;
  else if (body.avatarUrl !== undefined) {
    if (typeof body.avatarUrl !== "string" || body.avatarUrl.length > 2048) {
      throw new AuthValidationError("头像地址无效", "request");
    }
    let parsed: URL;
    try {
      parsed = new URL(body.avatarUrl);
    } catch {
      throw new AuthValidationError("头像地址无效", "request");
    }
    if (parsed.protocol !== "https:") throw new AuthValidationError("头像地址必须使用 HTTPS", "request");
    avatarUrl = parsed.toString();
  }

  await env.DB.prepare(
    "UPDATE profiles SET nickname = ?1, avatar_url = ?2, updated_at = ?3 WHERE user_id = ?4",
  )
    .bind(nickname, avatarUrl, Date.now(), session.user.id)
    .run();
  return json({ user: { ...userJson(session.user), nickname, avatarUrl } });
}

async function exportAccount(request: Request, env: AuthEnv): Promise<Response> {
  const session = await requireSession(env, request);
  const userId = session.user.id;
  const [profile, presets, customCards, decks, deckVersions, matches, players, scoreEvents, cardEvents, contacts] = await env.DB.batch([
    env.DB.prepare(
      `SELECT u.id, u.display_username AS username, u.created_at, u.updated_at,
              p.public_code, p.nickname, p.avatar_url
         FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = ?1`,
    ).bind(userId),
    env.DB.prepare("SELECT * FROM score_presets WHERE owner_user_id = ?1 ORDER BY created_at").bind(userId),
    env.DB.prepare("SELECT * FROM custom_cards WHERE owner_user_id = ?1 ORDER BY created_at").bind(userId),
    env.DB.prepare("SELECT * FROM decks WHERE owner_user_id = ?1 ORDER BY created_at").bind(userId),
    env.DB.prepare(
      "SELECT dv.* FROM deck_versions dv JOIN decks d ON d.id = dv.deck_id WHERE d.owner_user_id = ?1 ORDER BY dv.created_at",
    ).bind(userId),
    env.DB.prepare(
      `SELECT DISTINCT m.* FROM matches m
        LEFT JOIN match_players mp ON mp.match_id = m.id AND mp.user_id = ?1
       WHERE m.owner_user_id = ?1 OR mp.user_id = ?1 ORDER BY m.created_at`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT mp.* FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE m.owner_user_id = ?1 OR EXISTS (
         SELECT 1 FROM match_players mine WHERE mine.match_id = m.id AND mine.user_id = ?1
       ) ORDER BY mp.match_id, mp.seat_no`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT se.* FROM score_events se JOIN matches m ON m.id = se.match_id
       WHERE m.owner_user_id = ?1 OR EXISTS (
         SELECT 1 FROM match_players mine WHERE mine.match_id = m.id AND mine.user_id = ?1
       ) ORDER BY se.match_id, se.sequence_no`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT ce.* FROM card_events ce JOIN matches m ON m.id = ce.match_id
       WHERE m.owner_user_id = ?1 OR EXISTS (
         SELECT 1 FROM match_players mine WHERE mine.match_id = m.id AND mine.user_id = ?1
       ) ORDER BY ce.match_id, ce.sequence_no`,
    ).bind(userId),
    env.DB.prepare(
      "SELECT owner_user_id, contact_user_id, status, source, last_played_at, created_at, updated_at FROM player_contacts WHERE owner_user_id = ?1 ORDER BY created_at",
    ).bind(userId),
  ]);
  const body = {
    formatVersion: 1,
    exportedAt: Date.now(),
    profile: profile.results[0] ?? null,
    presets: presets.results,
    customCards: customCards.results,
    decks: decks.results,
    deckVersions: deckVersions.results,
    matches: matches.results,
    matchPlayers: players.results,
    scoreEvents: scoreEvents.results,
    cardEvents: cardEvents.results,
    contacts: contacts.results,
  };
  return json(body, 200, { "Content-Disposition": `attachment; filename="hei8-account-${session.user.public_code}.json"` });
}

async function deleteAccount(request: Request, env: AuthEnv, requestId: string): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const password = validatePassword(body.password);
  const digest = await digestPassword(env.PASSWORD_HMAC_KEY, session.user.normalized_username, password);
  if (!(await verifySecret(digest, session.user.password_digest))) return json({ error: "密码错误，账号未删除" }, 401);
  const now = Date.now();

  await env.DB.batch([
    // Shared participant-visible matches survive by transferring ownership to the first linked account.
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
    ).bind(session.user.id, now),
    env.DB.prepare("DELETE FROM matches WHERE owner_user_id = ?1").bind(session.user.id),
    env.DB.prepare("UPDATE match_players SET user_id = NULL WHERE user_id = ?1").bind(session.user.id),
    env.DB.prepare(
      `INSERT INTO auth_audit_events (id, user_id, action, outcome, request_id, metadata_json, created_at)
       VALUES (?1, ?2, 'delete_account', 'success', ?3, '{}', ?4)`,
    ).bind(crypto.randomUUID(), session.user.id, requestId, now),
    env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(session.user.id),
  ]);
  return json({ deleted: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

export async function handleApiRequest(request: Request, env: AuthEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const requestId = request.headers.get("CF-Ray") ?? request.headers.get("X-Request-ID") ?? crypto.randomUUID();
  try {
    requireSecrets(env);
    if (pathname === "/api/auth/register" && request.method === "POST") return await register(request, env, requestId);
    if (pathname === "/api/auth/login" && request.method === "POST") return await login(request, env, requestId);
    if (pathname === "/api/auth/me" && request.method === "GET") return await me(request, env);
    if (pathname === "/api/auth/logout" && request.method === "POST") return await logout(request, env, requestId);
    if (pathname === "/api/auth/change-password" && request.method === "POST") {
      return await changePassword(request, env, requestId);
    }
    if (pathname === "/api/profile" && request.method === "PATCH") return await updateProfile(request, env);
    if (pathname === "/api/account/export" && request.method === "GET") return await exportAccount(request, env);
    if (pathname === "/api/account" && request.method === "DELETE") return await deleteAccount(request, env, requestId);
    if (pathname.startsWith("/api/auth/") || pathname === "/api/profile") {
      return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST, PATCH" });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof AuthValidationError) return json({ error: error.message, field: error.field }, 400);
    if (error instanceof Error && error.message === "Authentication secrets are not configured") {
      return json({ error: "认证服务尚未配置" }, 503);
    }
    console.error(JSON.stringify({ level: "error", event: "auth_api_failure", requestId }));
    return json({ error: "服务器内部错误", requestId }, 500);
  }
}
