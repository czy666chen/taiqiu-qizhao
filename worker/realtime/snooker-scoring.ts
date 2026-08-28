import {
  createSnookerMatch,
  correctSnookerEvent,
  recordSnookerCommand,
  undoLastSnookerEvent,
  type OfficialSnookerFoulPoints,
  type SnookerBall,
  type SnookerCommand,
  type SnookerDraft,
  type SnookerMatch,
} from "../../src/lib/snooker";
import type { JsonObject, JsonValue } from "./chase-scoring";
import type { RoomCardState } from "./room-cards";

export type RealtimeSnookerPlayer = { id: string; nickname: string; userId?: string };

export type RealtimeSnookerState = {
  mode: "snooker";
  match: SnookerMatch;
  players: [RealtimeSnookerPlayer, RealtimeSnookerPlayer];
  cards?: RoomCardState;
};

export type SnookerCommandProjection = {
  state: RealtimeSnookerState;
  kind: string;
  payload: JsonObject;
};

const BALLS = new Set<SnookerBall>(["red", "yellow", "green", "brown", "blue", "pink", "black"]);
const FOUL_POINTS = new Set<OfficialSnookerFoulPoints>([4, 5, 6, 7]);

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

function ball(value: JsonValue | undefined): SnookerBall | undefined {
  return typeof value === "string" && BALLS.has(value as SnookerBall) ? value as SnookerBall : undefined;
}

function commandFromPayload(kind: string, payload: JsonObject): SnookerCommand | undefined {
  if (kind === "snooker.pot.record") {
    const selected = ball(payload.ball);
    return selected ? { type: kind, ball: selected } : undefined;
  }
  if (kind === "snooker.visit.end") {
    const reason = payload.reason;
    return reason === "miss" || reason === "safety" || reason === "voluntary" ? { type: kind, reason } : undefined;
  }
  if (kind === "snooker.foul.record") {
    const rawValues = payload.values;
    const values = Array.isArray(rawValues)
      ? rawValues.filter((value): value is OfficialSnookerFoulPoints => typeof value === "number" && FOUL_POINTS.has(value as OfficialSnookerFoulPoints))
      : [];
    return values.length && Array.isArray(rawValues) && values.length === rawValues.length ? { type: kind, values, isMiss: payload.isMiss === true } : undefined;
  }
  if (kind === "snooker.free_ball.declare") {
    const nominatedBall = ball(payload.nominatedBall);
    const valueAs = ball(payload.valueAs);
    return nominatedBall && valueAs ? { type: kind, nominatedBall, valueAs } : undefined;
  }
  if (kind === "snooker.replay.request") {
    return payload.kind === "from_position" || payload.kind === "restore" ? { type: kind, kind: payload.kind } : undefined;
  }
  if (kind === "snooker.respotted_black.start") {
    const firstStrikerId = text(payload.firstStrikerId);
    return firstStrikerId ? { type: kind, firstStrikerId } : undefined;
  }
  if (kind === "snooker.frame.finish") {
    const winnerId = text(payload.winnerId);
    const reason = payload.reason;
    return reason === "normal" || reason === "resignation" || reason === "award"
      ? { type: kind, ...(winnerId ? { winnerId } : {}), reason }
      : undefined;
  }
  if (kind === "snooker.frame.restart") {
    const firstStrikerId = text(payload.firstStrikerId);
    return { type: kind, ...(firstStrikerId ? { firstStrikerId } : {}) };
  }
  if (kind === "snooker.pause" || kind === "snooker.resume" || kind === "snooker.finish") return { type: kind };
  if (kind === "snooker.player.rename") {
    const playerId = text(payload.playerId);
    const name = text(payload.name);
    return playerId && name ? { type: kind, playerId, name } : undefined;
  }
  return undefined;
}

export function createRealtimeSnookerState(input: {
  playerIds: [string, string];
  playerNames: [string, string];
  bestOf: number | null;
  firstStriker: 0 | 1;
  initialReds?: number;
  title?: string;
  location?: string;
  note?: string;
  now: number;
  cards?: RoomCardState;
}): RealtimeSnookerState {
  const draft: SnookerDraft = {
    playerNames: input.playerNames,
    bestOf: input.bestOf,
    firstStriker: input.firstStriker,
    initialReds: input.initialReds,
    title: input.title,
    location: input.location,
    note: input.note,
    variant: input.cards ? "trick_cards" : "standard",
  };
  const created = createSnookerMatch(draft, input.now);
  const oldIds = created.players.map(({ id }) => id) as [string, string];
  const id = (value: string) => value === oldIds[0] ? input.playerIds[0] : value === oldIds[1] ? input.playerIds[1] : value;
  const frame = created.currentFrame!;
  const match: SnookerMatch = {
    ...created,
    players: created.players.map((player, index) => ({ ...player, id: input.playerIds[index] })) as SnookerMatch["players"],
    firstStrikerId: id(created.firstStrikerId),
    framesWon: { [input.playerIds[0]]: 0, [input.playerIds[1]]: 0 },
    currentFrame: {
      ...frame,
      playerIds: input.playerIds,
      scores: { [input.playerIds[0]]: 0, [input.playerIds[1]]: 0 },
      strikerId: id(frame.strikerId),
      currentBreak: { ...frame.currentBreak, playerId: id(frame.currentBreak.playerId) },
    },
  };
  return {
    mode: "snooker",
    match,
    players: match.players.map((player) => ({ id: player.id, nickname: player.name })) as RealtimeSnookerState["players"],
    ...(input.cards ? { cards: input.cards } : {}),
  };
}

export function projectRealtimeSnookerCommand(
  state: RealtimeSnookerState,
  input: { kind: string; payload: JsonObject; now: number },
): SnookerCommandProjection | "invalid_command" | "not_found" {
  try {
    let match: SnookerMatch;
    if (input.kind === "snooker.event.undo") {
      match = undoLastSnookerEvent(state.match, input.now);
      if (match === state.match) return "not_found";
    } else if (input.kind === "snooker.event.correct") {
      const eventId = text(input.payload.eventId);
      if (!eventId) return "invalid_command";
      const replacementKind = text(input.payload.replacementKind);
      const replacementPayload = input.payload.replacementPayload;
      const replacement = replacementKind && replacementPayload && typeof replacementPayload === "object" && !Array.isArray(replacementPayload)
        ? commandFromPayload(replacementKind, replacementPayload as JsonObject)
        : undefined;
      if (replacementKind && !replacement) return "invalid_command";
      match = correctSnookerEvent(state.match, eventId, replacement ?? null, input.now);
    } else {
      const command = commandFromPayload(input.kind, input.payload);
      if (!command) return "invalid_command";
      match = recordSnookerCommand(state.match, command, input.now);
    }
    return {
      state: { ...state, match },
      kind: input.kind,
      payload: { ...input.payload, occurredAt: input.now },
    };
  } catch {
    return "invalid_command";
  }
}
