import { DurableObject } from "cloudflare:workers";
import {
  projectChaseCommand,
  type ChaseScoreState,
  type JsonObject,
  type JsonValue,
} from "./chase-scoring";
import {
  projectEightBallCommand,
  type RealtimeEightBallState,
} from "./eight-ball-scoring";
import { projectRoomCardCommand } from "./room-cards";
import {
  projectRealtimeSnookerCommand,
  type RealtimeSnookerState,
} from "./snooker-scoring";
import { recordSnookerCommand } from "../../src/lib/snooker";
import {
  finishTeamBattleMatch,
  isTeamBattleMatch,
  renameTeamBattlePlayer,
} from "../../src/lib/team-battle";
import { projectTeamBattleCommand, type RealtimeTeamBattleState } from "./team-battle-scoring";

export type RoomRole = "host" | "player" | "spectator";
export type RoomPayload = JsonObject;

/**
 * 房间内参与者统一模型（ROADMAP P1/P2，见 2.1）：
 * - `nickname` 即显示名（displayName）：P1 下注册用户始终携带注册昵称快照，
 *   中途改昵称不影响本局已加入的显示。
 * - `playerType`：P1 阶段所有成员均为 `registered`；P2 游客加入时扩展 `guest`。
 * - 座位号（seat_no / seatIndex）仅用于布局，不再作为名称展示。
 */
export type PlayerType = "registered" | "guest";

export type RoomMember = {
  userId: string;
  nickname: string;
  role: RoomRole;
  joinedAt: number;
  /** P1 阶段恒为 "registered"；P2 游客加入时扩展 "guest"。 */
  playerType?: PlayerType;
};

export type RoomEvent = {
  sequenceNo: number;
  operationId: string;
  actorUserId: string;
  kind: string;
  payload: RoomPayload;
  createdAt: number;
};

export type RoomSnapshot = {
  matchId: string;
  roomCode: string;
  status: "draft" | "active" | "completed";
  version: number;
  members: RoomMember[];
  events: RoomEvent[];
  chaseScore: ChaseScoreState | null;
  eightBall: RealtimeEightBallState | null;
  snooker: RealtimeSnookerState | null;
  teamBattle: RealtimeTeamBattleState | null;
};

export type RoomSync = {
  snapshot: RoomSnapshot;
  reset: boolean;
  fromSequenceNo: number;
};

const MAX_INCREMENTAL_EVENTS = 200;

export type RoomCommandResult =
  | { ok: true; duplicate: boolean; event: RoomEvent; version: number; archivePending?: boolean }
  | { ok: false; code: "not_initialized" | "forbidden" | "not_found" | "version_conflict" | "invalid_command"; currentVersion: number };

type MatchRoomEnv = Env;

type ConnectionAttachment = {
  userId: string;
  role: RoomRole;
  connectedAt: number;
};

type SnapshotObserver = { userId: string; role: RoomRole };

