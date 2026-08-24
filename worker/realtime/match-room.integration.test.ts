import { applyD1Migrations, env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchRoom, RoomPayload } from "./match-room";
import { initializeRoomWithRetry, type RealtimeRequestContext, type RoomInitializationInput } from "./api";
import { initRoomCards, redealRoomCards } from "./room-cards";

declare const __D1_MIGRATIONS__: D1Migration[];

declare global {
  // Runtime test bindings augment the generated Cloudflare environment.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      MATCH_ROOM: DurableObjectNamespace<MatchRoom>;
      REGISTRATION_INVITE_CODE: string;
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
    env.DB.prepare("DELETE FROM realtime_rooms"),
    env.DB.prepare("DELETE FROM match_players"),
    env.DB.prepare("DELETE FROM matches"),
    env.DB.prepare("DELETE FROM devices"),
    env.DB.prepare("DELETE FROM auth_audit_events"),
    env.DB.prepare("DELETE FROM users"),
  ]);
});

function cookieValue(response: Response): string {
  return (response.headers.get("Set-Cookie") ?? "").split(";", 1)[0];
}

let registrationSequence = 0;

async function register(username = "room_host"): Promise<{ cookie: string; userId: string }> {
  registrationSequence += 1;
  const compactUsername = `r${registrationSequence.toString(36).padStart(7, "0")}`;
  const response = await SELF.fetch("http://example.com/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://example.com" },
    body: JSON.stringify({ username: compactUsername, nickname: username, password: "secret1", inviteCode: "replace-with-test-invite-code" }),
  });
  expect(response.status).toBe(201);
  const payload = await response.clone().json() as { user: { id: string } };
  return { cookie: cookieValue(response), userId: payload.user.id };
}

