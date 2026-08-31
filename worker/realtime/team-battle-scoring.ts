import {
  correctTeamBattleRound,
  getEffectiveTeamBattleRounds,
  pauseTeamBattleMatch,
  recordTeamBattleRound,
  resumeTeamBattleMatch,
  undoLastTeamBattleRound,
  teamBattlePairKey,
  type TeamBattleMatch,
  type TeamBattleRoundPayload,
  type TeamBattleWinType,
} from "../../src/lib/team-battle";
import type { JsonObject, JsonValue } from "./chase-scoring";

export type RealtimeTeamBattleState = {
  mode: "team_battle";
  match: TeamBattleMatch;
  seats: Array<{ playerId: string; userId?: string }>;
  currentPairIds: [string, string];
};

export type TeamBattleCommandProjection = {
  kind:
    | "team_battle.pair.changed"
    | "team_battle.round.recorded"
    | "team_battle.round.corrected"
    | "team_battle.paused"
    | "team_battle.resumed";
  payload: JsonObject;
  state: RealtimeTeamBattleState;
};

export type TeamBattleCommandError = "invalid_command" | "not_found";

const WIN_TYPES: TeamBattleWinType[] = ["normal", "break_clear", "runout"];

function text(value: JsonValue | undefined, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : undefined;
}

function playerIds(state: RealtimeTeamBattleState, value: JsonValue | undefined): [string, string] | TeamBattleCommandError {
  if (!Array.isArray(value) || value.length !== 2 || value.some((id) => typeof id !== "string")) return "invalid_command";
  const pair = value as [string, string];
  if (pair[0] === pair[1]) return "invalid_command";
  if (pair.some((id) => !state.match.players.some((player) => player.id === id))) return "not_found";
  return pair;
}

function roundInput(
  state: RealtimeTeamBattleState,
  payload: JsonObject,
  now: number,
): Omit<TeamBattleRoundPayload, "confirmedAt"> | TeamBattleCommandError {
  const winnerId = typeof payload.winnerId === "string" ? payload.winnerId : undefined;
  if (!winnerId || !state.currentPairIds.includes(winnerId)) return "not_found";
  const winType = typeof payload.winType === "string" && WIN_TYPES.includes(payload.winType as TeamBattleWinType)
    ? payload.winType as TeamBattleWinType
    : undefined;
  const note = payload.note === undefined ? "" : text(payload.note, 120);
  const startedAt = payload.startedAt === undefined ? now : payload.startedAt;
  const rawFouls = payload.fouls;
  if (!winType || note === undefined || typeof startedAt !== "number" || !Number.isSafeInteger(startedAt)
    || startedAt < 0 || startedAt > now + 300_000 || !rawFouls || typeof rawFouls !== "object" || Array.isArray(rawFouls)) {
    return "invalid_command";
  }
  const foulEntries = Object.entries(rawFouls);
  if (foulEntries.some(([id, count]) => !state.currentPairIds.includes(id)
    || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 99)) {
    return "invalid_command";
  }
  return {
    playerIds: [...state.currentPairIds],
    winnerId,
    winType,
    fouls: Object.fromEntries(foulEntries) as Record<string, number>,
    note,
    startedAt,
  };
}

function eventPayload(match: TeamBattleMatch): JsonObject {
  const event = match.events.at(-1)!;
  const round = event.replacement ?? event.round;
  return {
    eventId: event.id,
    occurredAt: event.occurredAt,
    ...(event.correctsEventId ? { correctsEventId: event.correctsEventId } : {}),
    ...(round ? {
      playerIds: round.playerIds,
      winnerId: round.winnerId,
      winType: round.winType,
      fouls: round.fouls,
      note: round.note,
      startedAt: round.startedAt,
      confirmedAt: round.confirmedAt,
    } : {}),
  };
}

export function projectTeamBattleCommand(
  state: RealtimeTeamBattleState,
  command: { kind: string; payload: JsonObject; now: number },
): TeamBattleCommandProjection | TeamBattleCommandError {
  if (command.kind === "team_battle.pair.set") {
    const pair = playerIds(state, command.payload.playerIds);
    if (typeof pair === "string") return pair;
    return {
      kind: "team_battle.pair.changed",
      payload: { playerIds: pair },
      state: { ...state, currentPairIds: pair },
    };
  }

  try {
    if (command.kind === "team_battle.round.record") {
      const input = roundInput(state, command.payload, command.now);
      if (typeof input === "string") return input;
      const match = recordTeamBattleRound(state.match, input, command.now);
      return { kind: "team_battle.round.recorded", payload: eventPayload(match), state: { ...state, match } };
    }
    if (command.kind === "team_battle.round.undo") {
      const pairKey = teamBattlePairKey(...state.currentPairIds);
      if (!getEffectiveTeamBattleRounds(state.match).some((round) => teamBattlePairKey(...round.playerIds) === pairKey)) return "not_found";
      const match = undoLastTeamBattleRound(state.match, state.currentPairIds, command.now);
      return {
        kind: "team_battle.round.corrected",
        payload: { ...eventPayload(match), correctionSource: "undo" },
        state: { ...state, match },
      };
    }
    if (command.kind === "team_battle.round.correct") {
      const eventId = text(command.payload.eventId, 128);
      if (!eventId || !state.match.events.some((event) => event.id === eventId && event.type === "round")) return "not_found";
      const input = roundInput(state, command.payload, command.now);
      if (typeof input === "string") return input;
      const match = correctTeamBattleRound(state.match, eventId, { ...input, confirmedAt: command.now }, command.now);
      return {
        kind: "team_battle.round.corrected",
        payload: { ...eventPayload(match), correctionSource: "correction" },
        state: { ...state, match },
      };
    }
    if (command.kind === "team_battle.pause") {
      const match = pauseTeamBattleMatch(state.match, command.now);
      return { kind: "team_battle.paused", payload: eventPayload(match), state: { ...state, match } };
    }
    if (command.kind === "team_battle.resume") {
      const match = resumeTeamBattleMatch(state.match, command.now);
      return { kind: "team_battle.resumed", payload: eventPayload(match), state: { ...state, match } };
    }
  } catch {
    return "invalid_command";
  }
  return "invalid_command";
}
