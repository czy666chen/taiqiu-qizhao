import { applyD1Migrations, env, SELF } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { digestPassword, digestSession } from "../auth/core";

declare const __D1_MIGRATIONS__: D1Migration[];

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      PASSWORD_HMAC_KEY: string;
      SESSION_HMAC_KEY: string;
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, __D1_MIGRATIONS__);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM match_players"),
    env.DB.prepare("DELETE FROM matches"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM profiles"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM admin_sessions"),
    env.DB.prepare("DELETE FROM admin_audit_events"),
    env.DB.prepare("DELETE FROM auth_rate_limits"),
    env.DB.prepare("DELETE FROM admin_users"),
  ]);
  const digest = await digestPassword(env.PASSWORD_HMAC_KEY, "admin", "secret1");
  await env.DB.prepare(
    `INSERT INTO admin_users (id, normalized_username, display_username, password_digest)
     VALUES (?1, 'admin', 'Admin', ?2)`,
  ).bind("00000000-0000-4000-8000-000000000001", digest).run();
});

function post(path: string, body: Record<string, unknown>, cookie?: string): Promise<Response> {
  return SELF.fetch(`http://example.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://example.com",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("administrator authentication HTTP API", () => {
  it("logs in with an isolated secure session, restores it, and logs out", async () => {
    const login = await post("/api/admin/auth/login", { username: "ADMIN", password: "secret1" });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("__Host-hei8_admin_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";", 1)[0];

    const token = cookie.slice(cookie.indexOf("=") + 1);
    const digest = await digestSession(env.SESSION_HMAC_KEY, token);
    await expect(env.DB.prepare(
      "SELECT count(*) AS count FROM admin_sessions WHERE token_digest = ?1",
    ).bind(digest).first<number>("count")).resolves.toBe(1);

    const current = await SELF.fetch("http://example.com/api/admin/auth/session", {
      headers: { Cookie: cookie },
    });
    await expect(current.json()).resolves.toEqual({
      admin: { id: "00000000-0000-4000-8000-000000000001", username: "Admin" },
      session: { authenticated: true },
    });

    expect((await post("/api/admin/auth/logout", {}, cookie)).status).toBe(200);
    const afterLogout = await SELF.fetch("http://example.com/api/admin/auth/session", {
      headers: { Cookie: cookie },
    });
    await expect(afterLogout.json()).resolves.toEqual({ admin: null, session: { authenticated: false } });
  });

  it("does not accept a normal user session as an administrator session", async () => {
    const response = await SELF.fetch("http://example.com/api/admin/users", {
      headers: { Cookie: "hei8_session=not-an-admin-token" },
    });
    expect(response.status).toBe(401);
  });

  it("does not accept an expired, revoked, or administrator session outside the admin API", async () => {
    const expiredLogin = await post("/api/admin/auth/login", { username: "admin", password: "secret1" });
    const expiredCookie = (expiredLogin.headers.get("Set-Cookie") ?? "").split(";", 1)[0];
    await env.DB.prepare("UPDATE admin_sessions SET expires_at = 0").run();
    expect((await SELF.fetch("http://example.com/api/admin/users", {
      headers: { Cookie: expiredCookie },
    })).status).toBe(401);

    const revokedLogin = await post("/api/admin/auth/login", { username: "admin", password: "secret1" });
    const revokedCookie = (revokedLogin.headers.get("Set-Cookie") ?? "").split(";", 1)[0];
    await env.DB.prepare("UPDATE admin_sessions SET revoked_at = ?1 WHERE revoked_at IS NULL")
      .bind(Date.now()).run();
    expect((await SELF.fetch("http://example.com/api/admin/users", {
      headers: { Cookie: revokedCookie },
    })).status).toBe(401);

    const userSession = await SELF.fetch("http://example.com/api/auth/me", {
      headers: { Cookie: revokedCookie },
    });
    await expect(userSession.json()).resolves.toEqual({ user: null, session: { authenticated: false } });
  });

  it("lists filtered users with match summaries and cursor pagination without secrets", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, normalized_username, display_username, password_digest, status, created_at, updated_at)
         VALUES (?1, 'alpha', 'Alpha', 'digest-alpha', 'active', 300, 301),
                (?2, 'beta', 'Beta', 'digest-beta', 'active', 200, 201),
                (?3, 'gamma', 'Gamma', 'digest-gamma', 'disabled', 100, 101)`,
      ).bind(
        "10000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000002",
        "10000000-0000-4000-8000-000000000003",
      ),
      env.DB.prepare(
        `INSERT INTO profiles (user_id, public_code, nickname, created_at, updated_at)
         VALUES (?1, 'PUBALPHA', '甲选手', 300, 301),
                (?2, 'PUBBETAA', '台球乙', 200, 201),
                (?3, 'PUBGAMMA', '丙选手', 100, 101)`,
      ).bind(
        "10000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000002",
        "10000000-0000-4000-8000-000000000003",
      ),
      env.DB.prepare(
        `INSERT INTO matches (id, owner_user_id, mode, created_at, updated_at)
         VALUES ('20000000-0000-4000-8000-000000000001', ?1, 'eight-ball', 400, 400),
                ('20000000-0000-4000-8000-000000000002', ?2, 'eight-ball', 500, 500)`,
      ).bind(
        "10000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000002",
      ),
      env.DB.prepare(
        `INSERT INTO match_players (id, match_id, seat_no, user_id, nickname_snapshot)
         VALUES ('30000000-0000-4000-8000-000000000001',
                 '20000000-0000-4000-8000-000000000001', 1, ?1, '台球乙')`,
      ).bind("10000000-0000-4000-8000-000000000002"),
    ]);
    const login = await post("/api/admin/auth/login", { username: "admin", password: "secret1" });
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";", 1)[0];

    const firstPage = await SELF.fetch("http://example.com/api/admin/users?limit=2", {
      headers: { Cookie: cookie },
    });
    const firstBody = await firstPage.json<{
      users: Array<{ username: string; matchCount: number; lastMatchAt: number | null }>;
      nextCursor: string;
    }>();
    expect(firstBody.users).toEqual([
      expect.objectContaining({ username: "Alpha", matchCount: 1, lastMatchAt: 400 }),
      expect.objectContaining({ username: "Beta", matchCount: 2, lastMatchAt: 500 }),
    ]);
    expect(firstBody.nextCursor).toBeTruthy();
    expect(JSON.stringify(firstBody)).not.toMatch(/password|digest|token/i);

    const secondPage = await SELF.fetch(
      `http://example.com/api/admin/users?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      { headers: { Cookie: cookie } },
    );
    await expect(secondPage.json()).resolves.toMatchObject({
      users: [expect.objectContaining({ username: "Gamma", matchCount: 0, lastMatchAt: null })],
      nextCursor: null,
    });

    const filtered = await SELF.fetch(
      `http://example.com/api/admin/users?query=${encodeURIComponent("台球乙")}&status=active`,
      { headers: { Cookie: cookie } },
    );
    await expect(filtered.json()).resolves.toMatchObject({
      users: [expect.objectContaining({ username: "Beta", nickname: "台球乙" })],
    });

    const wildcard = await SELF.fetch(
      `http://example.com/api/admin/users?query=${encodeURIComponent("%")}`,
      { headers: { Cookie: cookie } },
    );
    await expect(wildcard.json()).resolves.toMatchObject({ users: [] });
    expect((await SELF.fetch("http://example.com/api/admin/users?status=owner", {
      headers: { Cookie: cookie },
    })).status).toBe(400);
  });

  it("returns a user detail without password or session secrets", async () => {
    const userId = "10000000-0000-4000-8000-000000000001";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
           (id, normalized_username, display_username, password_digest, status, created_at, updated_at)
         VALUES (?1, 'alpha', 'Alpha', 'digest-alpha', 'active', 300, 301)`,
      ).bind(userId),
      env.DB.prepare(
        `INSERT INTO profiles (user_id, public_code, nickname, avatar_url, created_at, updated_at)
         VALUES (?1, 'PUBALPHA', '甲选手', 'https://example.com/a.png', 300, 301)`,
      ).bind(userId),
      env.DB.prepare(
        `INSERT INTO sessions (id, user_id, token_digest, created_at, last_used_at, expires_at)
         VALUES ('40000000-0000-4000-8000-000000000001', ?1, 'user-token-digest', 310, 320, ?2)`,
      ).bind(userId, Date.now() + 60_000),
      env.DB.prepare(
        `INSERT INTO matches (id, owner_user_id, mode, status, created_at, updated_at, started_at, ended_at)
         VALUES ('20000000-0000-4000-8000-000000000001', ?1, 'eight-ball', 'completed', 400, 410, 401, 409)`,
      ).bind(userId),
      env.DB.prepare(
        `INSERT INTO auth_audit_events (id, user_id, action, outcome, request_id, metadata_json, created_at)
         VALUES ('50000000-0000-4000-8000-000000000001', ?1, 'login', 'success', 'request-1', '{}', 500)`,
      ).bind(userId),
    ]);
    const login = await post("/api/admin/auth/login", { username: "admin", password: "secret1" });
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";", 1)[0];

    const response = await SELF.fetch(`http://example.com/api/admin/users/${userId}`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      user: {
        id: userId,
        username: "Alpha",
        publicCode: "PUBALPHA",
        nickname: "甲选手",
        activeSessionCount: 1,
        matchCount: 1,
      },
      recentMatches: [expect.objectContaining({
        id: "20000000-0000-4000-8000-000000000001",
        mode: "eight-ball",
        status: "completed",
        isOwner: true,
      })],
      recentAuthEvents: [expect.objectContaining({ action: "login", outcome: "success" })],
    });
    expect(JSON.stringify(body)).not.toMatch(/passwordDigest|tokenDigest|digest-alpha|user-token-digest/i);
    expect((await SELF.fetch("http://example.com/api/admin/users/not-a-user-id", {
      headers: { Cookie: cookie },
    })).status).toBe(404);
  });

  it("resets a user password, revokes sessions, and writes both audit records", async () => {
    const userId = "10000000-0000-4000-8000-000000000001";
    const oldPasswordDigest = await digestPassword(env.PASSWORD_HMAC_KEY, "alpha", "old-secret-1");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
           (id, normalized_username, display_username, password_digest, password_version, status)
         VALUES (?1, 'alpha', 'Alpha', ?2, 3, 'active')`,
      ).bind(userId, oldPasswordDigest),
      env.DB.prepare(
        "INSERT INTO profiles (user_id, public_code, nickname) VALUES (?1, 'PUBALPHA', '甲选手')",
      ).bind(userId),
      env.DB.prepare(
        `INSERT INTO sessions (id, user_id, token_digest)
         VALUES ('40000000-0000-4000-8000-000000000001', ?1, 'old-user-session')`,
      ).bind(userId),
    ]);
    const login = await post("/api/admin/auth/login", { username: "admin", password: "secret1" });
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";", 1)[0];

    const wrong = await post(
      `/api/admin/users/${userId}/reset-password`,
      { currentPassword: "wrong11" },
      cookie,
    );
    expect(wrong.status).toBe(401);

    const reset = await post(
      `/api/admin/users/${userId}/reset-password`,
      { currentPassword: "secret1" },
      cookie,
    );
    expect(reset.status).toBe(200);
    const body = await reset.json<{ newPassword: string }>();
    expect(body.newPassword).toBe("123456");

    const user = await env.DB.prepare(
      `SELECT normalized_username, password_digest, password_version, password_reset_at
         FROM users WHERE id = ?1`,
    ).bind(userId).first<{
      normalized_username: string;
      password_digest: string;
      password_version: number;
      password_reset_at: number | null;
    }>();
    expect(user).toMatchObject({ password_version: 4 });
    expect(user?.password_reset_at).toEqual(expect.any(Number));
    expect(user?.password_digest).toBe(await digestPassword(
      env.PASSWORD_HMAC_KEY,
      user?.normalized_username ?? "",
      body.newPassword,
    ));
    await expect(env.DB.prepare(
      "SELECT count(*) AS count FROM sessions WHERE user_id = ?1",
    ).bind(userId).first<number>("count")).resolves.toBe(0);

    const userAudit = await env.DB.prepare(
      "SELECT action, outcome FROM auth_audit_events WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 1",
    ).bind(userId).first<{ action: string; outcome: string }>();
    expect(userAudit).toEqual({ action: "admin_reset_password", outcome: "success" });
    const adminAudit = await env.DB.prepare(
      `SELECT action, target_type, target_id, outcome, metadata_json
         FROM admin_audit_events WHERE action = 'reset_user_password' ORDER BY created_at`,
    ).all<{
      action: string;
      target_type: string;
      target_id: string;
      outcome: string;
      metadata_json: string;
    }>();
    expect(adminAudit.results.map(({ outcome }) => outcome)).toEqual(["failure", "success"]);
    expect(adminAudit.results.at(-1)).toMatchObject({ target_type: "user", target_id: userId });
    expect(JSON.stringify(adminAudit.results)).not.toContain(body.newPassword);
    expect((await post("/api/auth/login", { username: "alpha", password: "old-secret-1" })).status).toBe(401);
    const newLogin = await post("/api/auth/login", { username: "alpha", password: body.newPassword });
    expect(newLogin.status).toBe(200);
    await expect(newLogin.clone().json()).resolves.toMatchObject({
      user: { mustChangePassword: true },
      session: { authenticated: true, mustChangePassword: true },
    });
    const userCookie = (newLogin.headers.get("Set-Cookie") ?? "").split(";", 1)[0];
    expect((await SELF.fetch("http://example.com/api/history", {
      headers: { Cookie: userCookie },
    })).status).toBe(428);
    const changed = await SELF.fetch("http://example.com/api/auth/change-password", {
      method: "POST",
      headers: { Cookie: userCookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: "123456", newPassword: "alpha-new-secret" }),
    });
    expect(changed.status).toBe(200);
    const changedCookie = (changed.headers.get("Set-Cookie") ?? "").split(";", 1)[0];
    expect((await SELF.fetch("http://example.com/api/history", {
      headers: { Cookie: changedCookie },
    })).status).toBe(200);
    await expect(env.DB.prepare("SELECT password_reset_at FROM users WHERE id = ?1")
      .bind(userId).first<number | null>("password_reset_at")).resolves.toBeNull();
  });

  it("deletes a user account after administrator password and username confirmation", async () => {
    const userId = "10000000-0000-4000-8000-000000000001";
    const otherUserId = "10000000-0000-4000-8000-000000000002";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, normalized_username, display_username, password_digest)
         VALUES (?1, 'alpha', 'Alpha', 'digest-alpha'),
                (?2, 'beta', 'Beta', 'digest-beta')`,
      ).bind(userId, otherUserId),
      env.DB.prepare(
        `INSERT INTO profiles (user_id, public_code, nickname)
         VALUES (?1, 'PUBALPHA', '甲选手'), (?2, 'PUBBETAA', '乙选手')`,
      ).bind(userId, otherUserId),
      env.DB.prepare(
        `INSERT INTO matches (id, owner_user_id, mode, privacy)
         VALUES ('20000000-0000-4000-8000-000000000001', ?1, 'score', 'participants')`,
      ).bind(userId),
      env.DB.prepare(
        `INSERT INTO match_players (id, match_id, seat_no, user_id, nickname_snapshot)
         VALUES ('30000000-0000-4000-8000-000000000001',
                 '20000000-0000-4000-8000-000000000001', 0, ?1, '甲选手'),
                ('30000000-0000-4000-8000-000000000002',
                 '20000000-0000-4000-8000-000000000001', 1, ?2, '乙选手')`,
      ).bind(userId, otherUserId),
    ]);
    const login = await post("/api/admin/auth/login", { username: "admin", password: "secret1" });
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";", 1)[0];

    const wrong = await SELF.fetch(`http://example.com/api/admin/users/${userId}`, {
      method: "DELETE",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "http://example.com" },
      body: JSON.stringify({ currentPassword: "wrong11", confirmation: "Alpha" }),
    });
    expect(wrong.status).toBe(401);

    const deleted = await SELF.fetch(`http://example.com/api/admin/users/${userId}`, {
      method: "DELETE",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "http://example.com" },
      body: JSON.stringify({ currentPassword: "secret1", confirmation: "Alpha" }),
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ deleted: true });
    await expect(env.DB.prepare("SELECT count(*) AS count FROM users WHERE id = ?1")
      .bind(userId).first<number>("count")).resolves.toBe(0);
    await expect(env.DB.prepare("SELECT owner_user_id FROM matches WHERE id = '20000000-0000-4000-8000-000000000001'")
      .first<string>("owner_user_id")).resolves.toBe(otherUserId);
    await expect(env.DB.prepare("SELECT user_id FROM match_players WHERE id = '30000000-0000-4000-8000-000000000001'")
      .first<string | null>("user_id")).resolves.toBeNull();
    await expect(env.DB.prepare(
      "SELECT outcome FROM admin_audit_events WHERE action = 'delete_user_account' ORDER BY created_at DESC LIMIT 1",
    ).first<string>("outcome")).resolves.toBe("success");
  });

  it("refuses password resets for missing, disabled, and deleted users", async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, normalized_username, display_username, password_digest, status)
       VALUES ('10000000-0000-4000-8000-000000000001', 'disabled', 'Disabled', 'digest', 'disabled'),
              ('10000000-0000-4000-8000-000000000002', 'deleted', 'Deleted', 'digest', 'deleted')`,
    ).run();
    const login = await post("/api/admin/auth/login", { username: "admin", password: "secret1" });
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";", 1)[0];

    const cases = [
      ["10000000-0000-4000-8000-000000000099", 404, "用户不存在"],
      ["10000000-0000-4000-8000-000000000001", 409, "该用户当前不可重置密码"],
      ["10000000-0000-4000-8000-000000000002", 409, "该用户当前不可重置密码"],
    ] as const;
    for (const [userId, status, error] of cases) {
      const response = await post(
        `/api/admin/users/${userId}/reset-password`,
        { currentPassword: "secret1" },
        cookie,
      );
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error });
    }

    const audits = await env.DB.prepare(
      "SELECT outcome, metadata_json FROM admin_audit_events WHERE action = 'reset_user_password' ORDER BY rowid",
    ).all<{ outcome: string; metadata_json: string }>();
    expect(audits.results).toEqual([
      { outcome: "failure", metadata_json: '{"reason":"user_not_found"}' },
      { outcome: "failure", metadata_json: '{"reason":"user_not_active"}' },
      { outcome: "failure", metadata_json: '{"reason":"user_not_active"}' },
    ]);
  });

  it("rolls back a password reset when its administrator audit cannot be written", async () => {
    const userId = "10000000-0000-4000-8000-000000000001";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, normalized_username, display_username, password_digest, password_version, status)
         VALUES (?1, 'alpha', 'Alpha', 'old-digest', 3, 'active')`,
      ).bind(userId),
      env.DB.prepare(
        "INSERT INTO sessions (id, user_id, token_digest) VALUES ('40000000-0000-4000-8000-000000000001', ?1, 'old-user-session')",
      ).bind(userId),
    ]);
    const login = await post("/api/admin/auth/login", { username: "admin", password: "secret1" });
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";", 1)[0];
    await env.DB.prepare(
      `CREATE TRIGGER reject_reset_audit BEFORE INSERT ON admin_audit_events
       WHEN NEW.action = 'reset_user_password'
       BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
    ).run();

    const response = await post(
      `/api/admin/users/${userId}/reset-password`,
      { currentPassword: "secret1" },
      cookie,
    );
    expect(response.status).toBe(500);
    const user = await env.DB.prepare(
      "SELECT password_digest, password_version, password_reset_at FROM users WHERE id = ?1",
    ).bind(userId).first<{
      password_digest: string;
      password_version: number;
      password_reset_at: number | null;
    }>();
    expect(user).toEqual({ password_digest: "old-digest", password_version: 3, password_reset_at: null });
    await expect(env.DB.prepare(
      "SELECT count(*) AS count FROM sessions WHERE user_id = ?1",
    ).bind(userId).first<number>("count")).resolves.toBe(1);
    await expect(env.DB.prepare(
      "SELECT count(*) AS count FROM auth_audit_events WHERE user_id = ?1",
    ).bind(userId).first<number>("count")).resolves.toBe(0);
    await env.DB.prepare("DROP TRIGGER reject_reset_audit").run();
  });

  it("lists and inspects matches with filters, bounded pagination, guests, and events", async () => {
    const ownerId = "10000000-0000-4000-8000-000000000001";
    const deletedPlayerId = "10000000-0000-4000-8000-000000000002";
    const matchId = "20000000-0000-4000-8000-000000000001";
    const playerId = "30000000-0000-4000-8000-000000000001";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, normalized_username, display_username, password_digest, status)
         VALUES (?1, 'alpha', 'Alpha', 'digest-alpha', 'active'),
                (?2, 'removed', 'Removed', 'digest-removed', 'deleted')`,
      ).bind(ownerId, deletedPlayerId),
      env.DB.prepare(
        `INSERT INTO profiles (user_id, public_code, nickname)
         VALUES (?1, 'PUBALPHA', '甲选手'), (?2, 'PUBREMOV', '已注销选手')`,
      ).bind(ownerId, deletedPlayerId),
      env.DB.prepare(
        `INSERT INTO matches
           (id, owner_user_id, mode, status, privacy, version, snapshot_json,
            snapshot_checksum, created_at, updated_at, started_at, ended_at)
         VALUES (?1, ?2, 'score_cards', 'completed', 'participants', 2,
                 '{"winner":"guest"}', 'checksum-1', 1000, 1010, 1001, 1009),
                ('20000000-0000-4000-8000-000000000002', ?2, 'chinese_eight',
                 'active', 'private', 0, NULL, NULL, 900, 901, 900, NULL)`,
      ).bind(matchId, ownerId),
      env.DB.prepare(
        `INSERT INTO match_players
           (id, match_id, seat_no, user_id, role, nickname_snapshot, joined_at)
         VALUES (?1, ?2, 0, ?3, 'host', '甲选手', 1001),
                ('30000000-0000-4000-8000-000000000002', ?2, 1, ?4, 'player', '旧昵称', 1001),
                ('30000000-0000-4000-8000-000000000003', ?2, 2, NULL, 'player', '游客小王', 1001)`,
      ).bind(playerId, matchId, ownerId, deletedPlayerId),
      env.DB.prepare(
        `INSERT INTO realtime_rooms (match_id, room_code, status, created_at, updated_at, archived_at)
         VALUES (?1, 'ABCD12', 'completed', 1000, 1010, 1010)`,
      ).bind(matchId),
      env.DB.prepare(
        `INSERT INTO score_events
           (id, match_id, operation_id, sequence_no, actor_user_id, player_id,
            score_delta, payload_json, occurred_at, created_at)
         VALUES ('40000000-0000-4000-8000-000000000001', ?1, 'score-op', 1, ?2, ?3,
                 5, '{"source":"manual"}', 1005, 1005)`,
      ).bind(matchId, ownerId, playerId),
      env.DB.prepare(
        `INSERT INTO card_events
           (id, match_id, operation_id, sequence_no, actor_user_id,
            card_instance_snapshot_json, score_event_id, occurred_at, created_at)
         VALUES ('50000000-0000-4000-8000-000000000001', ?1, 'card-op', 1, ?2,
                 '{"title":"加五分"}', '40000000-0000-4000-8000-000000000001', 1005, 1005)`,
      ).bind(matchId, ownerId),
      env.DB.prepare(
        `INSERT INTO match_audit_events
           (id, match_id, actor_user_id, action, before_version, after_version, metadata_json, created_at)
         VALUES ('60000000-0000-4000-8000-000000000001', ?1, ?2, 'complete', 1, 2, '{}', 1009)`,
      ).bind(matchId, ownerId),
    ]);
    expect((await SELF.fetch("http://example.com/api/admin/matches")).status).toBe(401);
    const login = await post("/api/admin/auth/login", { username: "admin", password: "secret1" });
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";", 1)[0];

    const firstPage = await SELF.fetch("http://example.com/api/admin/matches?limit=1", {
      headers: { Cookie: cookie },
    });
    const firstPageBody = await firstPage.json<{ nextCursor: string }>();
    expect(firstPageBody.nextCursor).toBeTruthy();
    const secondPage = await SELF.fetch(
      `http://example.com/api/admin/matches?limit=1&cursor=${encodeURIComponent(firstPageBody.nextCursor)}`,
      { headers: { Cookie: cookie } },
    );
    await expect(secondPage.json()).resolves.toMatchObject({
      matches: [expect.objectContaining({ id: "20000000-0000-4000-8000-000000000002" })],
      nextCursor: null,
    });

    const response = await SELF.fetch(
      "http://example.com/api/admin/matches?query=Alpha&mode=score_cards&status=completed&from=999&to=1000&limit=1",
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      matches: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>();
    expect(body.matches).toEqual([expect.objectContaining({
      id: matchId,
      mode: "score_cards",
      status: "completed",
      isRealtime: true,
      owner: expect.objectContaining({ username: "Alpha", nickname: "甲选手" }),
      players: expect.arrayContaining([
        expect.objectContaining({ nicknameSnapshot: "游客小王", userId: null }),
        expect.objectContaining({ nicknameSnapshot: "旧昵称", userStatus: "deleted" }),
      ]),
    })]);
    expect(JSON.stringify(body)).not.toMatch(/rawSnapshot|snapshotChecksum|scoreEvents|cardEvents|winner/i);

    const guestSearch = await SELF.fetch(
      `http://example.com/api/admin/matches?query=${encodeURIComponent("游客小王")}`,
      { headers: { Cookie: cookie } },
    );
    await expect(guestSearch.json()).resolves.toMatchObject({
      matches: [expect.objectContaining({ id: matchId })],
    });
    const injection = await SELF.fetch(
      `http://example.com/api/admin/matches?query=${encodeURIComponent("' OR 1=1 --")}`,
      { headers: { Cookie: cookie } },
    );
    await expect(injection.json()).resolves.toMatchObject({ matches: [] });
    expect((await SELF.fetch("http://example.com/api/admin/matches?limit=101", {
      headers: { Cookie: cookie },
    })).status).toBe(400);

    const detail = await SELF.fetch(`http://example.com/api/admin/matches/${matchId}`, {
      headers: { Cookie: cookie },
    });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      match: {
        id: matchId,
        rawSnapshot: { winner: "guest" },
        realtime: { roomCode: "ABCD12", status: "completed" },
        players: expect.arrayContaining([expect.objectContaining({ id: playerId, finalScore: 5 })]),
      },
      scoreEvents: [expect.objectContaining({
        playerNickname: "甲选手",
        scoreDelta: 5,
        payload: { source: "manual" },
      })],
      cardEvents: [expect.objectContaining({ cardInstanceSnapshot: { title: "加五分" } })],
      auditEvents: [expect.objectContaining({ action: "complete", beforeVersion: 1, afterVersion: 2 })],
    });
  });

  it("derives admin match details from locally synced snapshots when event tables are empty", async () => {
    const ownerId = "10000000-0000-4000-8000-000000000011";
    const matchId = "20000000-0000-4000-8000-000000000011";
    const firstPlayerId = "30000000-0000-4000-8000-000000000011";
    const secondPlayerId = "30000000-0000-4000-8000-000000000012";
    const snapshot = {
      schemaVersion: 1,
      id: "local-eight-ball",
      matchVersion: 2,
      mode: "chinese_eight",
      status: "completed",
      createdAt: 1000,
      startedAt: 1001,
      endedAt: 1009,
      players: [{ id: "red", name: "甲" }, { id: "blue", name: "乙" }],
      firstServerId: "red",
      serveRule: "alternate",
      events: [
        {
          id: "round-1", operationId: "round-op-1", sequenceNo: 1, matchVersion: 1,
          type: "round", occurredAt: 1005, source: "user", playerNames: { red: "甲", blue: "乙" },
          round: { winnerId: "red", winType: "normal", fouls: { red: 0, blue: 0 }, note: "", startedAt: 1002, confirmedAt: 1005 },
        },
        {
          id: "finish-1", operationId: "finish-op-1", sequenceNo: 2, matchVersion: 2,
          type: "finish", occurredAt: 1009, source: "user", playerNames: { red: "甲", blue: "乙" },
        },
      ],
      cards: {
        events: [{ id: "card-1", type: "play", label: "使用加五分", handId: "red", occurredAt: 1004, card: { instanceId: "card-instance-1", title: "加五分" } }],
      },
    };
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, normalized_username, display_username, password_digest, status) VALUES (?1, 'snapown', 'snapown', 'digest', 'active')",
      ).bind(ownerId),
      env.DB.prepare(
        `INSERT INTO matches (id, owner_user_id, mode, status, version, snapshot_json, created_at, updated_at, started_at, ended_at)
         VALUES (?1, ?2, 'chinese_eight', 'completed', 2, ?3, 1000, 1009, 1001, 1009)`,
      ).bind(matchId, ownerId, JSON.stringify(snapshot)),
      env.DB.prepare(
        `INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot, joined_at)
         VALUES (?1, ?3, 0, 'player', '甲', 1001), (?2, ?3, 1, 'player', '乙', 1001)`,
      ).bind(firstPlayerId, secondPlayerId, matchId),
    ]);
    const login = await post("/api/admin/auth/login", { username: "admin", password: "secret1" });
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";", 1)[0];

    const detail = await SELF.fetch(`http://example.com/api/admin/matches/${matchId}`, { headers: { Cookie: cookie } });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      match: { players: [expect.objectContaining({ id: firstPlayerId, finalScore: 1 }), expect.objectContaining({ id: secondPlayerId, finalScore: 0 })] },
      scoreEvents: [expect.objectContaining({ sequenceNo: 1, playerNickname: "甲", scoreDelta: 1 })],
      cardEvents: [expect.objectContaining({ sequenceNo: 1, cardInstanceSnapshot: expect.objectContaining({ title: "加五分" }) })],
      auditEvents: [
        expect.objectContaining({ action: "round", afterVersion: 1 }),
        expect.objectContaining({ action: "finish", afterVersion: 2 }),
      ],
    });
  });

  it("derives corrected team battle standings and round events from a locally synced snapshot", async () => {
    const ownerId = "10000000-0000-4000-8000-000000000021";
    const matchId = "20000000-0000-4000-8000-000000000021";
    const storedPlayerIds = [
      "30000000-0000-4000-8000-000000000021",
      "30000000-0000-4000-8000-000000000022",
      "30000000-0000-4000-8000-000000000023",
    ];
    const names = { red: "甲", blue: "乙", green: "丙" };
    const round = (playerIds: [string, string], winnerId: string, startedAt: number, confirmedAt: number) => ({
      playerIds, winnerId, winType: "normal", fouls: { [playerIds[0]]: 0, [playerIds[1]]: 0 }, note: "", startedAt, confirmedAt,
    });
    const snapshot = {
      schemaVersion: 1,
      id: "local-team-battle",
      mode: "team_battle",
      status: "completed",
      title: "周末团战",
      location: "俱乐部",
      note: "",
      createdAt: 1000,
      startedAt: 1001,
      endedAt: 1010,
      pausedDurationMs: 0,
      players: [
        { id: "red", name: "甲", joinedAt: 1001 },
        { id: "blue", name: "乙", joinedAt: 1001 },
        { id: "green", name: "丙", joinedAt: 1001 },
      ],
      events: [
        { id: "round-1", sequenceNo: 1, type: "round", occurredAt: 1004, playerNames: names, round: round(["red", "blue"], "red", 1002, 1004) },
        { id: "round-2", sequenceNo: 2, type: "round", occurredAt: 1007, playerNames: names, round: round(["red", "green"], "green", 1005, 1007) },
        { id: "correction-1", sequenceNo: 3, type: "correction", occurredAt: 1008, playerNames: names, correctsEventId: "round-2", replacement: round(["red", "green"], "red", 1005, 1008) },
        { id: "finish-1", sequenceNo: 4, type: "finish", occurredAt: 1010, playerNames: names },
      ],
    };
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, normalized_username, display_username, password_digest, status) VALUES (?1, 'teamown', 'teamown', 'digest', 'active')",
      ).bind(ownerId),
      env.DB.prepare(
        `INSERT INTO matches (id, owner_user_id, mode, status, version, snapshot_json, created_at, updated_at, started_at, ended_at)
         VALUES (?1, ?2, 'team_battle', 'completed', 4, ?3, 1000, 1010, 1001, 1010)`,
      ).bind(matchId, ownerId, JSON.stringify(snapshot)),
      env.DB.prepare(
        `INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot, joined_at)
         VALUES (?1, ?4, 0, 'player', '甲', 1001), (?2, ?4, 1, 'player', '乙', 1001), (?3, ?4, 2, 'player', '丙', 1001)`,
      ).bind(...storedPlayerIds, matchId),
    ]);
    const login = await post("/api/admin/auth/login", { username: "admin", password: "secret1" });
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";", 1)[0];

    const detail = await SELF.fetch(`http://example.com/api/admin/matches/${matchId}`, { headers: { Cookie: cookie } });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      match: { mode: "team_battle", players: [
        expect.objectContaining({ id: storedPlayerIds[0], finalScore: 2 }),
        expect.objectContaining({ id: storedPlayerIds[1], finalScore: 0 }),
        expect.objectContaining({ id: storedPlayerIds[2], finalScore: 0 }),
      ] },
      scoreEvents: [
        expect.objectContaining({ id: "round-1", sequenceNo: 1, playerNickname: "甲", scoreDelta: 1 }),
        expect.objectContaining({ id: "round-2", sequenceNo: 2, playerNickname: "甲", scoreDelta: 1, correctionEventId: "correction-1" }),
      ],
      auditEvents: [
        expect.objectContaining({ action: "round" }),
        expect.objectContaining({ action: "round" }),
        expect.objectContaining({ action: "correction", reason: "更正 round-2" }),
        expect.objectContaining({ action: "finish" }),
      ],
    });
  });

  it("changes its password, revokes every old session, and records the audit event", async () => {
    const firstLogin = await post("/api/admin/auth/login", { username: "admin", password: "secret1" });
    const firstCookie = (firstLogin.headers.get("Set-Cookie") ?? "").split(";", 1)[0];
    const secondLogin = await post("/api/admin/auth/login", { username: "admin", password: "secret1" });
    const secondCookie = (secondLogin.headers.get("Set-Cookie") ?? "").split(";", 1)[0];

    const wrong = await post(
      "/api/admin/auth/change-password",
      { currentPassword: "wrong11", newPassword: "new-secret-2" },
      firstCookie,
    );
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toEqual({ error: "当前密码错误" });

    const changed = await post(
      "/api/admin/auth/change-password",
      { currentPassword: "secret1", newPassword: "new-secret-2" },
      firstCookie,
    );
    expect(changed.status).toBe(200);
    const newCookie = (changed.headers.get("Set-Cookie") ?? "").split(";", 1)[0];
    expect(newCookie).not.toBe(firstCookie);

    const oldSession = await SELF.fetch("http://example.com/api/admin/auth/session", {
      headers: { Cookie: secondCookie },
    });
    await expect(oldSession.json()).resolves.toEqual({ admin: null, session: { authenticated: false } });
    expect((await post("/api/admin/auth/login", { username: "admin", password: "secret1" })).status).toBe(401);
    expect((await post("/api/admin/auth/login", { username: "admin", password: "new-secret-2" })).status).toBe(200);

    const admin = await env.DB.prepare(
      "SELECT password_version FROM admin_users WHERE normalized_username = 'admin'",
    ).first<number>("password_version");
    expect(admin).toBe(2);
    const outcomes = await env.DB.prepare(
      "SELECT outcome FROM admin_audit_events WHERE action = 'change_password' ORDER BY rowid",
    ).all<{ outcome: string }>();
    expect(outcomes.results.map(({ outcome }) => outcome)).toEqual(["failure", "success"]);
  });

  it("uses one error for unknown administrators and wrong passwords", async () => {
    const unknown = await post("/api/admin/auth/login", { username: "nobody", password: "secret1" });
    const wrong = await post("/api/admin/auth/login", { username: "admin", password: "wrong11" });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    await expect(unknown.json()).resolves.toEqual({ error: "用户名或密码错误" });
    await expect(wrong.json()).resolves.toEqual({ error: "用户名或密码错误" });
    const metadata = await env.DB.prepare(
      "SELECT group_concat(metadata_json, '') AS value FROM admin_audit_events",
    ).first<string>("value");
    expect(metadata).not.toContain("secret1");
    expect(metadata).not.toContain("wrong11");
  });

  it("rate limits repeated login failures", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await post("/api/admin/auth/login", { username: "admin", password: "wrong11" })).status).toBe(401);
    }
    expect((await post("/api/admin/auth/login", { username: "admin", password: "wrong11" })).status).toBe(429);
  });

  it("rejects cross-origin login", async () => {
    const response = await SELF.fetch("http://example.com/api/admin/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ username: "admin", password: "secret1" }),
    });
    expect(response.status).toBe(400);
  });
});