describe("R4 MatchRoom Durable Object", () => {
  it("retries a transient room initialization failure exactly once", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const input: RoomInitializationInput = {
      matchId: crypto.randomUUID(),
      roomCode: "RTY234",
      host: { userId: "host-retry", nickname: "Host", role: "host", joinedAt: 1 },
    };
    const context: RealtimeRequestContext = {
      requestId: crypto.randomUUID(),
      stage: "initialize_do",
      matchId: input.matchId,
      reusedRoom: false,
      attempt: 0,
    };

    const result = await initializeRoomWithRetry({
      async initialize() {
        calls += 1;
        if (calls === 1) throw new Error("injected transient failure");
        return { recovered: true };
      },
    }, input, context);

    expect(result).toEqual({ recovered: true });
    expect(calls).toBe(2);
    expect(context.attempt).toBe(2);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0][0]).toContain('"stage":"initialize_do"');
    expect(warning.mock.calls[0][0]).not.toContain("Cookie");
    warning.mockRestore();
  });

  it("bounds repeated room initialization failures at two attempts", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input: RoomInitializationInput = {
      matchId: crypto.randomUUID(),
      roomCode: "ERR234",
      host: { userId: "host-failure", nickname: "Host", role: "host", joinedAt: 1 },
    };
    const context: RealtimeRequestContext = {
      requestId: crypto.randomUUID(),
      stage: "initialize_do",
      matchId: input.matchId,
      reusedRoom: true,
      attempt: 0,
    };
    let calls = 0;

    await expect(initializeRoomWithRetry({
      async initialize() {
        calls += 1;
        throw new Error("injected persistent failure");
      },
    }, input, context)).rejects.toThrow("实时房间暂时不可用，请重新连接房间");
    expect(calls).toBe(2);
    expect(context.attempt).toBe(2);
    warning.mockRestore();
  });

  it("orders commands, rejects stale versions, deduplicates retries, and keeps spectators read-only", async () => {
    const room = env.MATCH_ROOM.getByName("match-room-core");
    const initialized = await room.initialize({
      matchId: crypto.randomUUID(),
      roomCode: "ABC234",
      host: { userId: "host-1", nickname: "Host", role: "host", joinedAt: 1 },
      chaseScore: {
        mode: "score",
        players: [
          { id: "player-1", nickname: "A", initialScore: 100, score: 100, active: true },
          { id: "player-2", nickname: "B", initialScore: 100, score: 100, active: true },
        ],
        rules: [{ id: "win", label: "普胜", value: 4, kind: "gain", enabled: true }],
        currentPlayerId: "player-1",
        turnStrategy: "fixed",
      },
    });
    expect(initialized.version).toBe(0);

    const first = await room.submitCommand({
      operationId: "score-op-1",
      expectedVersion: 0,
      actorUserId: "host-1",
      kind: "score.apply",
      payload: { playerId: "player-1", ruleId: "win" },
    });
    expect(first).toMatchObject({ ok: true, duplicate: false, version: 1, event: { sequenceNo: 1 } });
    await expect(room.submitCommand({
      operationId: "score-op-1",
      expectedVersion: 0,
      actorUserId: "host-1",
      kind: "score.apply",
      payload: { playerId: "player-1", ruleId: "win" },
    })).resolves.toMatchObject({ ok: true, duplicate: true, version: 1 });
    await expect(room.submitCommand({
      operationId: "stale-op",
      expectedVersion: 0,
      actorUserId: "host-1",
      kind: "turn.set",
      payload: {},
    })).resolves.toEqual({ ok: false, code: "version_conflict", currentVersion: 1 });

    await expect(room.addMember({
      operationId: "",
      expectedVersion: 1,
      userId: "invalid-member",
      nickname: "Invalid",
      role: "player",
      joinedAt: 2,
    })).resolves.toEqual({ ok: false, code: "invalid_command", currentVersion: 1 });

    const joined = await room.addMember({
      operationId: "join-spectator",
      expectedVersion: 1,
      userId: "viewer-1",
      nickname: "Viewer",
      role: "spectator",
      joinedAt: 2,
    });
    expect(joined).toMatchObject({ ok: true, version: 2 });
    await expect(room.submitCommand({
      operationId: "viewer-write",
      expectedVersion: 2,
      actorUserId: "viewer-1",
      kind: "score.apply",
      payload: { delta: 10 },
    })).resolves.toEqual({ ok: false, code: "forbidden", currentVersion: 2 });

    const snapshot = await room.getSnapshot();
    expect(snapshot.version).toBe(2);
    expect(snapshot.events.map((event) => event.sequenceNo)).toEqual([1, 2]);
    expect(snapshot.members).toHaveLength(2);
    expect(snapshot.chaseScore?.players[0].score).toBe(104);
    await expect(room.getSync(1)).resolves.toMatchObject({
      reset: false,
      fromSequenceNo: 1,
      snapshot: { version: 2, events: [{ sequenceNo: 2 }] },
    });
    await expect(room.getSync(0)).resolves.toMatchObject({
      reset: true,
      fromSequenceNo: 0,
      snapshot: { version: 2, events: [{ sequenceNo: 1 }, { sequenceNo: 2 }] },
    });
  });

  it("keeps realtime independent hands private by observer", async () => {
    const room = env.MATCH_ROOM.getByName("match-room-cards-private");
    const cards = initRoomCards({ playerIds: ["player-1", "player-2"], handSizes: [1, 1], randomIndex: () => 0 });
    await room.initialize({
      matchId: crypto.randomUUID(),
      roomCode: "CRD234",
      host: { userId: "host-1", nickname: "Host", role: "host", joinedAt: 1 },
      chaseScore: {
        mode: "score_cards",
        players: [
          { id: "player-1", nickname: "A", userId: "user-a", initialScore: 0, score: 0, active: true },
          { id: "player-2", nickname: "B", userId: "user-b", initialScore: 0, score: 0, active: true },
        ],
        rules: [{ id: "win", label: "普胜", value: 1, kind: "gain", enabled: true }],
        currentPlayerId: "player-1",
        turnStrategy: "fixed",
        cards,
      },
    });

    const host = await room.getSnapshotFor({ userId: "host-1", role: "host" });
    expect(host.chaseScore!.cards!.hands["player-1"]).toHaveLength(1);
    expect(host.chaseScore!.cards!.hands["player-2"]).toHaveLength(1);

    const playerA = await room.getSnapshotFor({ userId: "user-a", role: "player" });
    expect(playerA.chaseScore!.cards!.hands["player-1"]).toHaveLength(1);
    expect(playerA.chaseScore!.cards!.hands["player-2"]).toHaveLength(0);

    const spectator = await room.getSnapshotFor({ userId: "viewer", role: "spectator" });
    expect(spectator.chaseScore!.cards!.hands["player-1"]).toHaveLength(0);
    expect(spectator.chaseScore!.cards!.hands["player-2"]).toHaveLength(0);
  });

  it("keeps every hand key and requested hand size when starting a new card round", async () => {
    const cards = initRoomCards({ playerIds: ["player-1", "player-2"], handSizes: [2, 3], randomIndex: () => 0 });
    const redealt = redealRoomCards(cards, 2, () => 0);
    expect(Object.keys(redealt.hands)).toEqual(["player-1", "player-2"]);
    expect(redealt.hands["player-1"]).toHaveLength(2);
    expect(redealt.hands["player-2"]).toHaveLength(3);

    const exhausted = redealRoomCards({ ...cards, remaining: [], pendingHandSizes: { "player-1": 10, "player-2": 10 } }, 3, () => 0);
    expect(Object.keys(exhausted.hands)).toEqual(["player-1", "player-2"]);
    expect(Object.values(exhausted.hands).flat()).toHaveLength(5);

    const room = env.MATCH_ROOM.getByName("match-room-card-redeal");
    await room.initialize({
      matchId: crypto.randomUUID(),
      roomCode: "RDL234",
      host: { userId: "host-1", nickname: "Host", role: "host", joinedAt: 1 },
      chaseScore: {
        mode: "score_cards",
        players: [
          { id: "player-1", nickname: "A", userId: "user-a", initialScore: 0, score: 0, active: true },
          { id: "player-2", nickname: "B", userId: "user-b", initialScore: 0, score: 0, active: true },
        ],
        rules: [{ id: "win", label: "普胜", value: 1, kind: "gain", enabled: true }],
        currentPlayerId: "player-1",
        turnStrategy: "fixed",
        cards,
      },
    });
    await expect(room.submitCommand({ operationId: "redeal", expectedVersion: 0, actorUserId: "host-1", kind: "card.round.start", payload: {} })).resolves.toMatchObject({ ok: true, event: { kind: "card.round_redealt" } });
    const host = await room.getSnapshotFor({ userId: "host-1", role: "host" });
    expect(host.chaseScore!.cards!.hands["player-1"]).toHaveLength(2);
    expect(host.chaseScore!.cards!.hands["player-2"]).toHaveLength(3);
    const playerA = await room.getSnapshotFor({ userId: "user-a", role: "player" });
    expect(playerA.chaseScore!.cards!.hands["player-1"]).toHaveLength(2);
    expect(playerA.chaseScore!.cards!.hands["player-2"]).toHaveLength(0);
  });

  it("records card commands and hides draw card details from other players", async () => {
    const room = env.MATCH_ROOM.getByName("match-room-card-commands");
    const cards = initRoomCards({ playerIds: ["player-1", "player-2"], handSizes: [1, 1], randomIndex: () => 0 });
    await room.initialize({
      matchId: crypto.randomUUID(),
      roomCode: "CMD234",
      host: { userId: "host-1", nickname: "Host", role: "host", joinedAt: 1 },
      chaseScore: {
        mode: "score_cards",
        players: [
          { id: "player-1", nickname: "A", userId: "user-a", initialScore: 0, score: 0, active: true },
          { id: "player-2", nickname: "B", userId: "user-b", initialScore: 0, score: 0, active: true },
        ],
        rules: [{ id: "win", label: "普胜", value: 1, kind: "gain", enabled: true }],
        currentPlayerId: "player-1",
        turnStrategy: "fixed",
        cards,
      },
    });
    await room.addMember({ operationId: "join-a", expectedVersion: 0, userId: "user-a", nickname: "A", role: "player", joinedAt: 2 });
    const card = cards.hands["player-1"][0];
    await expect(room.submitCommand({
      operationId: "play-card",
      expectedVersion: 1,
      actorUserId: "user-a",
      kind: "card.play",
      payload: { playerId: "player-1", instanceId: card.instanceId },
    })).resolves.toMatchObject({ ok: true, event: { kind: "card.played", payload: { card: { title: card.title } } } });

    await expect(room.submitCommand({
      operationId: "draw-card",
      expectedVersion: 2,
      actorUserId: "host-1",
      kind: "card.draw",
      payload: { playerId: "player-2", count: 1 },
    })).resolves.toMatchObject({ ok: true, event: { kind: "card.drawn" } });
    const playerA = await room.getSnapshotFor({ userId: "user-a", role: "player" });
    expect(playerA.events.find((event) => event.kind === "card.played")?.payload.card).toBeTruthy();
    expect(playerA.events.find((event) => event.kind === "card.drawn")?.payload.card).toBeUndefined();
  });

  it("falls back to a bounded current snapshot when a reconnect gap is too large", async () => {
    const room = env.MATCH_ROOM.getByName("match-room-compressed-sync");
    await room.initialize({
      matchId: crypto.randomUUID(),
      roomCode: "CMP234",
      host: { userId: "host-1", nickname: "Host", role: "host", joinedAt: 1 },
      chaseScore: {
        mode: "score",
        players: [
          { id: "player-1", nickname: "A", initialScore: 0, score: 0, active: true },
          { id: "player-2", nickname: "B", initialScore: 0, score: 0, active: true },
        ],
        rules: [{ id: "win", label: "普胜", value: 1, kind: "gain", enabled: true }],
        currentPlayerId: "player-1",
        turnStrategy: "fixed",
      },
    });
    for (let version = 0; version < 201; version += 1) {
      const result = await room.submitCommand({
        operationId: `compressed-${version}`,
        expectedVersion: version,
        actorUserId: "host-1",
        kind: "turn.set",
        payload: { playerId: version % 2 === 0 ? "player-2" : "player-1" },
      });
      expect(result).toMatchObject({ ok: true, version: version + 1 });
    }

    const sync = await room.getSync(0);
    expect(sync).toMatchObject({ reset: true, fromSequenceNo: 1, snapshot: { version: 201 } });
    expect(sync.snapshot.events).toHaveLength(200);
    expect(sync.snapshot.events[0].sequenceNo).toBe(2);
    expect(sync.snapshot.events.at(-1)?.sequenceNo).toBe(201);
    expect(sync.snapshot.chaseScore?.currentPlayerId).toBe("player-2");
  });

  it("keeps fifteen simultaneous websocket clients on one ordered room state", async () => {
    const room = env.MATCH_ROOM.getByName("match-room-fifteen-clients");
    await room.initialize({
      matchId: crypto.randomUUID(),
      roomCode: "CAP234",
      host: { userId: "user-0", nickname: "Host", role: "host", joinedAt: 1 },
      chaseScore: {
        mode: "score",
        players: [
          { id: "player-1", nickname: "A", initialScore: 0, score: 0, active: true },
          { id: "player-2", nickname: "B", initialScore: 0, score: 0, active: true },
        ],
        rules: [{ id: "win", label: "普胜", value: 1, kind: "gain", enabled: true }],
        currentPlayerId: "player-1",
        turnStrategy: "fixed",
      },
    });
    for (let index = 1; index < 15; index += 1) {
      await expect(room.addMember({
        operationId: `join-${index}`,
        expectedVersion: index - 1,
        userId: `user-${index}`,
        nickname: `Member ${index}`,
        role: index === 1 ? "player" : "spectator",
        joinedAt: index + 1,
      })).resolves.toMatchObject({ ok: true, version: index });
    }

    const sockets: WebSocket[] = [];
    const initialFrames: Array<Promise<Record<string, unknown>>> = [];
    for (let index = 0; index < 15; index += 1) {
      const role = index === 0 ? "host" : index === 1 ? "player" : "spectator";
      const response = await room.fetch(new Request(`http://room.test/connect?after=14`, {
        headers: {
          Upgrade: "websocket",
          "X-Room-User-Id": `user-${index}`,
          "X-Room-Role": role,
        },
      }));
      expect(response.status).toBe(101);
      expect(response.webSocket).toBeTruthy();
      const socket = response.webSocket!;
      initialFrames.push(new Promise<Record<string, unknown>>((resolve) => {
        socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
      }));
      socket.accept();
      sockets.push(socket);
    }

    const snapshots = await Promise.all(initialFrames);
    expect(snapshots.every((frame) => frame.type === "snapshot")).toBe(true);
    expect(snapshots.every((frame) => (frame.snapshot as { version: number }).version === 14)).toBe(true);

    const broadcastFrames = sockets.slice(1).map((socket) => new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
    }));
    const hostResult = new Promise<Record<string, unknown>>((resolve) => {
      sockets[0].addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
    });
    sockets[0].send(JSON.stringify({
      type: "command",
      operationId: "capacity-score",
      expectedVersion: 14,
      kind: "score.apply",
      payload: { playerId: "player-1", ruleId: "win" },
    }));

    await expect(hostResult).resolves.toMatchObject({ type: "command-result", result: { ok: true, version: 15 } });
    const broadcasts = await Promise.all(broadcastFrames);
    expect(broadcasts).toHaveLength(14);
    expect(broadcasts.every((frame) => frame.type === "event" && frame.version === 15)).toBe(true);
    for (const socket of sockets) socket.close(1000, "test complete");
  });

  it("converges an existing connection's capability when the host changes the member's role", async () => {
    const room = env.MATCH_ROOM.getByName("match-room-role-convergence");
    await room.initialize({
      matchId: crypto.randomUUID(),
      roomCode: "CNV234",
      host: { userId: "host-1", nickname: "Host", role: "host", joinedAt: 1 },
      chaseScore: {
        mode: "score",
        players: [
          { id: "p1", nickname: "甲", initialScore: 0, score: 0, active: true },
          { id: "p2", nickname: "乙", initialScore: 0, score: 0, active: true },
        ],
        rules: [{ id: "win", label: "普胜", value: 1, kind: "gain", enabled: true }],
        currentPlayerId: "p1",
        turnStrategy: "fixed",
      },
    });
    await expect(room.addMember({
      operationId: "join-viewer",
      expectedVersion: 0,
      userId: "viewer-1",
      nickname: "Viewer",
      role: "spectator",
      joinedAt: 2,
    })).resolves.toMatchObject({ ok: true, version: 1 });

    const openSocket = async (userId: string, role: string) => {
      const response = await room.fetch(new Request("http://room.test/connect?after=1", {
        headers: { Upgrade: "websocket", "X-Room-User-Id": userId, "X-Room-Role": role },
      }));
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      socket.accept();
      // Queue frames synchronously after accept so the connect-time snapshot is
      // never missed while awaiting the second socket or the role commands.
      const queue: Record<string, unknown>[] = [];
      const waiters: Array<(frame: Record<string, unknown>) => void> = [];
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        const waiter = waiters.shift();
        if (waiter) waiter(frame);
        else queue.push(frame);
      });
      return {
        socket,
        next: (): Promise<Record<string, unknown>> => queue.length
          ? Promise.resolve(queue.shift()!)
          : new Promise((resolve) => waiters.push(resolve)),
      };
    };
    const host = await openSocket("host-1", "host");
    const viewer = await openSocket("viewer-1", "spectator");
    // Drain the initial snapshot frames so the next frame observed is the event.
    await expect(host.next()).resolves.toMatchObject({ type: "snapshot" });
    await expect(viewer.next()).resolves.toMatchObject({ type: "snapshot" });

    // Promotion: the viewer's EXISTING socket must be able to write without any
    // manual refresh or reconnect — the server refreshed its capability in place.
    const viewerBroadcast = viewer.next();
    await expect(room.assignRole({
      operationId: "promote-viewer",
      expectedVersion: 1,
      actorUserId: "host-1",
      targetUserId: "viewer-1",
      role: "player",
    })).resolves.toMatchObject({ ok: true, version: 2, event: { kind: "member.role_changed" } });
    await expect(viewerBroadcast).resolves.toMatchObject({ type: "event", version: 2 });

    const writeResult = viewer.next();
    viewer.socket.send(JSON.stringify({
      type: "command",
      operationId: "viewer-write-1",
      expectedVersion: 2,
      kind: "score.apply",
      payload: { playerId: "p1", ruleId: "win" },
    }));
    await expect(writeResult).resolves.toMatchObject({ type: "command-result", result: { ok: true, version: 3 } });

    // Demotion: the same existing socket immediately loses write power; storage
    // is the authority and every command is re-checked against it.
    const demoteBroadcast = viewer.next();
    await expect(room.assignRole({
      operationId: "demote-viewer",
      expectedVersion: 3,
      actorUserId: "host-1",
      targetUserId: "viewer-1",
      role: "spectator",
    })).resolves.toMatchObject({ ok: true, version: 4 });
    await expect(demoteBroadcast).resolves.toMatchObject({ type: "event", version: 4 });
    const rejected = viewer.next();
    viewer.socket.send(JSON.stringify({
      type: "command",
      operationId: "viewer-write-2",
      expectedVersion: 4,
      kind: "score.apply",
      payload: { playerId: "p1", ruleId: "win" },
    }));
    await expect(rejected).resolves.toMatchObject({ type: "command-result", result: { ok: false, code: "forbidden" } });

    // A stale connection that claims the old role is rejected at re-authentication.
    const forged = await room.fetch(new Request("http://room.test/connect?after=4", {
      headers: { Upgrade: "websocket", "X-Room-User-Id": "viewer-1", "X-Room-Role": "player" },
    }));
    expect(forged.status).toBe(403);

    for (const { socket } of [host, viewer]) socket.close(1000, "test complete");
  });

  it("upgrades a WebSocket through the HTTP API route without corrupting the 101 response", async () => {
    const { cookie, userId } = await register("ws_upgrade_host");
    const matchId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO matches (id, owner_user_id, mode, status, privacy) VALUES (?1, ?2, 'score', 'draft', 'private')",
    ).bind(matchId, userId).run();
    const created = await SELF.fetch("http://example.com/api/realtime/rooms", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ matchId }),
    });
    expect(created.status).toBe(201);
    const roomCode = ((await created.json()) as { room: { code: string } }).room.code;

    // Regression: the HTTP route must return the Durable Object's 101 upgrade
    // response untouched. Reconstructing it used to throw RangeError and turn
    // every realtime room connection into a 500, leaving clients read-only.
    const upgraded = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/connect?after=0`, {
      headers: { Cookie: cookie, Origin: "http://example.com", Upgrade: "websocket" },
    });
    expect(upgraded.status).toBe(101);
    expect(upgraded.webSocket).toBeTruthy();
    const socket = upgraded.webSocket!;
    const firstFrame = new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
    });
    socket.accept();
    await expect(firstFrame).resolves.toMatchObject({ type: "snapshot" });
    socket.close(1000, "test complete");
  });

  it("projects the complete chase scoring command set and keeps undo/correction append-only", async () => {
    const room = env.MATCH_ROOM.getByName("match-room-chase-complete");
    await room.initialize({
      matchId: crypto.randomUUID(),
      roomCode: "BCD345",
      host: { userId: "host-1", nickname: "Host", role: "host", joinedAt: 1 },
      chaseScore: {
        mode: "score",
        players: [
          { id: "p1", nickname: "甲", initialScore: 100, score: 100, active: true },
          { id: "p2", nickname: "乙", initialScore: 100, score: 100, active: true },
          { id: "p3", nickname: "丙", initialScore: 100, score: 100, active: true },
        ],
        rules: [
          { id: "win", label: "普胜", value: 4, kind: "gain", enabled: true },
          { id: "foul", label: "犯规", value: 1, kind: "penalty", enabled: true },
        ],
        currentPlayerId: "p1",
        turnStrategy: "fixed",
      },
    });

    const commands: Array<{ kind: string; payload: RoomPayload }> = [
      { kind: "score.apply", payload: { playerId: "p1", ruleId: "win", note: "中袋" } },
      { kind: "score.transfer", payload: { winnerId: "p2", loserIds: ["p1", "p3"], amount: 10 } },
      { kind: "score.black_gold", payload: { winnerId: "p1", baseAmount: 5 } },
      { kind: "score.handicap", payload: { beneficiaryId: "p2", grantorId: "p1", amount: 8 } },
      { kind: "score.backfill", payload: { playerId: "p3", delta: -2, label: "漏记犯规", note: "第二局" } },
      { kind: "score.correct", payload: { targetSequenceNo: 2, note: "输家选错" } },
      { kind: "score.undo", payload: {} },
      { kind: "turn.set", payload: { playerId: "p3" } },
    ];
    for (const [index, command] of commands.entries()) {
      const result = await room.submitCommand({
        operationId: `complete-${index + 1}`,
        expectedVersion: index,
        actorUserId: "host-1",
        kind: command.kind,
        payload: command.payload,
      });
      expect(result).toMatchObject({ ok: true, duplicate: false, version: index + 1 });
    }

    const snapshot = await room.getSnapshot();
    expect(snapshot.version).toBe(8);
    expect(snapshot.events).toHaveLength(8);
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      "score.recorded", "score.recorded", "score.recorded", "score.recorded",
      "score.recorded", "score.corrected", "score.corrected", "turn.changed",
    ]);
    expect(snapshot.events[5].payload).toMatchObject({ correctsSequenceNo: 2, correctionSource: "correction" });
    expect(snapshot.events[6].payload).toMatchObject({ correctsSequenceNo: 5, correctionSource: "undo" });
    expect(snapshot.chaseScore?.players.map((player) => [player.id, player.score])).toEqual([
      ["p1", 116], ["p2", 98], ["p3", 90],
    ]);
    expect(snapshot.chaseScore?.currentPlayerId).toBe("p3");

    await expect(room.submitCommand({
      operationId: "",
      expectedVersion: 8,
      actorUserId: "host-1",
      kind: "score.apply",
      payload: { playerId: "p1", ruleId: "win" },
    })).resolves.toEqual({ ok: false, code: "invalid_command", currentVersion: 8 });
    await expect(room.getSnapshot()).resolves.toMatchObject({
      version: 8,
      chaseScore: { players: [{ score: 116 }, { score: 98 }, { score: 90 }] },
    });

    await expect(room.submitCommand({
      operationId: "correct-twice",
      expectedVersion: 8,
      actorUserId: "host-1",
      kind: "score.correct",
      payload: { targetSequenceNo: 2 },
    })).resolves.toEqual({ ok: false, code: "not_found", currentVersion: 8 });
  });

  it("projects Chinese-eight wins, win types, fouls, undo, and corrections from the append-only ledger", async () => {
    const room = env.MATCH_ROOM.getByName("match-room-eight-complete");
    await room.initialize({
      matchId: crypto.randomUUID(),
      roomCode: "CDE456",
      host: { userId: "host-1", nickname: "Host", role: "host", joinedAt: 1 },
      eightBall: {
        mode: "chinese_eight",
        players: [{ id: "red", nickname: "红方" }, { id: "blue", nickname: "蓝方" }],
        raceTo: 3,
        firstServerId: "red",
        serveRule: "alternate",
        rounds: [],
        stats: {
          red: { score: 0, normal: 0, breakClear: 0, runout: 0, fouls: 0 },
          blue: { score: 0, normal: 0, breakClear: 0, runout: 0, fouls: 0 },
        },
        roundStartedAt: 100,
      },
    });

    const commands: Array<{ kind: string; payload: RoomPayload }> = [
      { kind: "eight_ball.round.record", payload: { winnerId: "red", winType: "break_clear", fouls: { red: 1, blue: 2 }, note: "炸清" } },
      { kind: "eight_ball.round.record", payload: { winnerId: "blue", winType: "runout", fouls: { red: 0, blue: 3 } } },
      { kind: "eight_ball.round.correct", payload: { roundId: "room-round-1", winnerId: "blue", winType: "normal", fouls: { red: 4, blue: 0 }, note: "首局改判" } },
      { kind: "eight_ball.round.undo", payload: {} },
      { kind: "eight_ball.round.correct", payload: { roundId: "room-round-2", winnerId: "red", winType: "break_clear", fouls: { red: 1, blue: 1 }, note: "恢复并改判" } },
    ];
    for (const [index, command] of commands.entries()) {
      await expect(room.submitCommand({
        operationId: `eight-${index + 1}`,
        expectedVersion: index,
        actorUserId: "host-1",
        kind: command.kind,
        payload: command.payload,
      })).resolves.toMatchObject({ ok: true, duplicate: false, version: index + 1 });
    }

    const snapshot = await room.getSnapshot();
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      "eight_ball.round_recorded", "eight_ball.round_recorded", "eight_ball.round_corrected",
      "eight_ball.round_corrected", "eight_ball.round_corrected",
    ]);
    expect(snapshot.events[2].payload).toMatchObject({ correctsRoundId: "room-round-1", correctionSource: "correction" });
    expect(snapshot.events[3].payload).toMatchObject({ correctsRoundId: "room-round-2", correctionSource: "undo" });
    expect(snapshot.eightBall?.stats).toEqual({
      red: { score: 1, normal: 0, breakClear: 1, runout: 0, fouls: 5 },
      blue: { score: 1, normal: 1, breakClear: 0, runout: 0, fouls: 1 },
    });
    expect(snapshot.eightBall?.rounds.map((round) => [round.winnerId, round.winType, round.serverId, round.voided])).toEqual([
      ["blue", "normal", "red", false],
      ["red", "break_clear", "blue", false],
    ]);
  });

  it("creates a host-only room index and initializes its Durable Object through the HTTP API", async () => {
    const { cookie, userId } = await register();
    const matchId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO matches (id, owner_user_id, mode, status, privacy) VALUES (?1, ?2, 'score', 'draft', 'private')",
    ).bind(matchId, userId).run();

    const response = await SELF.fetch("http://example.com/api/realtime/rooms", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ matchId }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    const payload = await response.json() as {
      room: { code: string; matchId: string; status: string };
      snapshot: { version: number; members: Array<{ userId: string; role: string }> };
    };
    expect(payload.room).toMatchObject({ matchId, status: "draft" });
    expect(payload.room.code).toMatch(/^[23456789A-HJ-NP-Z]{6}$/);
    expect(payload.snapshot).toMatchObject({ version: 0, members: [{ userId, role: "host" }] });

    const indexed = await env.DB.prepare(
      "SELECT match_id, room_code FROM realtime_rooms WHERE match_id = ?1",
    ).bind(matchId).first<{ match_id: string; room_code: string }>();
    expect(indexed).toEqual({ match_id: matchId, room_code: payload.room.code });

    const repeated = await SELF.fetch("http://example.com/api/realtime/rooms", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ matchId }),
    });
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({ room: { code: payload.room.code, matchId } });
  });

  it("recovers from a transient Durable Object initialization failure through the HTTP API without duplicate resources", async () => {
    const host = await register("fault_recovery_host");
    const matchId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO matches (id, owner_user_id, mode, status, privacy) VALUES (?1, ?2, 'score', 'draft', 'private')",
    ).bind(matchId, host.userId).run();

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Inject the transient failure at the stub boundary: the first getByName
    // returns a plain fake that fails once and then delegates to the real
    // Durable Object, so the retry path runs without pool RPC harness noise.
    const realGetByName = env.MATCH_ROOM.getByName.bind(env.MATCH_ROOM);
    const injected = new Error("injected transient DO failure");
    const getByNameSpy = vi.spyOn(env.MATCH_ROOM, "getByName").mockImplementationOnce((name: string) => {
      const realStub = realGetByName(name);
      let failed = false;
      return {
        initialize: async (input: RoomInitializationInput) => {
          if (!failed) {
            failed = true;
            throw injected;
          }
          return realStub.initialize(input);
        },
      } as unknown as DurableObjectStub<MatchRoom>;
    });
    try {
      const response = await SELF.fetch("http://example.com/api/realtime/rooms", {
        method: "POST",
        headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ matchId }),
      });
      expect(response.status).toBe(201);
      expect(response.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
      const payload = await response.json() as {
        room: { code: string; matchId: string; status: string };
        snapshot: { version: number; status: string; members: Array<{ userId: string; role: string }> };
      };
      expect(payload.room).toMatchObject({ matchId, status: "draft" });
      expect(payload.room.code).toMatch(/^[23456789A-HJ-NP-Z]{6}$/);
      expect(payload.snapshot).toMatchObject({ version: 0, status: "draft", members: [{ userId: host.userId, role: "host" }] });

      // Exactly one room code, one host member and one room state after the retried initialization.
      const rooms = await env.DB.prepare(
        "SELECT room_code FROM realtime_rooms WHERE match_id = ?1",
      ).bind(matchId).all<{ room_code: string }>();
      expect(rooms.results).toEqual([{ room_code: payload.room.code }]);

      const hostMembers = await env.DB.prepare(
        "SELECT role FROM match_players WHERE match_id = ?1 AND user_id = ?2",
      ).bind(matchId, host.userId).all<{ role: string }>();
      expect(hostMembers.results).toEqual([{ role: "host" }]);

      const state = await env.MATCH_ROOM.getByName(matchId).getSnapshot();
      expect(state).toMatchObject({
        matchId,
        roomCode: payload.room.code,
        version: 0,
        status: "draft",
        members: [{ userId: host.userId, nickname: "fault_recovery_host", role: "host" }],
      });
      expect(state.events).toHaveLength(0);

      // The retry log pinpoints the initialize_do stage and never leaks credentials.
      const retryLog = warning.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('"stage":"initialize_do"'));
      expect(retryLog).toBeDefined();
      expect(retryLog).toContain('"event":"realtime_room_initialize_retry"');
      expect(retryLog).toContain('"requestId":"');
      expect(retryLog).toContain('"attempt":1');
      expect(retryLog).toContain('"matchId":"');
      expect(retryLog).toContain('"reusedRoom":false');
      expect(retryLog).toContain('"errorName":"Error"');
      expect(retryLog).toContain('"errorMessage":"injected transient DO failure"');
      expect(retryLog).not.toContain("Cookie");
      expect(retryLog).not.toContain("session");
    } finally {
      getByNameSpy.mockRestore();
      warning.mockRestore();
    }
  });

  it("returns a retryable 503 when DO initialization keeps failing, then reuses the same room on recovery", async () => {
    const host = await register("fault_unavailable_host");
    const matchId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO matches (id, owner_user_id, mode, status, privacy) VALUES (?1, ?2, 'score', 'draft', 'private')",
    ).bind(matchId, host.userId).run();

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The first getByName returns a plain fake whose initialize always fails,
    // so both bounded retry attempts fail and the route answers 503.
    const injected = new Error("injected persistent DO failure");
    const getByNameSpy = vi.spyOn(env.MATCH_ROOM, "getByName").mockImplementationOnce(() => ({
      initialize: async () => { throw injected; },
    } as unknown as DurableObjectStub<MatchRoom>));
    try {
      const first = await SELF.fetch("http://example.com/api/realtime/rooms", {
        method: "POST",
        headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ matchId }),
      });
      expect(first.status).toBe(503);
      const firstPayload = await first.json() as {
        error: string;
        requestId: string;
        retryable: boolean;
        room: { code: string; matchId: string };
      };
      expect(firstPayload).toMatchObject({ retryable: true, room: { matchId } });
      expect(firstPayload.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(firstPayload.error).toContain("重新连接房间");
      expect(firstPayload.room.code).toMatch(/^[23456789A-HJ-NP-Z]{6}$/);

      // The failed attempt still left exactly one draft room row and one host projection for recovery.
      await expect(env.DB.prepare(
        "SELECT room_code, status FROM realtime_rooms WHERE match_id = ?1",
      ).bind(matchId).all<{ room_code: string; status: string }>()).resolves.toMatchObject({
        results: [{ room_code: firstPayload.room.code, status: "draft" }],
      });
      await expect(env.DB.prepare(
        "SELECT role FROM match_players WHERE match_id = ?1 AND user_id = ?2",
      ).bind(matchId, host.userId).all<{ role: string }>()).resolves.toMatchObject({
        results: [{ role: "host" }],
      });
      const failureLog = error.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('"event":"realtime_api_failure"'));
      expect(failureLog).toBeDefined();
      expect(failureLog).toContain('"stage":"initialize_do"');
      expect(failureLog).toContain('"errorName":"Error"');
      expect(failureLog).toContain('"errorMessage":"injected persistent DO failure"');
      expect(failureLog).not.toContain("Cookie");

      // The client "重新连接房间" action reuses the same match and room code; the DO is healthy now.
      const second = await SELF.fetch("http://example.com/api/realtime/rooms", {
        method: "POST",
        headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ matchId }),
      });
      expect(second.status).toBe(200);
      const secondPayload = await second.json() as {
        room: { code: string; matchId: string; status: string };
        snapshot: { version: number; status: string; members: Array<{ userId: string; role: string }> };
      };
      expect(secondPayload.room).toMatchObject({ code: firstPayload.room.code, matchId, status: "draft" });
      expect(secondPayload.snapshot).toMatchObject({ version: 0, status: "draft", members: [{ userId: host.userId, role: "host" }] });

      const roomsAfter = await env.DB.prepare(
        "SELECT room_code FROM realtime_rooms WHERE match_id = ?1",
      ).bind(matchId).all<{ room_code: string }>();
      expect(roomsAfter.results).toEqual([{ room_code: firstPayload.room.code }]);
      await expect(env.DB.prepare(
        "SELECT role FROM match_players WHERE match_id = ?1 AND user_id = ?2",
      ).bind(matchId, host.userId).all<{ role: string }>()).resolves.toMatchObject({
        results: [{ role: "host" }],
      });
      await expect(env.MATCH_ROOM.getByName(matchId).getSnapshot()).resolves.toMatchObject({
        roomCode: firstPayload.room.code,
        version: 0,
        status: "draft",
        members: [{ userId: host.userId, role: "host" }],
      });
    } finally {
      getByNameSpy.mockRestore();
      error.mockRestore();
    }
  });

  it("projects match-level cloud rooms for host/player only and excludes spectators", async () => {
    const host = await register("mine_host");
    const guest = await register("mine_guest");
    const matchId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO matches (id, owner_user_id, mode, status, privacy) VALUES (?1, ?2, 'score', 'draft', 'private')",
    ).bind(matchId, host.userId).run();
    const created = await SELF.fetch("http://example.com/api/realtime/rooms", {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ matchId }),
    });
    expect(created.status).toBe(201);
    const roomCode = ((await created.json()) as { room: { code: string } }).room.code;

    // The host is a match-level member from the moment the room exists.
    const hostMine = await SELF.fetch("http://example.com/api/realtime/rooms/mine", { headers: { Cookie: host.cookie } });
    expect(hostMine.status).toBe(200);
    await expect(hostMine.json()).resolves.toMatchObject({ rooms: [{ roomCode, matchId, myRole: "host" }] });

    // A spectator has no match-level projection and no participation history.
    const joined = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "mine-join-1" }),
    });
    expect(joined.status).toBe(201);
    const guestMineAsSpectator = await SELF.fetch("http://example.com/api/realtime/rooms/mine", { headers: { Cookie: guest.cookie } });
    await expect(guestMineAsSpectator.json()).resolves.toEqual({ rooms: [] });
    const guestHistoryAsSpectator = await SELF.fetch("http://example.com/api/history", { headers: { Cookie: guest.cookie } });
    await expect(guestHistoryAsSpectator.json()).resolves.toEqual({ matches: [] });

    // Promotion turns the spectator into a match-level member with an entry action.
    const promoted = await SELF.fetch(
      `http://example.com/api/realtime/rooms/${roomCode}/members/${guest.userId}`,
      {
        method: "PATCH",
        headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ operationId: "mine-promote-1", expectedVersion: 1, role: "player" }),
      },
    );
    expect(promoted.status).toBe(200);
    const guestMineAsPlayer = await SELF.fetch("http://example.com/api/realtime/rooms/mine", { headers: { Cookie: guest.cookie } });
    await expect(guestMineAsPlayer.json()).resolves.toMatchObject({ rooms: [{ roomCode, matchId, myRole: "player" }] });
    const guestHistoryAsPlayer = await SELF.fetch("http://example.com/api/history", { headers: { Cookie: guest.cookie } });
    await expect(guestHistoryAsPlayer.json()).resolves.toMatchObject({ matches: [{ id: matchId }] });

    // Leaving drops the projection again.
    const left = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/leave`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "mine-leave-1", expectedVersion: 2 }),
    });
    expect(left.status).toBe(200);
    const guestMineAfterLeave = await SELF.fetch("http://example.com/api/realtime/rooms/mine", { headers: { Cookie: guest.cookie } });
    await expect(guestMineAfterLeave.json()).resolves.toEqual({ rooms: [] });

    // Completing the room removes it from the host's active projection as well.
    const completed = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/complete`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "mine-complete-1", expectedVersion: 3 }),
    });
    expect(completed.status).toBe(200);
    const hostMineAfterComplete = await SELF.fetch("http://example.com/api/realtime/rooms/mine", { headers: { Cookie: host.cookie } });
    await expect(hostMineAfterComplete.json()).resolves.toEqual({ rooms: [] });
  });

  it("returns a retryable 503 when the D1 role projection fails and converges on the same operation id", async () => {
    const host = await register("projection_host");
    const guest = await register("projection_guest");
    const matchId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO matches (id, owner_user_id, mode, status, privacy) VALUES (?1, ?2, 'score', 'draft', 'private')",
    ).bind(matchId, host.userId).run();
    const created = await SELF.fetch("http://example.com/api/realtime/rooms", {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ matchId }),
    });
    expect(created.status).toBe(201);
    const roomCode = ((await created.json()) as { room: { code: string } }).room.code;
    await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "projection-join-1" }),
    });

    const realPrepare = env.DB.prepare.bind(env.DB);
    let failOnce = true;
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (failOnce && sql.includes("UPDATE match_players SET role")) {
        failOnce = false;
        throw new Error("injected D1 projection failure");
      }
      return realPrepare(sql);
    });
    try {
      const first = await SELF.fetch(
        `http://example.com/api/realtime/rooms/${roomCode}/members/${guest.userId}`,
        {
          method: "PATCH",
          headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
          body: JSON.stringify({ operationId: "projection-role-1", expectedVersion: 1, role: "player" }),
        },
      );
      expect(first.status).toBe(503);
      const firstPayload = await first.json() as { retryable: boolean; operationId: string };
      expect(firstPayload).toMatchObject({ retryable: true, operationId: "projection-role-1" });

      // The DO already applied the change; the SAME operation id finishes the D1
      // convergence instead of leaving DO/D1/client permanently diverged.
      const second = await SELF.fetch(
        `http://example.com/api/realtime/rooms/${roomCode}/members/${guest.userId}`,
        {
          method: "PATCH",
          headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
          body: JSON.stringify({ operationId: "projection-role-1", expectedVersion: 1, role: "player" }),
        },
      );
      expect(second.status).toBe(200);
      await expect(second.json()).resolves.toMatchObject({ ok: true, duplicate: true });
      await expect(env.DB.prepare(
        "SELECT role FROM match_players WHERE match_id = ?1 AND user_id = ?2 AND left_at IS NULL",
      ).bind(matchId, guest.userId).first<string>("role")).resolves.toBe("player");
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it("hydrates an existing Chinese-eight cloud snapshot with stable D1 player ids", async () => {
    const { cookie, userId } = await register("eight_room_host");
    const matchId = crypto.randomUUID();
    const redId = crypto.randomUUID();
    const blueId = crypto.randomUUID();
    const snapshotJson = JSON.stringify({
      schemaVersion: 1,
      mode: "chinese_eight",
      status: "active",
      startedAt: 100,
      players: [{ id: "local-red", name: "红方" }, { id: "local-blue", name: "蓝方" }],
      raceTo: 5,
      firstServerId: "local-blue",
      serveRule: "winner",
      events: [{
        id: "local-round-1",
        type: "round",
        round: {
          winnerId: "local-red",
          winType: "break_clear",
          fouls: { "local-red": 1, "local-blue": 2 },
          note: "迁移局",
          startedAt: 110,
          confirmedAt: 200,
        },
      }],
    });
    await env.DB.prepare(
      "INSERT INTO matches (id, owner_user_id, mode, status, privacy, snapshot_json) VALUES (?1, ?2, 'chinese_eight', 'draft', 'private', ?3)",
    ).bind(matchId, userId, snapshotJson).run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot) VALUES (?1, ?2, 0, 'player', '红方')",
      ).bind(redId, matchId),
      env.DB.prepare(
        "INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot) VALUES (?1, ?2, 1, 'player', '蓝方')",
      ).bind(blueId, matchId),
    ]);

    const response = await SELF.fetch("http://example.com/api/realtime/rooms", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ matchId }),
    });
    expect(response.status).toBe(201);
    const payload = await response.json() as {
      snapshot: { eightBall: { firstServerId: string; rounds: Array<{ roundId: string; winnerId: string }>; stats: Record<string, { score: number; fouls: number }> } };
    };
    expect(payload.snapshot.eightBall).toMatchObject({
      firstServerId: blueId,
      rounds: [{ roundId: "baseline:local-round-1", winnerId: redId }],
    });
    expect(payload.snapshot.eightBall.stats[redId]).toMatchObject({ score: 1, fouls: 1 });
    expect(payload.snapshot.eightBall.stats[blueId]).toMatchObject({ score: 0, fouls: 2 });
  });

  it("joins by room code as spectator, lets only the host promote roles, and supports leaving", async () => {
    const host = await register("room_host");
    const guest = await register("room_guest");
    const matchId = crypto.randomUUID();
    const scoringPlayerA = crypto.randomUUID();
    const scoringPlayerB = crypto.randomUUID();
    const scoreSnapshot = JSON.stringify({
      mode: "score",
      players: [
        { id: "local-a", name: "甲", initialScore: 100, score: 100, active: true },
        { id: "local-b", name: "乙", initialScore: 100, score: 100, active: true },
      ],
      rules: [{ id: "win", label: "普胜", value: 4, kind: "gain", enabled: true }],
      currentPlayerId: "local-a",
      turnStrategy: "fixed",
    });
    await env.DB.prepare(
      "INSERT INTO matches (id, owner_user_id, mode, status, privacy, snapshot_json) VALUES (?1, ?2, 'score', 'draft', 'private', ?3)",
    ).bind(matchId, host.userId, scoreSnapshot).run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot) VALUES (?1, ?2, 0, 'player', '甲')",
      ).bind(scoringPlayerA, matchId),
      env.DB.prepare(
        "INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot) VALUES (?1, ?2, 1, 'player', '乙')",
      ).bind(scoringPlayerB, matchId),
    ]);
    const created = await SELF.fetch("http://example.com/api/realtime/rooms", {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ matchId }),
    });
    const createdPayload = await created.json() as { room: { code: string } };
    const roomCode = createdPayload.room.code;

    const joined = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "guest-join-1" }),
    });
    expect(joined.status).toBe(201);
    const joinedPayload = await joined.json() as {
      role: string;
      version: number;
      snapshot: { members: Array<{ userId: string; role: string }> };
    };
    expect(joinedPayload).toMatchObject({ role: "spectator", version: 1 });
    expect(joinedPayload.snapshot.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: guest.userId, role: "spectator" }),
    ]));
    await expect(env.DB.prepare(
      "SELECT role FROM match_players WHERE match_id = ?1 AND user_id = ?2 AND left_at IS NULL",
    ).bind(matchId, guest.userId).first<string>("role")).resolves.toBe("spectator");

    const repeatedJoin = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode.toLowerCase()}/join`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "guest-join-1" }),
    });
    expect(repeatedJoin.status).toBe(200);
    await expect(repeatedJoin.json()).resolves.toMatchObject({ duplicate: true, version: 1, role: "spectator" });

    const guestPromotion = await SELF.fetch(
      `http://example.com/api/realtime/rooms/${roomCode}/members/${guest.userId}`,
      {
        method: "PATCH",
        headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ operationId: "self-promote", expectedVersion: 1, role: "player" }),
      },
    );
    expect(guestPromotion.status).toBe(403);

    const promoted = await SELF.fetch(
      `http://example.com/api/realtime/rooms/${roomCode}/members/${guest.userId}`,
      {
        method: "PATCH",
        headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ operationId: "host-promote-1", expectedVersion: 1, role: "player" }),
      },
    );
    expect(promoted.status).toBe(200);
    await expect(promoted.json()).resolves.toMatchObject({ ok: true, version: 2, event: { kind: "member.role_changed" } });
    await expect(env.DB.prepare(
      "SELECT role FROM match_players WHERE match_id = ?1 AND user_id = ?2 AND left_at IS NULL",
    ).bind(matchId, guest.userId).first<string>("role")).resolves.toBe("player");

    const playerCommand = await env.MATCH_ROOM.getByName(matchId).submitCommand({
      operationId: "player-score-1",
      expectedVersion: 2,
      actorUserId: guest.userId,
      kind: "score.apply",
      payload: { playerId: scoringPlayerA, ruleId: "win" },
    });
    expect(playerCommand).toMatchObject({ ok: true, version: 3 });

    const left = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/leave`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "guest-leave-1", expectedVersion: 3 }),
    });
    expect(left.status).toBe(200);
    await expect(left.json()).resolves.toMatchObject({ ok: true, version: 4, event: { kind: "member.left" } });
    await expect(env.DB.prepare(
      "SELECT left_at FROM match_players WHERE match_id = ?1 AND user_id = ?2",
    ).bind(matchId, guest.userId).first<number | null>("left_at")).resolves.toEqual(expect.any(Number));

    const afterLeave = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}`, {
      headers: { Cookie: guest.cookie },
    });
    expect(afterLeave.status).toBe(404);

    const hostLeave = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/leave`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "host-leave", expectedVersion: 4 }),
    });
    expect(hostLeave.status).toBe(403);
  });

  it("P1: lets the host bind a promoted member to a seat so the scoreboard shows the registered nickname", async () => {
    const host = await register("claim_host");
    const guest = await register("claim_guest");
    const matchId = crypto.randomUUID();
    const seatA = crypto.randomUUID();
    const seatB = crypto.randomUUID();
    const scoreSnapshot = JSON.stringify({
      mode: "score",
      players: [
        { id: "local-a", name: "玩家 A", initialScore: 100, score: 100, active: true },
        { id: "local-b", name: "玩家 B", initialScore: 100, score: 100, active: true },
      ],
      rules: [{ id: "win", label: "普胜", value: 4, kind: "gain", enabled: true }],
      currentPlayerId: "local-a",
      turnStrategy: "fixed",
    });
    await env.DB.prepare(
      "INSERT INTO matches (id, owner_user_id, mode, status, privacy, snapshot_json) VALUES (?1, ?2, 'score', 'draft', 'private', ?3)",
    ).bind(matchId, host.userId, scoreSnapshot).run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot) VALUES (?1, ?2, 0, 'player', '玩家 A')",
      ).bind(seatA, matchId),
      env.DB.prepare(
        "INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot) VALUES (?1, ?2, 1, 'player', '玩家 B')",
      ).bind(seatB, matchId),
    ]);
    const created = await SELF.fetch("http://example.com/api/realtime/rooms", {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ matchId }),
    });
    const roomCode = ((await created.json()) as { room: { code: string } }).room.code;

    // Guest joins as spectator, then the host promotes them to player.
    await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "claim-join-1" }),
    });
    const promoted = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/members/${guest.userId}`, {
      method: "PATCH",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "claim-promote-1", expectedVersion: 1, role: "player" }),
    });
    expect(promoted.status).toBe(200);

    // Before claiming, the guest's seat still shows the draft placeholder name.
    const before = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}`, { headers: { Cookie: host.cookie } });
    const beforePayload = await before.json() as { snapshot: { version: number; chaseScore: { players: Array<{ nickname: string }> } } };
    expect(beforePayload.snapshot.chaseScore.players.map((player) => player.nickname)).toEqual(["玩家 A", "玩家 B"]);

    // Host claims seat A for the guest: the seat now displays the guest's registered nickname.
    const claimed = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${seatA}/claim`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "claim-seat-1", expectedVersion: beforePayload.snapshot.version, userId: guest.userId }),
    });
    expect(claimed.status).toBe(200);
    const claimedPayload = await claimed.json() as {
      ok: boolean;
      duplicate: boolean;
      version: number;
      event: { kind: string; payload: { playerId: string; userId: string; nickname: string } };
    };
    expect(claimedPayload).toMatchObject({ ok: true, duplicate: false, event: { kind: "player.claimed" } });
    expect(claimedPayload.event.payload).toMatchObject({ playerId: seatA, userId: guest.userId });
    expect(claimedPayload.event.payload.nickname).not.toBe("玩家 A");
    expect(claimedPayload.event.payload.nickname.length).toBeGreaterThan(0);

    const after = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}`, { headers: { Cookie: host.cookie } });
    const afterPayload = await after.json() as { snapshot: { version: number; chaseScore: { players: Array<{ nickname: string; userId?: string }> } } };
    expect(afterPayload.snapshot.chaseScore.players[0]).toMatchObject({
      nickname: claimedPayload.event.payload.nickname,
      userId: guest.userId,
    });

    // D1 seat projection keeps the claimed nickname snapshot.
    await expect(env.DB.prepare(
      "SELECT nickname_snapshot FROM match_players WHERE id = ?1",
    ).bind(seatA).first<string>("nickname_snapshot")).resolves.toBe(claimedPayload.event.payload.nickname);

    // The host can explicitly choose their own seat too.
    const hostClaimed = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${seatB}/claim`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "claim-host-seat", expectedVersion: afterPayload.snapshot.version, userId: host.userId }),
    });
    expect(hostClaimed.status).toBe(200);
    await expect(hostClaimed.json()).resolves.toMatchObject({ event: { kind: "player.claimed", payload: { playerId: seatB, userId: host.userId, nickname: "claim_host" } } });

    // Bound seats cannot be overwritten or duplicated without a transfer flow.
    const overwrite = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${seatB}/claim`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "claim-overwrite", expectedVersion: afterPayload.snapshot.version + 1, userId: guest.userId }),
    });
    expect(overwrite.status).toBe(400);

    // A non-host member cannot claim seats.
    const forbidden = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${seatB}/claim`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "claim-forbidden", expectedVersion: afterPayload.snapshot.version + 1, userId: guest.userId }),
    });
    expect(forbidden.status).toBe(403);

    // Repeating the same claim operation is an idempotent duplicate.
    const repeated = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${seatA}/claim`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "claim-seat-1", expectedVersion: afterPayload.snapshot.version, userId: guest.userId }),
    });
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({ ok: true, duplicate: true });
  });

  it("P1: claims a Chinese-eight seat with the registered nickname", async () => {
    const host = await register("claim8_host");
    const guest = await register("claim8_guest");
    const matchId = crypto.randomUUID();
    const redSeat = crypto.randomUUID();
    const blueSeat = crypto.randomUUID();
    const snapshotJson = JSON.stringify({
      schemaVersion: 1,
      mode: "chinese_eight",
      players: [{ id: "local-red", name: "红方" }, { id: "local-blue", name: "蓝方" }],
      raceTo: null,
      firstServerId: "local-red",
      serveRule: "alternate",
      startedAt: Date.now(),
      events: [],
    });
    await env.DB.prepare(
      "INSERT INTO matches (id, owner_user_id, mode, status, privacy, snapshot_json) VALUES (?1, ?2, 'chinese_eight', 'draft', 'private', ?3)",
    ).bind(matchId, host.userId, snapshotJson).run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot) VALUES (?1, ?2, 0, 'player', '红方')",
      ).bind(redSeat, matchId),
      env.DB.prepare(
        "INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot) VALUES (?1, ?2, 1, 'player', '蓝方')",
      ).bind(blueSeat, matchId),
    ]);
    const created = await SELF.fetch("http://example.com/api/realtime/rooms", {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ matchId }),
    });
    const roomCode = ((await created.json()) as { room: { code: string } }).room.code;
    await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "claim8-join-1" }),
    });
    await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/members/${guest.userId}`, {
      method: "PATCH",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "claim8-promote-1", expectedVersion: 1, role: "player" }),
    });

    const claimed = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${blueSeat}/claim`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "claim8-seat-1", expectedVersion: 2, userId: guest.userId }),
    });
    expect(claimed.status).toBe(200);
    const claimedPayload = await claimed.json() as {
      event: { payload: { playerId: string; nickname: string } };
    };
    expect(claimedPayload.event.payload).toMatchObject({ playerId: blueSeat });
    expect(claimedPayload.event.payload.nickname).not.toBe("蓝方");

    const after = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}`, { headers: { Cookie: host.cookie } });
    const afterPayload = await after.json() as { snapshot: { eightBall: { players: Array<{ nickname: string; userId?: string }> } } };
    expect(afterPayload.snapshot.eightBall.players[1]).toMatchObject({
      nickname: claimedPayload.event.payload.nickname,
      userId: guest.userId,
    });
  });

  it("renames only unclaimed temporary seats and converges the archived baseline", async () => {
    const host = await register("rename_host");
    const guest = await register("rename_guest");
    const matchId = crypto.randomUUID();
    const seatA = crypto.randomUUID();
    const seatB = crypto.randomUUID();
    const scoreSnapshot = JSON.stringify({
      mode: "score",
      players: [
        { id: seatA, name: "甲", initialScore: 100, score: 100, active: true },
        { id: seatB, name: "乙", initialScore: 100, score: 100, active: true },
      ],
      rules: [{ id: "win", label: "普胜", value: 4, kind: "gain", enabled: true }],
      currentPlayerId: seatA,
      turnStrategy: "fixed",
    });
    await env.DB.prepare(
      "INSERT INTO matches (id, owner_user_id, mode, status, privacy, snapshot_json) VALUES (?1, ?2, 'score', 'draft', 'private', ?3)",
    ).bind(matchId, host.userId, scoreSnapshot).run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot) VALUES (?1, ?2, 0, 'player', '甲')",
      ).bind(seatA, matchId),
      env.DB.prepare(
        "INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot) VALUES (?1, ?2, 1, 'player', '乙')",
      ).bind(seatB, matchId),
    ]);
    const created = await SELF.fetch("http://example.com/api/realtime/rooms", {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ matchId }),
    });
    const roomCode = ((await created.json()) as { room: { code: string } }).room.code;

    const renamed = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${seatB}/name`, {
      method: "PATCH",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "rename-seat-1", expectedVersion: 0, nickname: "老周" }),
    });
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({
      ok: true,
      duplicate: false,
      event: { kind: "player.renamed", payload: { playerId: seatB, nickname: "老周", previousNickname: "乙" } },
    });
    const after = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}`, { headers: { Cookie: host.cookie } });
    const afterPayload = await after.json() as { snapshot: { version: number; chaseScore: { players: Array<{ nickname: string }> } } };
    expect(afterPayload.snapshot.chaseScore.players[1].nickname).toBe("老周");
    await expect(env.DB.prepare(
      "SELECT nickname_snapshot FROM match_players WHERE id = ?1",
    ).bind(seatB).first<string>("nickname_snapshot")).resolves.toBe("老周");
    const baseline = await env.DB.prepare(
      "SELECT snapshot_json FROM matches WHERE id = ?1",
    ).bind(matchId).first<string>("snapshot_json");
    expect((JSON.parse(baseline!) as { players: Array<{ name: string }> }).players[1].name).toBe("老周");

    const forbidden = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${seatA}/name`, {
      method: "PATCH",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "rename-forbidden", expectedVersion: afterPayload.snapshot.version, nickname: "坏名" }),
    });
    expect(forbidden.status).toBe(403);

    await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "rename-join-1" }),
    });
    await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/members/${guest.userId}`, {
      method: "PATCH",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "rename-promote-1", expectedVersion: 2, role: "player" }),
    });
    await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${seatB}/claim`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "rename-claim-1", expectedVersion: 3, userId: guest.userId }),
    });
    const bound = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${seatB}/name`, {
      method: "PATCH",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "rename-bound", expectedVersion: 4, nickname: "不应生效" }),
    });
    expect(bound.status).toBe(403);
  });

  it("lets only the host complete a room and atomically archives its final projection to D1", async () => {
    const host = await register("archive_host");
    const guest = await register("archive_guest");
    const matchId = crypto.randomUUID();
    const playerA = crypto.randomUUID();
    const playerB = crypto.randomUUID();
    const baseline = {
      version: 1,
      id: matchId,
      mode: "score",
      status: "active",
      createdAt: 100,
      startedAt: 100,
      players: [
        { id: "local-a", name: "甲", kind: "guest", initialScore: 100, score: 100, active: true },
        { id: "local-b", name: "乙", kind: "guest", initialScore: 100, score: 100, active: true },
      ],
      currentPlayerId: "local-a",
      rules: [{ id: "win", label: "普胜", value: 4, kind: "gain", enabled: true, color: "mint" }],
      scoreEvents: [],
      turnStrategy: "fixed",
    };
    await env.DB.prepare(
      "INSERT INTO matches (id, owner_user_id, mode, status, privacy, snapshot_json) VALUES (?1, ?2, 'score', 'active', 'private', ?3)",
    ).bind(matchId, host.userId, JSON.stringify(baseline)).run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot) VALUES (?1, ?2, 0, 'player', '甲')",
      ).bind(playerA, matchId),
      env.DB.prepare(
        "INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot) VALUES (?1, ?2, 1, 'player', '乙')",
      ).bind(playerB, matchId),
    ]);
    const created = await SELF.fetch("http://example.com/api/realtime/rooms", {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ matchId }),
    });
    const roomCode = ((await created.json()) as { room: { code: string } }).room.code;
    const room = env.MATCH_ROOM.getByName(matchId);
    await expect(room.submitCommand({
      operationId: "archive-score",
      expectedVersion: 0,
      actorUserId: host.userId,
      kind: "score.apply",
      payload: { playerId: playerA, ruleId: "win" },
    })).resolves.toMatchObject({ ok: true, version: 1 });

    const guestAttempt = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/complete`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "guest-complete", expectedVersion: 1 }),
    });
    expect(guestAttempt.status).toBe(403);

    const completed = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/complete`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "host-complete", expectedVersion: 1 }),
    });
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({ ok: true, version: 2, archivePending: false });

    const archived = await env.DB.prepare(
      `SELECT m.status, m.version, m.snapshot_json, m.snapshot_checksum, m.ended_at,
              rr.status AS room_status, rr.archived_at
         FROM matches m JOIN realtime_rooms rr ON rr.match_id = m.id WHERE m.id = ?1`,
    ).bind(matchId).first<{
      status: string; version: number; snapshot_json: string; snapshot_checksum: string;
      ended_at: number; room_status: string; archived_at: number;
    }>();
    expect(archived).toMatchObject({ status: "completed", version: 2, room_status: "completed" });
    expect(archived?.snapshot_checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(archived?.ended_at).toEqual(expect.any(Number));
    expect(archived?.archived_at).toEqual(expect.any(Number));
    const finalSnapshot = JSON.parse(archived!.snapshot_json) as Record<string, unknown>;
    expect(finalSnapshot).toMatchObject({
      status: "completed",
      players: [{ id: "local-a", score: 104 }, { id: "local-b", score: 100 }],
      scoreEvents: [{ id: "realtime:archive-score", changes: { "local-a": 4 } }],
      realtimeArchive: { version: 2, events: [{ operationId: "archive-score" }, { operationId: "host-complete" }] },
    });
    await expect(room.submitCommand({
      operationId: "after-complete",
      expectedVersion: 2,
      actorUserId: host.userId,
      kind: "score.apply",
      payload: { playerId: playerA, ruleId: "win" },
    })).resolves.toEqual({ ok: false, code: "invalid_command", currentVersion: 2 });
  });

  it("keeps a failed D1 archive pending and completes it through the durable alarm", async () => {
    const host = await register("alarm_archive_host");
    const matchId = crypto.randomUUID();
    const room = env.MATCH_ROOM.getByName(matchId);
    await room.initialize({
      matchId,
      roomCode: "ALM234",
      host: { userId: host.userId, nickname: "Host", role: "host", joinedAt: 1 },
      chaseScore: {
        mode: "score",
        players: [
          { id: "stable-a", nickname: "甲", initialScore: 0, score: 0, active: true },
          { id: "stable-b", nickname: "乙", initialScore: 0, score: 0, active: true },
        ],
        rules: [{ id: "win", label: "普胜", value: 1, kind: "gain", enabled: true }],
        currentPlayerId: "stable-a",
        turnStrategy: "fixed",
      },
    });
    await expect(room.complete({
      operationId: "alarm-complete",
      expectedVersion: 0,
      actorUserId: host.userId,
    })).resolves.toMatchObject({ ok: true, version: 1, archivePending: true });

    await env.DB.prepare(
      "INSERT INTO matches (id, owner_user_id, mode, status, privacy) VALUES (?1, ?2, 'score', 'active', 'private')",
    ).bind(matchId, host.userId).run();
    await env.DB.prepare(
      "INSERT INTO realtime_rooms (match_id, room_code, status) VALUES (?1, 'ALM234', 'archiving_failed')",
    ).bind(matchId).run();

    await expect(runDurableObjectAlarm(room)).resolves.toBe(true);
    await expect(env.DB.prepare(
      "SELECT status FROM realtime_rooms WHERE match_id = ?1",
    ).bind(matchId).first<string>("status")).resolves.toBe("completed");
    await expect(env.DB.prepare(
      "SELECT status FROM matches WHERE id = ?1",
    ).bind(matchId).first<string>("status")).resolves.toBe("completed");
    await expect(room.retryArchive()).resolves.toBe(true);
  });

  it("creates a cloud match and room directly, idempotently reusing the same resources", async () => {
    const host = await register("direct_host");
    const payload = {
      operationId: "direct-op-1",
      mode: "score",
      players: [
        { name: "甲", initialScore: 100 },
        { name: "乙", initialScore: 100 },
        { name: "丙", initialScore: 100 },
      ],
      rules: [{ id: "win", label: "普胜", value: 4, kind: "gain", enabled: true }],
      turnStrategy: "fixed",
    };
    const created = await SELF.fetch("http://example.com/api/realtime/rooms/direct", {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as {
      matchId: string;
      room: { code: string; matchId: string; status: string };
      host: { userId: string; role: string };
      snapshot: { matchId: string; roomCode: string; version: number; members: Array<{ userId: string; role: string }>; chaseScore: { mode: string; players: Array<{ id: string; nickname: string; score: number }>; rules: Array<{ id: string }> } };
      reused: boolean;
    };
    expect(body.matchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.room).toMatchObject({ matchId: body.matchId, status: "draft" });
    expect(body.room.code).toMatch(/^[23456789A-HJ-NP-Z]{6}$/);
    expect(body.host).toMatchObject({ userId: host.userId, role: "host" });
    expect(body.snapshot).toMatchObject({ matchId: body.matchId, roomCode: body.room.code, version: 0 });
    expect(body.snapshot.members).toEqual([{ userId: host.userId, nickname: "direct_host", role: "host", joinedAt: expect.any(Number), playerType: "registered" }]);
    expect(body.snapshot.chaseScore).toMatchObject({
      mode: "score",
      players: [
        { nickname: "甲", score: 100 },
        { nickname: "乙", score: 100 },
        { nickname: "丙", score: 100 },
      ],
      rules: [{ id: "win" }],
    });
    expect(body.reused).toBe(false);

    // The host is a match-level member and the room appears in the main layer.
    const mine = await SELF.fetch("http://example.com/api/realtime/rooms/mine", { headers: { Cookie: host.cookie } });
    await expect(mine.json()).resolves.toMatchObject({ rooms: [{ matchId: body.matchId, roomCode: body.room.code, myRole: "host" }] });

    // Retry with the same operationId reuses match, room and players — no duplicates.
    const repeated = await SELF.fetch("http://example.com/api/realtime/rooms/direct", {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(repeated.status).toBe(200);
    const repeatedBody = await repeated.json() as { matchId: string; room: { code: string }; reused: boolean; snapshot: { version: number } };
    expect(repeatedBody).toMatchObject({ matchId: body.matchId, room: { code: body.room.code }, reused: true, snapshot: { version: 0 } });

    const matches = await env.DB.prepare("SELECT id FROM matches WHERE id = ?1").bind(body.matchId).all();
    expect(matches.results).toHaveLength(1);
    const rooms = await env.DB.prepare("SELECT room_code FROM realtime_rooms WHERE match_id = ?1").bind(body.matchId).all();
    expect(rooms.results).toEqual([{ room_code: body.room.code }]);
    const players = await env.DB.prepare(
      "SELECT seat_no, role, user_id, nickname_snapshot FROM match_players WHERE match_id = ?1 ORDER BY seat_no",
    ).bind(body.matchId).all<{ seat_no: number; role: string; user_id: string | null; nickname_snapshot: string }>();
    expect(players.results).toEqual([
      { seat_no: 0, role: "player", user_id: null, nickname_snapshot: "甲" },
      { seat_no: 1, role: "player", user_id: null, nickname_snapshot: "乙" },
      { seat_no: 2, role: "player", user_id: null, nickname_snapshot: "丙" },
      { seat_no: 3, role: "host", user_id: host.userId, nickname_snapshot: "direct_host" },
    ]);
  });

  it("creates a Chinese-eight room directly with two stable seats", async () => {
    const host = await register("direct_eight_host");
    const created = await SELF.fetch("http://example.com/api/realtime/rooms/direct", {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: "direct-eight-1",
        mode: "chinese_eight",
        players: [{ name: "红方" }, { name: "蓝方" }],
        raceTo: 5,
        serveRule: "winner",
        firstServer: 1,
      }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as {
      matchId: string;
      room: { code: string };
      snapshot: { eightBall: { mode: string; raceTo: number; serveRule: string; players: Array<{ nickname: string }> } };
    };
    expect(body.snapshot.eightBall).toMatchObject({
      mode: "chinese_eight",
      raceTo: 5,
      serveRule: "winner",
      players: [{ nickname: "红方" }, { nickname: "蓝方" }],
    });
    await expect(env.DB.prepare(
      "SELECT nickname_snapshot FROM match_players WHERE match_id = ?1 AND role = 'player' ORDER BY seat_no",
    ).bind(body.matchId).all<{ nickname_snapshot: string }>()).resolves.toMatchObject({
      results: [{ nickname_snapshot: "红方" }, { nickname_snapshot: "蓝方" }],
    });
  });

  it("resolves an owned deck version before creating a realtime room", async () => {
    const host = await register("custom_deck_host");
    const deckId = crypto.randomUUID();
    const snapshot = { formatVersion: 1, name: "混合牌组", cards: [
      { source: "official", definitionId: "card-001", quantity: 1 },
      { source: "custom", definitionId: crypto.randomUUID(), quantity: 1, snapshot: { title: "再来一杆", effect: "再打一杆", safetyLevel: "low" } },
    ] };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO decks (id, owner_user_id, name, current_version) VALUES (?1, ?2, ?3, 1)").bind(deckId, host.userId, snapshot.name),
      env.DB.prepare("INSERT INTO deck_versions (id, deck_id, version_no, snapshot_json, checksum) VALUES (?1, ?2, 1, ?3, 'test')").bind(crypto.randomUUID(), deckId, JSON.stringify(snapshot)),
    ]);
    const created = await SELF.fetch("http://example.com/api/realtime/rooms/direct", {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: "direct-custom-deck-1", mode: "score_cards",
        players: [{ name: "甲", initialScore: 0 }, { name: "乙", initialScore: 0 }],
        rules: [{ id: "win", label: "普胜", value: 4, kind: "gain", enabled: true }],
        turnStrategy: "fixed", cardMode: "independent", handSizes: [1, 1],
        deckRef: { kind: "user", deckId, versionNo: 1 },
      }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { matchId: string };
    const stored = await env.DB.prepare("SELECT snapshot_json FROM matches WHERE id = ?1").bind(body.matchId).first<string>("snapshot_json");
    expect(JSON.parse(stored!).cards.deckSnapshot).toEqual(snapshot);
  });

  it("rejects invalid direct-create drafts and requires login", async () => {
    const host = await register("direct_invalid_host");
    const cases: Array<{ body: Record<string, unknown>; status: number }> = [
      { body: { operationId: "bad-1", mode: "cards", players: [{ name: "A" }, { name: "B" }], rules: [] }, status: 400 },
      { body: { operationId: "bad-2", mode: "score", players: [{ name: "A" }], rules: [{ id: "r", label: "x", value: 1, kind: "gain", enabled: true }], turnStrategy: "fixed" }, status: 400 },
      { body: { operationId: "bad-3", mode: "score", players: [{ name: "A" }, { name: "B" }], rules: [], turnStrategy: "fixed" }, status: 400 },
      { body: { operationId: "bad-4", mode: "chinese_eight", players: [{ name: "A" }, { name: "B" }, { name: "C" }], raceTo: 5, serveRule: "alternate", firstServer: 0 }, status: 400 },
      { body: { operationId: "bad-5", mode: "score", players: [{ name: "A" }, { name: "B" }], rules: [{ id: "r", label: "x", value: -1, kind: "gain", enabled: true }], turnStrategy: "fixed" }, status: 400 },
    ];
    for (const { body, status } of cases) {
      const response = await SELF.fetch("http://example.com/api/realtime/rooms/direct", {
        method: "POST",
        headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(status);
    }
    const unauthenticated = await SELF.fetch("http://example.com/api/realtime/rooms/direct", {
      method: "POST",
      headers: { Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "anon-1", mode: "score", players: [{ name: "A" }, { name: "B" }], rules: [{ id: "r", label: "x", value: 1, kind: "gain", enabled: true }], turnStrategy: "fixed" }),
    });
    expect(unauthenticated.status).toBe(401);
  });

  it("recovers a direct-create after a transient DO initialization failure with the same operationId", async () => {
    const host = await register("direct_recovery_host");
    const payload = {
      operationId: "direct-recovery-1",
      mode: "score",
      players: [
        { name: "甲", initialScore: 0 },
        { name: "乙", initialScore: 0 },
      ],
      rules: [{ id: "win", label: "普胜", value: 4, kind: "gain", enabled: true }],
      turnStrategy: "fixed",
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const injected = new Error("injected direct-create DO failure");
    const getByNameSpy = vi.spyOn(env.MATCH_ROOM, "getByName").mockImplementationOnce(() => ({
      initialize: async () => { throw injected; },
    } as unknown as DurableObjectStub<MatchRoom>));
    try {
      const first = await SELF.fetch("http://example.com/api/realtime/rooms/direct", {
        method: "POST",
        headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // The match and draft players exist, but the DO failed: the route answers
      // a retryable 503 with the already-allocated room code.
      expect(first.status).toBe(503);
      const firstPayload = await first.json() as { retryable: boolean; room: { code: string; matchId: string } };
      expect(firstPayload).toMatchObject({ retryable: true });
      const matchId = firstPayload.room.matchId;
      await expect(env.DB.prepare(
        "SELECT id FROM matches WHERE id = ?1 AND owner_user_id = ?2",
      ).bind(matchId, host.userId).first()).resolves.toMatchObject({ id: matchId });
      const seats = await env.DB.prepare(
        "SELECT nickname_snapshot FROM match_players WHERE match_id = ?1 AND role = 'player' ORDER BY seat_no",
      ).bind(matchId).all<{ nickname_snapshot: string }>();
      expect(seats.results).toEqual([{ nickname_snapshot: "甲" }, { nickname_snapshot: "乙" }]);

      // Retry with the same operationId reuses match, players and room.
      const second = await SELF.fetch("http://example.com/api/realtime/rooms/direct", {
        method: "POST",
        headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(second.status).toBe(200);
      const secondPayload = await second.json() as { matchId: string; room: { code: string }; reused: boolean; snapshot: { version: number; chaseScore: { mode: string; players: Array<{ nickname: string }> } } };
      expect(secondPayload).toMatchObject({ matchId, room: { code: firstPayload.room.code }, reused: true });
      expect(secondPayload.snapshot.chaseScore).toMatchObject({ mode: "score", players: [{ nickname: "甲" }, { nickname: "乙" }] });
      await expect(env.DB.prepare(
        "SELECT room_code FROM realtime_rooms WHERE match_id = ?1",
      ).bind(matchId).all<{ room_code: string }>()).resolves.toMatchObject({ results: [{ room_code: firstPayload.room.code }] });
      await expect(env.DB.prepare(
        "SELECT COUNT(*) AS count FROM match_players WHERE match_id = ?1",
      ).bind(matchId).first<number>("count")).resolves.toBe(3);

      const retryLog = warning.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('"event":"realtime_room_initialize_retry"'));
      expect(retryLog).toBeDefined();
      expect(retryLog).toContain('"stage":"initialize_do"');
    } finally {
      getByNameSpy.mockRestore();
      warning.mockRestore();
      error.mockRestore();
    }
  });

  it("lets the host kick a registered member, close their socket, and block rejoin until unbanned", async () => {
    const host = await register("kick_host");
    const guest = await register("kick_guest");
    const matchId = crypto.randomUUID();
    const playerA = crypto.randomUUID();
    const playerB = crypto.randomUUID();
    const scoreSnapshot = JSON.stringify({
      mode: "score",
      players: [
        { id: "local-a", name: "甲", initialScore: 100, score: 100, active: true },
        { id: "local-b", name: "乙", initialScore: 100, score: 100, active: true },
      ],
      rules: [{ id: "win", label: "普胜", value: 4, kind: "gain", enabled: true }],
      currentPlayerId: "local-a",
      turnStrategy: "fixed",
    });
    await env.DB.prepare(
      "INSERT INTO matches (id, owner_user_id, mode, status, privacy, snapshot_json) VALUES (?1, ?2, 'score', 'draft', 'private', ?3)",
    ).bind(matchId, host.userId, scoreSnapshot).run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot) VALUES (?1, ?2, 0, 'player', '甲')",
      ).bind(playerA, matchId),
      env.DB.prepare(
        "INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot) VALUES (?1, ?2, 1, 'player', '乙')",
      ).bind(playerB, matchId),
    ]);
    const created = await SELF.fetch("http://example.com/api/realtime/rooms", {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ matchId }),
    });
    const roomCode = ((await created.json()) as { room: { code: string } }).room.code;

    await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "kick-join-1" }),
    });
    await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/members/${guest.userId}`, {
      method: "PATCH",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "kick-promote-1", expectedVersion: 1, role: "player" }),
    });

    // Guest holds a live WebSocket with write capability before the kick.
    const socketResponse = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/connect?after=2`, {
      headers: { Cookie: guest.cookie, Origin: "http://example.com", Upgrade: "websocket" },
    });
    expect(socketResponse.status).toBe(101);
    const guestSocket = socketResponse.webSocket!;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      guestSocket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true });
    });
    guestSocket.accept();
    const initialFrame = new Promise<Record<string, unknown>>((resolve) => {
      guestSocket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
    });
    await expect(initialFrame).resolves.toMatchObject({ type: "snapshot", snapshot: { version: 2 } });

    // Non-host cannot kick.
    const nonHostKick = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/members/${host.userId}/kick`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "guest-kick", expectedVersion: 2 }),
    });
    expect(nonHostKick.status).toBe(403);

    // Host cannot kick themselves.
    const selfKick = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/members/${host.userId}/kick`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "self-kick", expectedVersion: 2 }),
    });
    expect(selfKick.status).toBe(403);

    const kicked = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/members/${guest.userId}/kick`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "kick-1", expectedVersion: 2 }),
    });
    expect(kicked.status).toBe(200);
    await expect(kicked.json()).resolves.toMatchObject({ ok: true, version: 3, event: { kind: "member.kicked", payload: { userId: guest.userId } } });

    // The kicked member's socket is closed with the dedicated kick code.
    await expect(closed).resolves.toMatchObject({ code: 4004, reason: "kicked" });

    // D1 records the kick and the member loses match-level projection.
    await expect(env.DB.prepare(
      "SELECT kicked_at, kicked_by_user_id, left_at FROM match_players WHERE match_id = ?1 AND user_id = ?2",
    ).bind(matchId, guest.userId).first<{ kicked_at: number; kicked_by_user_id: string; left_at: number }>()).resolves.toMatchObject({
      kicked_at: expect.any(Number),
      kicked_by_user_id: host.userId,
      left_at: expect.any(Number),
    });
    await expect(SELF.fetch("http://example.com/api/realtime/rooms/mine", { headers: { Cookie: guest.cookie } })).resolves.toMatchObject({});
    const guestMine = await (await SELF.fetch("http://example.com/api/realtime/rooms/mine", { headers: { Cookie: guest.cookie } })).json() as { rooms: unknown[] };
    expect(guestMine.rooms).toEqual([]);

    // A kicked member cannot write: the DO re-checks membership per command.
    await expect(env.MATCH_ROOM.getByName(matchId).submitCommand({
      operationId: "kicked-write",
      expectedVersion: 3,
      actorUserId: guest.userId,
      kind: "score.apply",
      payload: { playerId: playerA, ruleId: "win" },
    })).resolves.toEqual({ ok: false, code: "forbidden", currentVersion: 3 });

    // Rejoining with the room code is blocked while kicked.
    const rejoin = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "kick-rejoin-1" }),
    });
    expect(rejoin.status).toBe(403);

    // Repeat kick with the SAME operation id is an idempotent success.
    const repeatSameOp = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/members/${guest.userId}/kick`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "kick-1", expectedVersion: 3 }),
    });
    expect(repeatSameOp.status).toBe(200);
    await expect(repeatSameOp.json()).resolves.toMatchObject({ ok: true, duplicate: true });

    // Repeat kick with a NEW operation id after departure is also idempotent success.
    const repeatNewOp = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/members/${guest.userId}/kick`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "kick-2", expectedVersion: 3 }),
    });
    expect(repeatNewOp.status).toBe(200);
    await expect(repeatNewOp.json()).resolves.toMatchObject({ ok: true, duplicate: true });

    // Stale version conflicts.
    const staleKick = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/members/${guest.userId}/kick`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "kick-stale", expectedVersion: 1 }),
    });
    expect(staleKick.status).toBe(409);

    // getRoom exposes the kicked member so the host can lift the restriction.
    const roomView = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}`, { headers: { Cookie: host.cookie } });
    await expect(roomView.json()).resolves.toMatchObject({ kicked: [{ userId: guest.userId, nickname: "kick_guest" }] });

    // Host lifts the restriction: the guest may rejoin as spectator.
    const unbanned = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/members/${guest.userId}/unban`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "unban-1" }),
    });
    expect(unbanned.status).toBe(200);
    const rejoined = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "kick-rejoin-2" }),
    });
    expect(rejoined.status).toBe(201);
    await expect(rejoined.json()).resolves.toMatchObject({ role: "spectator" });
    guestSocket.close(1000, "test complete");
  });

  it("removes a temporary player seat without history and keeps a scored player's history intact", async () => {
    const host = await register("remove_player_host");
    const created = await SELF.fetch("http://example.com/api/realtime/rooms/direct", {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: "remove-direct-1",
        mode: "score",
        players: [
          { name: "甲", initialScore: 0 },
          { name: "乙", initialScore: 0 },
          { name: "丙", initialScore: 0 },
        ],
        rules: [{ id: "win", label: "普胜", value: 1, kind: "gain", enabled: true }],
        turnStrategy: "fixed",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as {
      matchId: string;
      room: { code: string };
      snapshot: { version: number; chaseScore: { players: Array<{ id: string; nickname: string; active: boolean }>; currentPlayerId: string } };
    };
    const matchId = createdBody.matchId;
    const roomCode = createdBody.room.code;
    const players = createdBody.snapshot.chaseScore.players;
    const [playerA, playerB, playerC] = players;
    expect(players).toHaveLength(3);

    // Non-host cannot remove a player seat.
    const guest = await register("remove_player_guest");
    await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "remove-join-1" }),
    });
    const nonHostRemove = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${playerC.id}`, {
      method: "POST",
      headers: { Cookie: guest.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "guest-remove", expectedVersion: 1 }),
    });
    expect(nonHostRemove.status).toBe(403);

    // Score for player A so player C remains history-free, then score for B so
    // B also carries history before its seat is removed.
    await env.MATCH_ROOM.getByName(matchId).submitCommand({
      operationId: "remove-score-a",
      expectedVersion: 1,
      actorUserId: host.userId,
      kind: "score.apply",
      payload: { playerId: playerA.id, ruleId: "win" },
    });
    await env.MATCH_ROOM.getByName(matchId).submitCommand({
      operationId: "remove-score-b",
      expectedVersion: 2,
      actorUserId: host.userId,
      kind: "score.apply",
      payload: { playerId: playerB.id, ruleId: "win" },
    });

    // Remove C (no history): the seat disappears entirely.
    const removedC = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${playerC.id}`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "remove-c-1", expectedVersion: 3 }),
    });
    expect(removedC.status).toBe(200);
    await expect(removedC.json()).resolves.toMatchObject({ ok: true, version: 4, event: { kind: "player.removed", payload: { playerId: playerC.id } } });
    await expect(env.MATCH_ROOM.getByName(matchId).getSnapshot()).resolves.toMatchObject({
      version: 4,
      chaseScore: {
        players: [
          { id: playerA.id, active: true },
          { id: playerB.id, active: true },
        ],
      },
    });
    await expect(env.DB.prepare(
      "SELECT id FROM match_players WHERE id = ?1 AND match_id = ?2",
    ).bind(playerC.id, matchId).first()).resolves.toBeNull();

    // Remove B (has history): the seat is marked inactive and kept with its events.
    const removedB = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${playerB.id}`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "remove-b-1", expectedVersion: 4 }),
    });
    expect(removedB.status).toBe(200);
    await expect(removedB.json()).resolves.toMatchObject({ ok: true, version: 5, event: { kind: "player.left", payload: { playerId: playerB.id } } });
    await expect(env.MATCH_ROOM.getByName(matchId).getSnapshot()).resolves.toMatchObject({
      version: 5,
      chaseScore: {
        players: [
          { id: playerA.id, active: true, score: 1 },
          { id: playerB.id, active: false },
        ],
      },
    });
    await expect(env.DB.prepare(
      "SELECT left_at FROM match_players WHERE id = ?1 AND match_id = ?2",
    ).bind(playerB.id, matchId).first<number>("left_at")).resolves.toEqual(expect.any(Number));
    // The append-only ledger keeps the original score events.
    await expect(env.MATCH_ROOM.getByName(matchId).getSnapshot()).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ kind: "score.recorded", payload: expect.objectContaining({ playerId: playerA.id }) }),
        expect.objectContaining({ kind: "score.recorded", payload: expect.objectContaining({ playerId: playerB.id }) }),
      ]),
    });

    // Repeat removal of the already-removed seat is idempotent.
    const repeatRemove = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${playerC.id}`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "remove-c-2", expectedVersion: 5 }),
    });
    expect(repeatRemove.status).toBe(200);
    await expect(repeatRemove.json()).resolves.toMatchObject({ ok: true, duplicate: true });

    // Missing seats and stale versions are rejected.
    const missingRemove = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${crypto.randomUUID()}`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "remove-missing", expectedVersion: 5 }),
    });
    expect(missingRemove.status).toBe(404);
    const staleRemove = await SELF.fetch(`http://example.com/api/realtime/rooms/${roomCode}/players/${playerA.id}`, {
      method: "POST",
      headers: { Cookie: host.cookie, Origin: "http://example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "remove-stale", expectedVersion: 1 }),
    });
    expect(staleRemove.status).toBe(409);
  });
});
