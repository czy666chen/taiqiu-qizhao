export type RealtimeCardNotice = {
  action: "draw" | "play" | "skip";
  playerName: string;
  card?: { title: string; effect: string };
};

export function createRealtimeCardNotice(
  event: { kind?: string; payload?: Record<string, unknown> },
  playerName: (playerId: string) => string,
): RealtimeCardNotice | null {
  const actions: Record<string, RealtimeCardNotice["action"]> = { "card.drawn": "draw", "card.played": "play", "card.skipped": "skip" };
  const action = actions[event.kind ?? ""];
  const playerId = event.payload?.playerId;
  if (!action || typeof playerId !== "string") return null;
  if (action === "draw") return { action, playerName: playerName(playerId) };

  const card = event.payload?.card;
  if (!card || typeof card !== "object") return null;
  const { title, effect } = card as Record<string, unknown>;
  if (typeof title !== "string" || typeof effect !== "string") return null;
  return { action, playerName: playerName(playerId), card: { title, effect } };
}