export class MatchRoom extends DurableObject<MatchRoomEnv> {
  constructor(ctx: DurableObjectState, env: MatchRoomEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          match_id TEXT NOT NULL,
          room_code TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'completed')),
          version INTEGER NOT NULL CHECK (version >= 0)
        );
        CREATE TABLE IF NOT EXISTS room_members (
          user_id TEXT PRIMARY KEY,
          nickname TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('host', 'player', 'spectator')),
          joined_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS room_events (
          sequence_no INTEGER PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          actor_user_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS room_game_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          mode TEXT NOT NULL CHECK (mode IN ('score', 'score_cards', 'eight_ball', 'snooker', 'team_battle')),
          state_json TEXT NOT NULL CHECK (json_valid(state_json)),
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS room_archive_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          status TEXT NOT NULL CHECK (status IN ('pending', 'archived')),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          ended_at INTEGER NOT NULL,
          last_error TEXT,
          next_retry_at INTEGER
        );
      `);
      this.migrateGameStateSchema();
    });
  }

  private migrateGameStateSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_schema_versions (
        name TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 1)
      )
    `);
    const schema = this.ctx.storage.sql.exec<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'room_game_state'",
    ).toArray()[0]?.sql ?? "";
    if (!schema.includes("'team_battle'")) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(`
          CREATE TABLE room_game_state_v3 (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            mode TEXT NOT NULL CHECK (mode IN ('score', 'score_cards', 'eight_ball', 'snooker', 'team_battle')),
            state_json TEXT NOT NULL CHECK (json_valid(state_json)),
            updated_at INTEGER NOT NULL
          );
          INSERT INTO room_game_state_v3 (singleton, mode, state_json, updated_at)
            SELECT singleton, mode, state_json, updated_at FROM room_game_state;
          DROP TABLE room_game_state;
          ALTER TABLE room_game_state_v3 RENAME TO room_game_state;
        `);
      });
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO room_schema_versions (name, version) VALUES ('room_game_state', 3) ON CONFLICT(name) DO UPDATE SET version = excluded.version",
    );
  }

  async initialize(input: {
    matchId: string;
    roomCode: string;
    host: RoomMember;
    chaseScore?: ChaseScoreState;
    eightBall?: RealtimeEightBallState;
    snooker?: RealtimeSnookerState;
    teamBattle?: RealtimeTeamBattleState;
  }): Promise<RoomSnapshot> {
    const existing = this.meta();
    if (existing) {
      if (existing.match_id !== input.matchId || existing.room_code !== input.roomCode) {
        throw new Error("Durable Object room identity mismatch");
      }
      if (!this.chaseScoreState() && input.chaseScore) this.persistChaseScoreState(input.chaseScore);
      if (!this.eightBallState() && input.eightBall) this.persistEightBallState(input.eightBall);
      if (!this.snookerState() && input.snooker) this.persistSnookerState(input.snooker);
      if (!this.teamBattleState() && input.teamBattle) this.persistTeamBattleState(input.teamBattle);
      return this.snapshot();
    }

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO room_meta (singleton, match_id, room_code, status, version) VALUES (1, ?, ?, 'draft', 0)",
        input.matchId,
        input.roomCode,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO room_members (user_id, nickname, role, joined_at) VALUES (?, ?, 'host', ?)",
        input.host.userId,
        input.host.nickname,
        input.host.joinedAt,
      );
      if (input.chaseScore) this.persistChaseScoreState(input.chaseScore);
      if (input.eightBall) this.persistEightBallState(input.eightBall);
      if (input.snooker) this.persistSnookerState(input.snooker);
      if (input.teamBattle) this.persistTeamBattleState(input.teamBattle);
    });
    return this.snapshot();
  }

  async addMember(input: RoomMember & { operationId: string; expectedVersion?: number }): Promise<RoomCommandResult> {
    const meta = this.meta();
    if (!meta) return { ok: false, code: "not_initialized", currentVersion: 0 };
    const duplicate = this.duplicateResult(input.operationId, meta.version, input.userId, (event) =>
      event.kind === "member.joined" && event.payload.userId === input.userId && event.payload.role === input.role);
    if (duplicate) return duplicate;
    if (meta.status === "completed") return { ok: false, code: "invalid_command", currentVersion: meta.version };
    if (input.expectedVersion !== undefined && input.expectedVersion !== meta.version) {
      return { ok: false, code: "version_conflict", currentVersion: meta.version };
    }
    if (!input.operationId || input.operationId.length > 128) {
      return { ok: false, code: "invalid_command", currentVersion: meta.version };
    }
    if (input.role === "host") return { ok: false, code: "forbidden", currentVersion: meta.version };

    this.ctx.storage.sql.exec(
      `INSERT INTO room_members (user_id, nickname, role, joined_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET nickname = excluded.nickname, role = excluded.role, joined_at = excluded.joined_at`,
      input.userId,
      input.nickname,
      input.role,
      input.joinedAt,
    );
    const result = this.appendEvent(meta.version, input.operationId, input.userId, "member.joined", {
      userId: input.userId,
      nickname: input.nickname,
      role: input.role,
    });
    if (result.ok) this.broadcast({ type: "event", event: result.event, version: result.version });
    return result;
  }

  async assignRole(input: {
    operationId: string;
    expectedVersion: number;
    actorUserId: string;
    targetUserId: string;
    role: "player" | "spectator";
  }): Promise<RoomCommandResult> {
    const meta = this.meta();
    if (!meta) return { ok: false, code: "not_initialized", currentVersion: 0 };
    const duplicate = this.duplicateResult(input.operationId, meta.version, input.actorUserId, (event) =>
      event.kind === "member.role_changed" && event.payload.userId === input.targetUserId && event.payload.role === input.role);
    if (duplicate) return duplicate;
    if (meta.status === "completed") return { ok: false, code: "invalid_command", currentVersion: meta.version };
    if (input.expectedVersion !== meta.version) {
      return { ok: false, code: "version_conflict", currentVersion: meta.version };
    }
    const actor = this.member(input.actorUserId);
    if (!actor || actor.role !== "host") return { ok: false, code: "forbidden", currentVersion: meta.version };
    const target = this.member(input.targetUserId);
    if (!target) return { ok: false, code: "not_found", currentVersion: meta.version };
    if (target.role === "host") return { ok: false, code: "forbidden", currentVersion: meta.version };
    if (!input.operationId || input.operationId.length > 128) {
      return { ok: false, code: "invalid_command", currentVersion: meta.version };
    }

    this.ctx.storage.sql.exec("UPDATE room_members SET role = ? WHERE user_id = ?", input.role, input.targetUserId);
    // Convergence rule: refresh the target user's existing connection capability in
    // place so it never depends on a manual page refresh or a forced reconnect.
    this.updateSocketRole(input.targetUserId, input.role);
    const result = this.appendEvent(meta.version, input.operationId, input.actorUserId, "member.role_changed", {
      userId: input.targetUserId,
      nickname: target.nickname,
      role: input.role,
    });
    if (result.ok) this.broadcast({ type: "event", event: result.event, version: result.version });
    return result;
  }

  async leave(input: {
    operationId: string;
    expectedVersion: number;
    actorUserId: string;
  }): Promise<RoomCommandResult> {
    const meta = this.meta();
    if (!meta) return { ok: false, code: "not_initialized", currentVersion: 0 };
    const duplicate = this.duplicateResult(input.operationId, meta.version, input.actorUserId, (event) =>
      event.kind === "member.left" && event.payload.userId === input.actorUserId);
    if (duplicate) return duplicate;
    if (meta.status === "completed") return { ok: false, code: "invalid_command", currentVersion: meta.version };
    if (input.expectedVersion !== meta.version) {
      return { ok: false, code: "version_conflict", currentVersion: meta.version };
    }
    const member = this.member(input.actorUserId);
    if (!member) return { ok: false, code: "not_found", currentVersion: meta.version };
    if (member.role === "host") return { ok: false, code: "forbidden", currentVersion: meta.version };
    if (!input.operationId || input.operationId.length > 128) {
      return { ok: false, code: "invalid_command", currentVersion: meta.version };
    }

    this.ctx.storage.sql.exec("DELETE FROM room_members WHERE user_id = ?", input.actorUserId);
    const result = this.appendEvent(meta.version, input.operationId, input.actorUserId, "member.left", {
      userId: input.actorUserId,
      nickname: member.nickname,
    });
    if (result.ok) this.broadcast({ type: "event", event: result.event, version: result.version });
    return result;
  }

  async kickMember(input: {
    operationId: string;
    expectedVersion: number;
    actorUserId: string;
    targetUserId: string;
  }): Promise<RoomCommandResult> {
    const meta = this.meta();
    if (!meta) return { ok: false, code: "not_initialized", currentVersion: 0 };
    const duplicate = this.duplicateResult(input.operationId, meta.version, input.actorUserId, (event) =>
      event.kind === "member.kicked" && event.payload.userId === input.targetUserId);
    if (duplicate) return duplicate;
    if (meta.status === "completed") return { ok: false, code: "invalid_command", currentVersion: meta.version };
    if (input.expectedVersion !== meta.version) {
      return { ok: false, code: "version_conflict", currentVersion: meta.version };
    }
    const actor = this.member(input.actorUserId);
    if (!actor || actor.role !== "host") return { ok: false, code: "forbidden", currentVersion: meta.version };
    if (!input.operationId || input.operationId.length > 128) {
      return { ok: false, code: "invalid_command", currentVersion: meta.version };
    }
    const target = this.member(input.targetUserId);
    if (!target) {
      // The target already left or was kicked: a repeat kick is an idempotent
      // success instead of an error, so the host never sees a spurious failure
      // when converging the room and the D1 member projection.
      const prior = this.lastMemberDeparture(input.targetUserId);
      return prior
        ? { ok: true, duplicate: true, event: prior, version: meta.version }
        : { ok: false, code: "not_found", currentVersion: meta.version };
    }
    if (target.role === "host") return { ok: false, code: "forbidden", currentVersion: meta.version };

    this.ctx.storage.sql.exec("DELETE FROM room_members WHERE user_id = ?", input.targetUserId);
    const result = this.appendEvent(meta.version, input.operationId, input.actorUserId, "member.kicked", {
      userId: input.targetUserId,
      nickname: target.nickname,
      kickedByUserId: input.actorUserId,
    });
    if (result.ok) {
      this.broadcast({ type: "event", event: result.event, version: result.version });
      this.closeUserSockets(input.targetUserId, 4004, "kicked");
    }
    return result;
  }

  async removePlayer(input: {
    operationId: string;
    expectedVersion: number;
    actorUserId: string;
    playerId: string;
  }): Promise<RoomCommandResult> {
    const meta = this.meta();
    if (!meta) return { ok: false, code: "not_initialized", currentVersion: 0 };
    const duplicate = this.duplicateResult(input.operationId, meta.version, input.actorUserId, (event) =>
      (event.kind === "player.removed" || event.kind === "player.left") && event.payload.playerId === input.playerId);
    if (duplicate) return duplicate;
    if (meta.status === "completed") return { ok: false, code: "invalid_command", currentVersion: meta.version };
    if (input.expectedVersion !== meta.version) {
      return { ok: false, code: "version_conflict", currentVersion: meta.version };
    }
    const actor = this.member(input.actorUserId);
    if (!actor || actor.role !== "host") return { ok: false, code: "forbidden", currentVersion: meta.version };
    if (!input.operationId || input.operationId.length > 128) {
      return { ok: false, code: "invalid_command", currentVersion: meta.version };
    }
    const chaseScore = this.chaseScoreState();
    if (!chaseScore) {
      // Chinese-eight rooms have a fixed two-seat game: there is no removable
      // temporary player seat, so the command is rejected rather than guessing.
      return { ok: false, code: "invalid_command", currentVersion: meta.version };
    }
    const playerIndex = chaseScore.players.findIndex((player) => player.id === input.playerId);
    if (playerIndex < 0) {
      // The seat was already removed or left: repeat removal is idempotent.
      const prior = this.lastPlayerDeparture(input.playerId);
      return prior
        ? { ok: true, duplicate: true, event: prior, version: meta.version }
        : { ok: false, code: "not_found", currentVersion: meta.version };
    }

    const hasHistory = this.playerHasScoringHistory(input.playerId);
    return this.ctx.storage.transactionSync(() => {
      if (hasHistory) {
        // Append-only rule: keep the player row and its historical events; only
        // the seat becomes inactive so the scoreboard stops targeting it.
        const players = chaseScore.players.map((player, index) => index === playerIndex
          ? { ...player, active: false }
          : player);
        const currentPlayerId = players.some((player) => player.active)
          ? (players.find((player) => player.active)?.id ?? chaseScore.currentPlayerId)
          : chaseScore.currentPlayerId;
        this.persistChaseScoreState({ ...chaseScore, players, currentPlayerId });
        return this.appendEvent(meta.version, input.operationId, input.actorUserId, "player.left", {
          playerId: input.playerId,
        });
      }
      // No scoring history: the seat can be removed entirely.
      const players = chaseScore.players.filter((player) => player.id !== input.playerId);
      const currentPlayerId = players.some((player) => player.active)
        ? (players.find((player) => player.active)?.id ?? chaseScore.currentPlayerId)
        : chaseScore.currentPlayerId;
      this.persistChaseScoreState({ ...chaseScore, players, currentPlayerId });
      return this.appendEvent(meta.version, input.operationId, input.actorUserId, "player.removed", {
        playerId: input.playerId,
      });
    });
  }

  /**
   * P1：把注册成员绑定到局内席位，所有玩法的席位显示名都改为该成员加入时的
   * 注册昵称快照（displayName，中途改昵称不影响本局）。席位 ID 与计分流水保持
   * 不变，座位号仍只用于布局。仅房主可执行；目标成员必须为 host / player。
   */
  async claimSeat(input: {
    operationId: string;
    expectedVersion: number;
    actorUserId: string;
    playerId: string;
    targetUserId: string;
  }): Promise<RoomCommandResult> {
    const meta = this.meta();
    if (!meta) return { ok: false, code: "not_initialized", currentVersion: 0 };
    const duplicate = this.duplicateResult(input.operationId, meta.version, input.actorUserId, (event) =>
      event.kind === "player.claimed" && event.payload.playerId === input.playerId && event.payload.userId === input.targetUserId);
    if (duplicate) return duplicate;
    if (meta.status === "completed") return { ok: false, code: "invalid_command", currentVersion: meta.version };
    if (input.expectedVersion !== meta.version) {
      return { ok: false, code: "version_conflict", currentVersion: meta.version };
    }
    if (!input.operationId || input.operationId.length > 128) {
      return { ok: false, code: "invalid_command", currentVersion: meta.version };
    }
    const actor = this.member(input.actorUserId);
    if (!actor || actor.role !== "host") return { ok: false, code: "forbidden", currentVersion: meta.version };
    const target = this.member(input.targetUserId);
    if (!target || target.role === "spectator") return { ok: false, code: "not_found", currentVersion: meta.version };
    const displayName = target.nickname.trim().slice(0, 80) || `玩家${target.userId.slice(-4)}`;

    const teamBattle = this.teamBattleState();
    if (teamBattle) {
      const seat = teamBattle.seats.find((item) => item.playerId === input.playerId);
      const player = teamBattle.match.players.find((item) => item.id === input.playerId);
      if (!seat || !player) return { ok: false, code: "not_found", currentVersion: meta.version };
      if (seat.userId || teamBattle.seats.some((item) => item.userId === target.userId)) {
        return { ok: false, code: "invalid_command", currentVersion: meta.version };
      }
      const seats = teamBattle.seats.map((item) => item.playerId === seat.playerId
        ? { ...item, userId: target.userId }
        : item);
      const players = teamBattle.match.players.map((item) => item.id === player.id
        ? { ...item, name: displayName }
        : item);
      const result = this.ctx.storage.transactionSync(() => {
        this.persistTeamBattleState({ ...teamBattle, match: { ...teamBattle.match, players }, seats });
        return this.appendEvent(meta.version, input.operationId, input.actorUserId, "player.claimed", {
          playerId: seat.playerId,
          userId: target.userId,
          nickname: displayName,
        });
      });
      if (result.ok) this.broadcast({ type: "event", event: result.event, version: result.version });
      return result;
    }

    const chaseScore = this.chaseScoreState();
    if (chaseScore) {
      const seat = chaseScore.players.find((player) => player.id === input.playerId && player.active);
      if (!seat) return { ok: false, code: "not_found", currentVersion: meta.version };
      if (seat.userId || chaseScore.players.some((player) => player.userId === target.userId)) {
        return { ok: false, code: "invalid_command", currentVersion: meta.version };
      }
      const players = chaseScore.players.map((player) =>
        player.id === seat.id ? { ...player, nickname: displayName, userId: target.userId } : player);
      const result = this.ctx.storage.transactionSync(() => {
        this.persistChaseScoreState({ ...chaseScore, players });
        return this.appendEvent(meta.version, input.operationId, input.actorUserId, "player.claimed", {
          playerId: seat.id,
          userId: target.userId,
          nickname: displayName,
        });
      });
      if (result.ok) this.broadcast({ type: "event", event: result.event, version: result.version });
      return result;
    }

    const eightBall = this.eightBallState();
    if (eightBall) {
      const seat = eightBall.players.find((player) => player.id === input.playerId);
      if (!seat) return { ok: false, code: "not_found", currentVersion: meta.version };
      if (seat.userId || eightBall.players.some((player) => player.userId === target.userId)) {
        return { ok: false, code: "invalid_command", currentVersion: meta.version };
      }
      const players = eightBall.players.map((player) =>
        player.id === seat.id ? { ...player, nickname: displayName, userId: target.userId } : player) as RealtimeEightBallState["players"];
      const result = this.ctx.storage.transactionSync(() => {
        this.persistEightBallState({ ...eightBall, players });
        return this.appendEvent(meta.version, input.operationId, input.actorUserId, "player.claimed", {
          playerId: seat.id,
          userId: target.userId,
          nickname: displayName,
        });
      });
      if (result.ok) this.broadcast({ type: "event", event: result.event, version: result.version });
      return result;
    }

    const snooker = this.snookerState();
    if (snooker) {
      const seat = snooker.players.find((player) => player.id === input.playerId);
      if (!seat) return { ok: false, code: "not_found", currentVersion: meta.version };
      if (seat.userId || snooker.players.some((player) => player.userId === target.userId)) {
        return { ok: false, code: "invalid_command", currentVersion: meta.version };
      }
      const players = snooker.players.map((player) => player.id === seat.id
        ? { ...player, nickname: displayName, userId: target.userId }
        : player) as RealtimeSnookerState["players"];
      const match = {
        ...snooker.match,
        players: snooker.match.players.map((player) => player.id === seat.id ? { ...player, name: displayName } : player) as RealtimeSnookerState["match"]["players"],
        initialPlayerNames: snooker.match.initialPlayerNames.map((name, index) => snooker.match.players[index].id === seat.id ? displayName : name) as [string, string],
      };
      const result = this.ctx.storage.transactionSync(() => {
        this.persistSnookerState({ ...snooker, players, match });
        return this.appendEvent(meta.version, input.operationId, input.actorUserId, "player.claimed", {
          playerId: seat.id,
          userId: target.userId,
          nickname: displayName,
        });
      });
      if (result.ok) this.broadcast({ type: "event", event: result.event, version: result.version });
      return result;
    }

    return { ok: false, code: "invalid_command", currentVersion: meta.version };
  }

  async renameSeat(input: {
    operationId: string;
    expectedVersion: number;
    actorUserId: string;
    playerId: string;
    nickname: string;
  }): Promise<RoomCommandResult> {
    const meta = this.meta();
    if (!meta) return { ok: false, code: "not_initialized", currentVersion: 0 };
    const duplicate = this.duplicateResult(input.operationId, meta.version, input.actorUserId, (event) =>
      event.kind === "player.renamed" && event.payload.playerId === input.playerId && event.payload.nickname === input.nickname.trim().slice(0, 80));
    if (duplicate) return duplicate;
    if (meta.status === "completed") return { ok: false, code: "invalid_command", currentVersion: meta.version };
    if (input.expectedVersion !== meta.version) return { ok: false, code: "version_conflict", currentVersion: meta.version };
    if (!input.operationId || input.operationId.length > 128) return { ok: false, code: "invalid_command", currentVersion: meta.version };
    const actor = this.member(input.actorUserId);
    if (!actor || actor.role !== "host") return { ok: false, code: "forbidden", currentVersion: meta.version };
    const nickname = input.nickname.trim().slice(0, 80);
    if (!nickname) return { ok: false, code: "invalid_command", currentVersion: meta.version };

    const teamBattle = this.teamBattleState();
    if (teamBattle) {
      const seat = teamBattle.seats.find((item) => item.playerId === input.playerId);
      const player = teamBattle.match.players.find((item) => item.id === input.playerId);
      if (!seat || !player) return { ok: false, code: "not_found", currentVersion: meta.version };
      if (seat.userId) return { ok: false, code: "forbidden", currentVersion: meta.version };
      let match: RealtimeTeamBattleState["match"];
      try { match = renameTeamBattlePlayer(teamBattle.match, player.id, nickname, Date.now()); }
      catch { return { ok: false, code: "invalid_command", currentVersion: meta.version }; }
      if (match === teamBattle.match) return { ok: false, code: "invalid_command", currentVersion: meta.version };
      const result = this.ctx.storage.transactionSync(() => {
        this.persistTeamBattleState({ ...teamBattle, match });
        return this.appendEvent(meta.version, input.operationId, input.actorUserId, "player.renamed", {
          playerId: player.id,
          nickname,
          previousNickname: player.name,
        });
      });
      if (result.ok) this.broadcast({ type: "event", event: result.event, version: result.version });
      return result;
    }

    const chaseScore = this.chaseScoreState();
    if (chaseScore) {
      const seat = chaseScore.players.find((player) => player.id === input.playerId && player.active);
      if (!seat) return { ok: false, code: "not_found", currentVersion: meta.version };
      if (seat.userId) return { ok: false, code: "forbidden", currentVersion: meta.version };
      const players = chaseScore.players.map((player) => player.id === seat.id ? { ...player, nickname } : player);
      const result = this.ctx.storage.transactionSync(() => {
        this.persistChaseScoreState({ ...chaseScore, players });
        return this.appendEvent(meta.version, input.operationId, input.actorUserId, "player.renamed", {
          playerId: seat.id,
          nickname,
          previousNickname: seat.nickname,
        });
      });
      if (result.ok) this.broadcast({ type: "event", event: result.event, version: result.version });
      return result;
    }

    const eightBall = this.eightBallState();
    if (eightBall) {
      const seat = eightBall.players.find((player) => player.id === input.playerId);
      if (!seat) return { ok: false, code: "not_found", currentVersion: meta.version };
      if (seat.userId) return { ok: false, code: "forbidden", currentVersion: meta.version };
      const players = eightBall.players.map((player) => player.id === seat.id ? { ...player, nickname } : player) as RealtimeEightBallState["players"];
      const result = this.ctx.storage.transactionSync(() => {
        this.persistEightBallState({ ...eightBall, players });
        return this.appendEvent(meta.version, input.operationId, input.actorUserId, "player.renamed", {
          playerId: seat.id,
          nickname,
          previousNickname: seat.nickname,
        });
      });
      if (result.ok) this.broadcast({ type: "event", event: result.event, version: result.version });
      return result;
    }

    const snooker = this.snookerState();
    if (snooker) {
      const seat = snooker.players.find((player) => player.id === input.playerId);
      if (!seat) return { ok: false, code: "not_found", currentVersion: meta.version };
      if (seat.userId) return { ok: false, code: "forbidden", currentVersion: meta.version };
      const players = snooker.players.map((player) => player.id === seat.id ? { ...player, nickname } : player) as RealtimeSnookerState["players"];
      const match = {
        ...snooker.match,
        players: snooker.match.players.map((player) => player.id === seat.id ? { ...player, name: nickname } : player) as RealtimeSnookerState["match"]["players"],
        initialPlayerNames: snooker.match.initialPlayerNames.map((name, index) => snooker.match.players[index].id === seat.id ? nickname : name) as [string, string],
      };
      const result = this.ctx.storage.transactionSync(() => {
        this.persistSnookerState({ ...snooker, players, match });
        return this.appendEvent(meta.version, input.operationId, input.actorUserId, "player.renamed", {
          playerId: seat.id,
          nickname,
          previousNickname: seat.nickname,
        });
      });
      if (result.ok) this.broadcast({ type: "event", event: result.event, version: result.version });
      return result;
    }

    return { ok: false, code: "invalid_command", currentVersion: meta.version };
  }

  async submitCommand(input: {
    operationId: string;
    expectedVersion: number;
    actorUserId: string;
    kind: string;
    payload: RoomPayload;
  }): Promise<RoomCommandResult> {
    return this.processCommand(input);
  }

  async complete(input: {
    operationId: string;
    expectedVersion: number;
    actorUserId: string;
  }): Promise<RoomCommandResult> {
    const meta = this.meta();
    if (!meta) return { ok: false, code: "not_initialized", currentVersion: 0 };
    const duplicate = this.duplicateResult(input.operationId, meta.version, input.actorUserId, (event) =>
      event.kind === "room.completed");
    if (duplicate?.ok) {
      return {
        ok: true,
        duplicate: true,
        event: duplicate.event,
        version: meta.version,
        archivePending: this.archiveState()?.status !== "archived",
      };
    }
    if (duplicate) return duplicate;
    if (meta.status === "completed") return { ok: false, code: "invalid_command", currentVersion: meta.version };
    if (input.expectedVersion !== meta.version) {
      return { ok: false, code: "version_conflict", currentVersion: meta.version };
    }
    const actor = this.member(input.actorUserId);
    if (!actor || actor.role !== "host") return { ok: false, code: "forbidden", currentVersion: meta.version };
    if (!input.operationId || input.operationId.length > 128) {
      return { ok: false, code: "invalid_command", currentVersion: meta.version };
    }

    const endedAt = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      const appended = this.appendEvent(meta.version, input.operationId, input.actorUserId, "room.completed", { endedAt });
      if (!appended.ok) return appended;
      this.ctx.storage.sql.exec("UPDATE room_meta SET status = 'completed' WHERE singleton = 1");
      this.ctx.storage.sql.exec(
        `INSERT INTO room_archive_state (singleton, status, attempt_count, ended_at)
         VALUES (1, 'pending', 0, ?)
         ON CONFLICT(singleton) DO UPDATE SET status = 'pending', ended_at = excluded.ended_at`,
        endedAt,
      );
      return appended;
    });
    if (!result.ok) return result;
    this.broadcast({ type: "event", event: result.event, version: result.version });
    const archived = await this.tryArchive();
    this.broadcast({ type: "archive-status", archived, version: result.version });
    return { ...result, archivePending: !archived };
  }

  async retryArchive(): Promise<boolean> {
    return this.tryArchive();
  }

  async alarm(): Promise<void> {
    await this.tryArchive();
  }

  private processCommand(input: {
    operationId: string;
    expectedVersion: number;
    actorUserId: string;
    kind: string;
    payload: RoomPayload;
  }): RoomCommandResult {
    const meta = this.meta();
    if (!meta) return { ok: false, code: "not_initialized", currentVersion: 0 };
    const duplicate = this.duplicateResult(input.operationId, meta.version, input.actorUserId);
    if (duplicate) return duplicate;
    if (meta.status === "completed") return { ok: false, code: "invalid_command", currentVersion: meta.version };
    if (input.expectedVersion !== meta.version) {
      return { ok: false, code: "version_conflict", currentVersion: meta.version };
    }
    if (!input.operationId || input.operationId.length > 128) {
      return { ok: false, code: "invalid_command", currentVersion: meta.version };
    }
    const member = this.ctx.storage.sql.exec<{ role: RoomRole }>(
      "SELECT role FROM room_members WHERE user_id = ?",
      input.actorUserId,
    ).toArray()[0];
    if (!member || member.role === "spectator") {
      return { ok: false, code: "forbidden", currentVersion: meta.version };
    }
    const chaseScore = this.chaseScoreState();
    const eightBall = this.eightBallState();
    const snooker = this.snookerState();
    const teamBattle = this.teamBattleState();
    if (teamBattle && member.role !== "host") {
      return { ok: false, code: "forbidden", currentVersion: meta.version };
    }
    if (input.kind.startsWith("card.")) {
      const state = chaseScore ?? eightBall ?? snooker;
      const cards = state?.cards;
      const playerId = typeof input.payload.playerId === "string" ? input.payload.playerId : undefined;
      const player = state?.players.find((item) => item.id === playerId);
      if (member.role !== "host" && (!player || player.userId !== input.actorUserId)) {
        return { ok: false, code: "forbidden", currentVersion: meta.version };
      }
      const projection = projectRoomCardCommand(cards, {
        kind: input.kind,
        payload: input.payload,
        now: Date.now(),
      });
      if (typeof projection === "string") return { ok: false, code: projection, currentVersion: meta.version };
      return this.ctx.storage.transactionSync(() => {
        if (chaseScore) this.persistChaseScoreState({ ...chaseScore, cards: projection.cards });
        else if (eightBall) this.persistEightBallState({ ...eightBall, cards: projection.cards });
        else if (snooker) this.persistSnookerState({ ...snooker, cards: projection.cards });
        return this.appendEvent(meta.version, input.operationId, input.actorUserId, projection.kind, projection.payload);
      });
    }
    if (snooker && member.role !== "host") {
      const ownedStriker = snooker.players.find((player) => player.id === snooker.match.currentFrame?.strikerId)?.userId === input.actorUserId;
      if (!ownedStriker || (input.kind !== "snooker.pot.record" && input.kind !== "snooker.visit.end")) {
        return { ok: false, code: "forbidden", currentVersion: meta.version };
      }
    }
    const projection = teamBattle
      ? projectTeamBattleCommand(teamBattle, { kind: input.kind, payload: input.payload, now: Date.now() })
      : snooker
      ? projectRealtimeSnookerCommand(snooker, { kind: input.kind, payload: input.payload, now: Date.now() })
      : chaseScore
      ? projectChaseCommand(chaseScore, this.scoringEvents(), {
          kind: input.kind,
          payload: input.payload,
          now: Date.now(),
        })
      : eightBall
        ? projectEightBallCommand(eightBall, {
            kind: input.kind,
            payload: input.payload,
            now: Date.now(),
            nextSequenceNo: meta.version + 1,
          })
        : "invalid_command";
    if (typeof projection === "string") {
      return { ok: false, code: projection, currentVersion: meta.version };
    }
    return this.ctx.storage.transactionSync(() => {
      if (projection.state.mode === "team_battle") this.persistTeamBattleState(projection.state);
      else if (projection.state.mode === "snooker") this.persistSnookerState(projection.state);
      else if (projection.state.mode === "chinese_eight") this.persistEightBallState(projection.state);
      else this.persistChaseScoreState(projection.state);
      return this.appendEvent(meta.version, input.operationId, input.actorUserId, projection.kind, projection.payload);
    });
  }

  async getSnapshot(afterSequenceNo = 0): Promise<RoomSnapshot> {
    return this.snapshot(afterSequenceNo);
  }

  async getSnapshotFor(observer: SnapshotObserver, afterSequenceNo = 0): Promise<RoomSnapshot> {
    return this.snapshot(afterSequenceNo, observer);
  }

  async getSync(afterSequenceNo = 0): Promise<RoomSync> {
    return this.sync(afterSequenceNo);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const userId = request.headers.get("X-Room-User-Id");
    const role = request.headers.get("X-Room-Role") as RoomRole | null;
    if (!userId || !role || !["host", "player", "spectator"].includes(role)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const member = this.ctx.storage.sql.exec<{ role: RoomRole }>(
      "SELECT role FROM room_members WHERE user_id = ?",
      userId,
    ).toArray()[0];
    if (!member || member.role !== role) return new Response("Forbidden", { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, role, connectedAt: Date.now() } satisfies ConnectionAttachment);
    const requestedAfter = Number(new URL(request.url).searchParams.get("after") ?? 0);
    const sync = this.sync(Number.isSafeInteger(requestedAfter) ? requestedAfter : 0, { userId, role });
    server.send(JSON.stringify({ type: "snapshot", ...sync }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      ws.send(JSON.stringify({ type: "error", error: "仅支持 JSON 文本消息" }));
      return;
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(message);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
      body = parsed as Record<string, unknown>;
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "消息不是有效 JSON 对象" }));
      return;
    }
    if (body.type === "sync") {
      const after = typeof body.afterSequenceNo === "number" ? body.afterSequenceNo : 0;
      const attachment = ws.deserializeAttachment() as ConnectionAttachment | null;
      ws.send(JSON.stringify({ type: "snapshot", ...this.sync(after, attachment ? { userId: attachment.userId, role: attachment.role } : undefined) }));
      return;
    }
    if (body.type !== "command") {
      ws.send(JSON.stringify({ type: "error", error: "消息类型无效" }));
      return;
    }
    const attachment = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment) {
      ws.send(JSON.stringify({ type: "error", error: "连接身份已失效" }));
      return;
    }
    const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? body.payload as RoomPayload
      : {};
    const result = this.processCommand({
      operationId: typeof body.operationId === "string" ? body.operationId : "",
      expectedVersion: typeof body.expectedVersion === "number" ? body.expectedVersion : -1,
      actorUserId: attachment.userId,
      kind: typeof body.kind === "string" ? body.kind : "",
      payload,
    });
    const clientResult = result.ok
      ? { ...result, event: this.projectEvent(result.event, { userId: attachment.userId, role: attachment.role }) }
      : result;
    ws.send(JSON.stringify({ type: "command-result", result: clientResult }));
    if (result.ok && !result.duplicate) {
      if (result.event.kind.startsWith("card.")) this.broadcastView((observer) => ({ type: "event", event: this.projectEvent(result.event, observer), version: result.version }), ws);
      else this.broadcast({ type: "event", event: result.event, version: result.version }, ws);
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    ws.close(code, reason);
  }

  private meta(): { match_id: string; room_code: string; status: RoomSnapshot["status"]; version: number } | undefined {
    return this.ctx.storage.sql.exec<{
      match_id: string;
      room_code: string;
      status: RoomSnapshot["status"];
      version: number;
    }>("SELECT match_id, room_code, status, version FROM room_meta WHERE singleton = 1").toArray()[0];
  }

  private eventByOperation(operationId: string): RoomEvent | undefined {
    if (!operationId) return undefined;
    const row = this.ctx.storage.sql.exec<{
      sequence_no: number;
      operation_id: string;
      actor_user_id: string;
      kind: string;
      payload_json: string;
      created_at: number;
    }>("SELECT * FROM room_events WHERE operation_id = ?", operationId).toArray()[0];
    return row ? this.toEvent(row) : undefined;
  }

  private duplicateResult(
    operationId: string,
    currentVersion: number,
    actorUserId: string,
    matches: (event: RoomEvent) => boolean = () => true,
  ): RoomCommandResult | undefined {
    const event = this.eventByOperation(operationId);
    if (!event) return undefined;
    return event.actorUserId === actorUserId && matches(event)
      ? { ok: true, duplicate: true, event, version: currentVersion }
      : { ok: false, code: "invalid_command", currentVersion };
  }

  private member(userId: string): { userId: string; nickname: string; role: RoomRole; joinedAt: number } | undefined {
    const row = this.ctx.storage.sql.exec<{
      user_id: string;
      nickname: string;
      role: RoomRole;
      joined_at: number;
    }>(
      "SELECT user_id, nickname, role, joined_at FROM room_members WHERE user_id = ?",
      userId,
    ).toArray()[0];
    if (!row) return undefined;
    return { userId: row.user_id, nickname: row.nickname, role: row.role, joinedAt: row.joined_at };
  }

  private lastMemberDeparture(userId: string): RoomEvent | undefined {
    const row = this.ctx.storage.sql.exec<{
      sequence_no: number;
      operation_id: string;
      actor_user_id: string;
      kind: string;
      payload_json: string;
      created_at: number;
    }>(
      `SELECT * FROM room_events
        WHERE kind IN ('member.kicked', 'member.left')
          AND json_extract(payload_json, '$.userId') = ?
        ORDER BY sequence_no DESC LIMIT 1`,
      userId,
    ).toArray()[0];
    return row ? this.toEvent(row) : undefined;
  }

  private lastPlayerDeparture(playerId: string): RoomEvent | undefined {
    const row = this.ctx.storage.sql.exec<{
      sequence_no: number;
      operation_id: string;
      actor_user_id: string;
      kind: string;
      payload_json: string;
      created_at: number;
    }>(
      `SELECT * FROM room_events
        WHERE kind IN ('player.left', 'player.removed')
          AND json_extract(payload_json, '$.playerId') = ?
        ORDER BY sequence_no DESC LIMIT 1`,
      playerId,
    ).toArray()[0];
    return row ? this.toEvent(row) : undefined;
  }

  private playerHasScoringHistory(playerId: string): boolean {
    const rows = this.ctx.storage.sql.exec<{ payload_json: string }>(
      `SELECT payload_json FROM room_events
        WHERE kind IN ('score.recorded', 'score.corrected')
        ORDER BY sequence_no`,
    ).toArray();
    return rows.some((row) => {
      const payload = JSON.parse(row.payload_json) as { playerId?: unknown; changes?: unknown };
      if (payload.playerId === playerId) return true;
      if (payload.changes && typeof payload.changes === "object" && !Array.isArray(payload.changes)) {
        return Object.prototype.hasOwnProperty.call(payload.changes, playerId);
      }
      return false;
    });
  }

  private appendEvent(
    currentVersion: number,
    operationId: string,
    actorUserId: string,
    kind: string,
    payload: RoomPayload,
  ): RoomCommandResult {
    if (!operationId || operationId.length > 128) {
      return { ok: false, code: "invalid_command", currentVersion };
    }
    const nextVersion = currentVersion + 1;
    const createdAt = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO room_events (sequence_no, operation_id, actor_user_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      nextVersion,
      operationId,
      actorUserId,
      kind,
      JSON.stringify(payload),
      createdAt,
    );
    this.ctx.storage.sql.exec("UPDATE room_meta SET version = ? WHERE singleton = 1 AND version = ?", nextVersion, currentVersion);
    return {
      ok: true,
      duplicate: false,
      version: nextVersion,
      event: { sequenceNo: nextVersion, operationId, actorUserId, kind, payload, createdAt },
    };
  }

  private snapshot(afterSequenceNo = 0, observer?: SnapshotObserver): RoomSnapshot {
    const meta = this.meta();
    if (!meta) throw new Error("Room is not initialized");
    const members = this.ctx.storage.sql.exec<{
      user_id: string;
      nickname: string;
      role: RoomRole;
      joined_at: number;
    }>("SELECT user_id, nickname, role, joined_at FROM room_members ORDER BY joined_at, user_id").toArray();
    const events = this.ctx.storage.sql.exec<{
      sequence_no: number;
      operation_id: string;
      actor_user_id: string;
      kind: string;
      payload_json: string;
      created_at: number;
    }>("SELECT * FROM room_events WHERE sequence_no > ? ORDER BY sequence_no", Math.max(0, afterSequenceNo)).toArray();
    return {
      matchId: meta.match_id,
      roomCode: meta.room_code,
      status: meta.status,
      version: meta.version,
      members: members.map((member) => ({
        userId: member.user_id,
        nickname: member.nickname,
        role: member.role,
        joinedAt: member.joined_at,
        playerType: "registered",
      })),
      events: events.map((event) => this.projectEvent(this.toEvent(event), observer)),
      chaseScore: this.projectChaseScore(this.chaseScoreState(), observer) ?? null,
      eightBall: this.projectEightBall(this.eightBallState(), observer) ?? null,
      snooker: this.projectSnooker(this.snookerState(), observer) ?? null,
      teamBattle: this.teamBattleState() ?? null,
    };
  }

  private sync(afterSequenceNo: number, observer?: SnapshotObserver): RoomSync {
    const currentVersion = this.meta()?.version ?? 0;
    const normalizedAfter = Number.isSafeInteger(afterSequenceNo) && afterSequenceNo >= 0
      ? afterSequenceNo
      : 0;
    const canIncrement = normalizedAfter > 0
      && normalizedAfter <= currentVersion
      && currentVersion - normalizedAfter <= MAX_INCREMENTAL_EVENTS;
    const fromSequenceNo = canIncrement
      ? normalizedAfter
      : Math.max(0, currentVersion - MAX_INCREMENTAL_EVENTS);
    return {
      snapshot: this.snapshot(fromSequenceNo, observer),
      reset: !canIncrement,
      fromSequenceNo,
    };
  }

  private archiveState(): { status: "pending" | "archived"; attempt_count: number; ended_at: number } | undefined {
    return this.ctx.storage.sql.exec<{
      status: "pending" | "archived";
      attempt_count: number;
      ended_at: number;
    }>("SELECT status, attempt_count, ended_at FROM room_archive_state WHERE singleton = 1").toArray()[0];
  }

  private async tryArchive(): Promise<boolean> {
    const archive = this.archiveState();
    const meta = this.meta();
    if (!archive || !meta || meta.status !== "completed") return false;
    if (archive.status === "archived") return true;

    try {
      const current = await this.env.DB.prepare("SELECT snapshot_json FROM matches WHERE id = ?1")
        .bind(meta.match_id)
        .first<{ snapshot_json: string | null }>();
      if (!current) throw new Error("Realtime archive match is missing");
      let baseline: Record<string, unknown> = {};
      if (current.snapshot_json) {
        try {
          const parsed: unknown = JSON.parse(current.snapshot_json);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) baseline = parsed as Record<string, unknown>;
        } catch { /* A valid realtime projection below replaces an unreadable baseline. */ }
      }
      const snapshotJson = JSON.stringify(this.buildArchiveSnapshot(baseline, archive.ended_at));
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshotJson));
      const checksum = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const now = Date.now();
      const results = await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE matches
              SET status = 'completed', version = ?1, snapshot_json = ?2, snapshot_checksum = ?3,
                  updated_at = ?4, started_at = COALESCE(started_at, created_at), ended_at = ?5,
                  write_lease_device_id = NULL, write_lease_expires_at = NULL
            WHERE id = ?6`,
        ).bind(meta.version, snapshotJson, checksum, now, archive.ended_at, meta.match_id),
        this.env.DB.prepare(
          `UPDATE realtime_rooms SET status = 'completed', updated_at = ?1, archived_at = ?1
            WHERE match_id = ?2`,
        ).bind(now, meta.match_id),
      ]);
      if ((results[0].meta.changes ?? 0) !== 1 || (results[1].meta.changes ?? 0) !== 1) {
        throw new Error("Realtime archive projection is missing");
      }
      this.ctx.storage.sql.exec(
        "UPDATE room_archive_state SET status = 'archived', last_error = NULL, next_retry_at = NULL WHERE singleton = 1",
      );
      await this.ctx.storage.deleteAlarm();
      return true;
    } catch (error) {
      const attemptCount = archive.attempt_count + 1;
      const delay = Math.min(3_600_000, 2_000 * 2 ** Math.min(10, attemptCount - 1));
      const nextRetryAt = Date.now() + delay;
      const lastError = error instanceof Error ? error.message.slice(0, 300) : "Unknown archive failure";
      this.ctx.storage.sql.exec(
        `UPDATE room_archive_state
            SET status = 'pending', attempt_count = ?, last_error = ?, next_retry_at = ?
          WHERE singleton = 1`,
        attemptCount,
        lastError,
        nextRetryAt,
      );
      await this.ctx.storage.setAlarm(nextRetryAt);
      try {
        await this.env.DB.prepare(
          "UPDATE realtime_rooms SET status = 'archiving_failed', updated_at = ?1 WHERE match_id = ?2 AND status != 'completed'",
        ).bind(Date.now(), meta.match_id).run();
      } catch { /* The durable alarm remains the source of truth while D1 is unavailable. */ }
      console.error(JSON.stringify({
        level: "error",
        event: "realtime_archive_pending",
        matchId: meta.match_id,
        attemptCount,
      }));
      return false;
    }
  }

  private buildArchiveSnapshot(baseline: Record<string, unknown>, endedAt: number): Record<string, unknown> {
    const snapshot = this.snapshot();
    const realtimeArchive = {
      schemaVersion: 1,
      roomCode: snapshot.roomCode,
      version: snapshot.version,
      members: snapshot.members,
      events: snapshot.events,
    };
    if (snapshot.teamBattle) {
      const finished = snapshot.teamBattle.match.status === "completed"
        ? snapshot.teamBattle.match
        : finishTeamBattleMatch(snapshot.teamBattle.match, endedAt);
      const archived = {
        ...finished,
        realtimeArchive: { ...realtimeArchive, seats: snapshot.teamBattle.seats },
      };
      if (!isTeamBattleMatch(archived)) throw new Error("Realtime team-battle archive is invalid");
      return archived;
    }
    if (snapshot.chaseScore) {
      const score = snapshot.chaseScore;
      const baselinePlayers = Array.isArray(baseline.players) ? baseline.players : [];
      const stableToLocal = new Map<string, string>();
      const players = score.players.map((player, index) => {
        const stored = baselinePlayers[index] && typeof baselinePlayers[index] === "object" && !Array.isArray(baselinePlayers[index])
          ? baselinePlayers[index] as Record<string, unknown>
          : {};
        const localId = typeof stored.id === "string" ? stored.id : player.id;
        stableToLocal.set(player.id, localId);
        return {
          ...stored,
          id: localId,
          name: typeof stored.name === "string" ? stored.name : player.nickname,
          kind: stored.kind === "registered-placeholder" ? stored.kind : "guest",
          initialScore: player.initialScore,
          score: player.score,
          active: player.active,
        };
      });
      const baselineEvents = Array.isArray(baseline.scoreEvents) ? baseline.scoreEvents : [];
      const convertedIds = new Map<number, string>();
      const scoreEvents = snapshot.events.flatMap((event): Record<string, unknown>[] => {
        if (event.kind !== "score.recorded" && event.kind !== "score.corrected") return [];
        const payload = event.payload;
        const rawChanges = payload.changes && typeof payload.changes === "object" && !Array.isArray(payload.changes)
          ? payload.changes as Record<string, number>
          : {};
        const id = `realtime:${event.operationId}`;
        convertedIds.set(event.sequenceNo, id);
        const corrects = typeof payload.correctsSequenceNo === "number"
          ? convertedIds.get(payload.correctsSequenceNo)
          : undefined;
        return [{
          id,
          type: payload.type === "transfer" ? "transfer" : payload.type === "correction" ? "correction" : "score",
          label: typeof payload.label === "string" ? payload.label : "实时计分",
          playerId: stableToLocal.get(String(payload.playerId)) ?? String(payload.playerId ?? ""),
          changes: Object.fromEntries(Object.entries(rawChanges).map(([playerId, delta]) => [stableToLocal.get(playerId) ?? playerId, delta])),
          previousCurrentPlayerId: stableToLocal.get(String(payload.previousCurrentPlayerId)) ?? String(payload.previousCurrentPlayerId ?? ""),
          occurredAt: typeof payload.occurredAt === "number" ? payload.occurredAt : event.createdAt,
          ...(typeof payload.note === "string" && payload.note ? { note: payload.note } : {}),
          ...(corrects ? { correctsEventId: corrects } : {}),
        }];
      });
      return {
        ...baseline,
        version: 1,
        id: typeof baseline.id === "string" ? baseline.id : snapshot.matchId,
        mode: score.mode,
        status: "completed",
        createdAt: typeof baseline.createdAt === "number" ? baseline.createdAt : endedAt,
        startedAt: typeof baseline.startedAt === "number" ? baseline.startedAt : endedAt,
        endedAt,
        players,
        currentPlayerId: stableToLocal.get(score.currentPlayerId) ?? score.currentPlayerId,
        rules: Array.isArray(baseline.rules) ? baseline.rules : score.rules.map((rule) => ({ ...rule, color: "mint" })),
        scoreEvents: [...baselineEvents, ...scoreEvents],
        turnStrategy: score.turnStrategy,
        realtimeArchive,
      };
    }

    const snooker = this.snookerState();
    if (snooker) {
      const finished = snooker.match.status === "completed"
        ? snooker.match
        : recordSnookerCommand(snooker.match, { type: "snooker.finish" }, endedAt);
      const cards = snooker.cards ? {
        mode: snooker.cards.mode,
        remaining: snooker.cards.remaining,
        hands: snooker.cards.hands,
        used: snooker.cards.used,
        skipped: snooker.cards.skipped,
        events: snooker.cards.events.map((event) => ({
          id: event.id,
          type: event.type,
          handId: event.playerId,
          ...(event.card ? { card: event.card } : {}),
          occurredAt: event.occurredAt,
        })),
        initialHandSize: Math.max(0, ...Object.values(snooker.cards.initialHandSizes)),
        initialHandSizes: snooker.cards.initialHandSizes,
        deckSnapshot: snooker.cards.deckSnapshot,
      } : undefined;
      return {
        ...finished,
        id: typeof baseline.id === "string" ? baseline.id : snapshot.matchId,
        ...(cards ? { cards } : {}),
        realtimeArchive,
      };
    }

    const eightBall = snapshot.eightBall!;
    const baselinePlayers = Array.isArray(baseline.players) ? baseline.players : [];
    const stableToLocal = new Map<string, string>();
    const players = eightBall.players.map((player, index) => {
      const stored = baselinePlayers[index] && typeof baselinePlayers[index] === "object" && !Array.isArray(baselinePlayers[index])
        ? baselinePlayers[index] as Record<string, unknown>
        : {};
      const localId = typeof stored.id === "string" ? stored.id : player.id;
      stableToLocal.set(player.id, localId);
      return { id: localId, name: typeof stored.name === "string" ? stored.name : player.nickname };
    });
    const playerNames = Object.fromEntries(players.map((player) => [player.id, player.name]));
    const events: Record<string, unknown>[] = [];
    let version = 0;
    for (const round of eightBall.rounds) {
      version += 1;
      const eventId = `realtime:${round.roundId}`;
      events.push({
        id: eventId,
        operationId: eventId,
        sequenceNo: version,
        matchVersion: version,
        type: "round",
        occurredAt: round.confirmedAt,
        source: "user",
        playerNames,
        round: {
          winnerId: stableToLocal.get(round.winnerId) ?? round.winnerId,
          winType: round.winType,
          fouls: Object.fromEntries(Object.entries(round.fouls).map(([playerId, count]) => [stableToLocal.get(playerId) ?? playerId, count])),
          note: round.note,
          startedAt: round.startedAt,
          confirmedAt: round.confirmedAt,
        },
      });
      if (round.voided) {
        version += 1;
        events.push({
          id: `${eventId}:void`, operationId: `${eventId}:void`, sequenceNo: version, matchVersion: version,
          type: "correction", occurredAt: endedAt, source: "undo", playerNames, correctsEventId: eventId,
        });
      }
    }
    version += 1;
    events.push({
      id: `realtime:finish:${snapshot.version}`, operationId: `realtime:finish:${snapshot.version}`,
      sequenceNo: version, matchVersion: version, type: "finish", occurredAt: endedAt, source: "user", playerNames,
    });
    return {
      ...baseline,
      schemaVersion: 1,
      id: typeof baseline.id === "string" ? baseline.id : snapshot.matchId,
      matchVersion: version,
      mode: "chinese_eight",
      status: "completed",
      createdAt: typeof baseline.createdAt === "number" ? baseline.createdAt : endedAt,
      startedAt: typeof baseline.startedAt === "number" ? baseline.startedAt : endedAt,
      endedAt,
      pausedDurationMs: typeof baseline.pausedDurationMs === "number" ? baseline.pausedDurationMs : 0,
      players,
      raceTo: eightBall.raceTo,
      firstServerId: stableToLocal.get(eightBall.firstServerId) ?? eightBall.firstServerId,
      serveRule: eightBall.serveRule,
      layout: baseline.layout === "split" ? "split" : "stacked",
      title: typeof baseline.title === "string" ? baseline.title : "",
      location: typeof baseline.location === "string" ? baseline.location : "",
      note: typeof baseline.note === "string" ? baseline.note : "",
      events,
      realtimeArchive,
    };
  }

  private chaseScoreState(): ChaseScoreState | undefined {
    const row = this.ctx.storage.sql.exec<{ state_json: string }>(
      "SELECT state_json FROM room_game_state WHERE singleton = 1 AND mode IN ('score', 'score_cards')",
    ).toArray()[0];
    return row ? JSON.parse(row.state_json) as ChaseScoreState : undefined;
  }

  private persistChaseScoreState(state: ChaseScoreState): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO room_game_state (singleton, mode, state_json, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET mode = excluded.mode, state_json = excluded.state_json, updated_at = excluded.updated_at`,
      state.mode,
      JSON.stringify(state),
      Date.now(),
    );
  }

  private eightBallState(): RealtimeEightBallState | undefined {
    const row = this.ctx.storage.sql.exec<{ state_json: string }>(
      "SELECT state_json FROM room_game_state WHERE singleton = 1 AND mode = 'eight_ball'",
    ).toArray()[0];
    return row ? JSON.parse(row.state_json) as RealtimeEightBallState : undefined;
  }

  private persistEightBallState(state: RealtimeEightBallState): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO room_game_state (singleton, mode, state_json, updated_at) VALUES (1, 'eight_ball', ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET mode = excluded.mode, state_json = excluded.state_json, updated_at = excluded.updated_at`,
      JSON.stringify(state),
      Date.now(),
    );
  }

  private snookerState(): RealtimeSnookerState | undefined {
    const row = this.ctx.storage.sql.exec<{ state_json: string }>(
      "SELECT state_json FROM room_game_state WHERE singleton = 1 AND mode = 'snooker'",
    ).toArray()[0];
    return row ? JSON.parse(row.state_json) as RealtimeSnookerState : undefined;
  }

  private persistSnookerState(state: RealtimeSnookerState): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO room_game_state (singleton, mode, state_json, updated_at) VALUES (1, 'snooker', ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET mode = excluded.mode, state_json = excluded.state_json, updated_at = excluded.updated_at`,
      JSON.stringify(state),
      Date.now(),
    );
  }

  private teamBattleState(): RealtimeTeamBattleState | undefined {
    const row = this.ctx.storage.sql.exec<{ state_json: string }>(
      "SELECT state_json FROM room_game_state WHERE singleton = 1 AND mode = 'team_battle'",
    ).toArray()[0];
    return row ? JSON.parse(row.state_json) as RealtimeTeamBattleState : undefined;
  }

  private persistTeamBattleState(state: RealtimeTeamBattleState): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO room_game_state (singleton, mode, state_json, updated_at) VALUES (1, 'team_battle', ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET mode = excluded.mode, state_json = excluded.state_json, updated_at = excluded.updated_at`,
      JSON.stringify(state),
      Date.now(),
    );
  }

  private scoringEvents(): Array<{ sequenceNo: number; kind: string; payload: JsonObject }> {
    return this.ctx.storage.sql.exec<{ sequence_no: number; kind: string; payload_json: string }>(
      "SELECT sequence_no, kind, payload_json FROM room_events WHERE kind IN ('score.recorded', 'score.corrected') ORDER BY sequence_no",
    ).toArray().map((event) => ({
      sequenceNo: event.sequence_no,
      kind: event.kind,
      payload: JSON.parse(event.payload_json) as Record<string, JsonValue>,
    }));
  }

  private ownsPlayer(player: { userId?: string }, observer?: SnapshotObserver): boolean {
    return !!observer && !!player.userId && player.userId === observer.userId;
  }

  private projectCards<T extends { cards?: ChaseScoreState["cards"]; players: Array<{ id: string; userId?: string }> }>(state: T | undefined, observer?: SnapshotObserver): T | undefined {
    if (!state?.cards) return state;
    if (!observer || observer.role === "host") return state;
    const visibleHands: typeof state.cards.hands = {};
    for (const player of state.players) {
      const hand = state.cards.hands[player.id] ?? [];
      visibleHands[player.id] = this.ownsPlayer(player, observer) ? hand : [];
    }
    return { ...state, cards: { ...state.cards, hands: visibleHands } };
  }

  private projectChaseScore(state: ChaseScoreState | undefined, observer?: SnapshotObserver): ChaseScoreState | undefined {
    return this.projectCards(state, observer);
  }

  private projectEightBall(state: RealtimeEightBallState | undefined, observer?: SnapshotObserver): RealtimeEightBallState | undefined {
    return this.projectCards(state, observer);
  }

  private projectSnooker(state: RealtimeSnookerState | undefined, observer?: SnapshotObserver): RealtimeSnookerState | undefined {
    return this.projectCards(state, observer);
  }

  private projectEvent(event: RoomEvent, observer?: SnapshotObserver): RoomEvent {
    if (!event.kind.startsWith("card.")) return event;
    if (observer?.role === "host" || event.kind === "card.played" || event.kind === "card.skipped") return event;
    const payload = { ...event.payload };
    delete payload.card;
    return { ...event, payload };
  }

  private toEvent(row: {
    sequence_no: number;
    operation_id: string;
    actor_user_id: string;
    kind: string;
    payload_json: string;
    created_at: number;
  }): RoomEvent {
    return {
      sequenceNo: row.sequence_no,
      operationId: row.operation_id,
      actorUserId: row.actor_user_id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as RoomPayload,
      createdAt: row.created_at,
    };
  }

  private updateSocketRole(targetUserId: string, role: RoomRole): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (attachment?.userId === targetUserId) {
        socket.serializeAttachment({ userId: attachment.userId, role, connectedAt: attachment.connectedAt });
      }
    }
  }

  private closeUserSockets(targetUserId: string, code: number, reason: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (attachment?.userId === targetUserId) {
        socket.close(code, reason);
      }
    }
  }

  private broadcast(message: unknown, except?: WebSocket): void {
    const encoded = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except) socket.send(encoded);
    }
  }

  private broadcastView(build: (observer: SnapshotObserver) => unknown, except?: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (attachment) socket.send(JSON.stringify(build({ userId: attachment.userId, role: attachment.role })));
    }
  }
}
