import { CARD_DEFINITIONS, type SupportedGame } from "../data/cards";
import type { CardInstance } from "./deck";

export const DECK_LIMITS = {
  decksPerUser: 20,
  customCardsPerUser: 100,
  cardKindsPerDeck: 100,
  cardInstancesPerDeck: 200,
  quantityPerCard: 10,
  deckName: 40,
  cardTitle: 40,
  cardEffect: 500,
  safetyNote: 300,
} as const;

export type CardSafetyLevel = "low" | "medium" | "review";

export type DeckSnapshotCard =
  | { source: "official"; definitionId: string; quantity: number; supportedGames: SupportedGame[] }
  | {
      source: "custom";
      definitionId: string;
      quantity: number;
      snapshot: { title: string; effect: string; safetyLevel: CardSafetyLevel; safetyNote?: string; supportedGames: SupportedGame[] };
    };

export type DeckSnapshot = {
  formatVersion: 2;
  name: string;
  cards: DeckSnapshotCard[];
};

export type DeckGameFilterResult = {
  snapshot: DeckSnapshot;
  originalCount: number;
  compatibleCount: number;
  excludedCount: number;
};

export type DeckRef =
  | { kind: "official"; id: "complete"; version: 1 }
  | { kind: "user"; deckId: string; versionNo: number };

export type CustomCard = {
  id: string;
  title: string;
  effect: string;
  defaultQuantity: number;
  safetyLevel: CardSafetyLevel;
  safetyNote?: string;
  supportedGames: SupportedGame[];
  createdAt: number;
  updatedAt: number;
};

const isSupportedGame = (value: unknown): value is SupportedGame => value === "chinese_eight" || value === "snooker";

export function normalizeSupportedGames(value: unknown, fallback: SupportedGame[] = ["chinese_eight"]): SupportedGame[] {
  if (!Array.isArray(value)) return [...fallback];
  const games = Array.from(new Set(value.filter(isSupportedGame)));
  return games.length ? games : [...fallback];
}

export function parseDeckSnapshot(value: unknown): DeckSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as { formatVersion?: unknown; name?: unknown; cards?: unknown };
  if ((snapshot.formatVersion !== 1 && snapshot.formatVersion !== 2) || typeof snapshot.name !== "string" || !snapshot.name.trim()
    || snapshot.name.length > DECK_LIMITS.deckName || !Array.isArray(snapshot.cards)
    || snapshot.cards.length < 1 || snapshot.cards.length > DECK_LIMITS.cardKindsPerDeck) return null;
  const officialIds = new Set(CARD_DEFINITIONS.map((card) => card.id));
  let total = 0;
  const keys = new Set<string>();
  const normalizedCards: DeckSnapshotCard[] = [];
  for (const item of snapshot.cards) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const card = item as Partial<DeckSnapshotCard>;
    if ((card.source !== "official" && card.source !== "custom") || typeof card.definitionId !== "string"
      || !Number.isSafeInteger(card.quantity) || card.quantity! < 1 || card.quantity! > DECK_LIMITS.quantityPerCard) return null;
    const key = `${card.source}:${card.definitionId}`;
    if (keys.has(key)) return null;
    keys.add(key); total += card.quantity!;
    if (card.source === "official") {
      const definition = CARD_DEFINITIONS.find((item) => item.id === card.definitionId);
      if (!definition || !officialIds.has(card.definitionId)) return null;
      normalizedCards.push({ source: "official", definitionId: card.definitionId, quantity: card.quantity!, supportedGames: [...definition.supportedGames] });
    }
    if (card.source === "custom") {
      const custom = card as { source: "custom"; definitionId: string; quantity: number; snapshot?: Partial<Extract<DeckSnapshotCard, { source: "custom" }>["snapshot"]> };
      if (!custom.snapshot || typeof custom.snapshot.title !== "string" || !custom.snapshot.title.trim()
        || custom.snapshot.title.length > DECK_LIMITS.cardTitle || typeof custom.snapshot.effect !== "string"
        || !custom.snapshot.effect.trim() || custom.snapshot.effect.length > DECK_LIMITS.cardEffect
        || (custom.snapshot.safetyLevel !== "low" && custom.snapshot.safetyLevel !== "medium" && custom.snapshot.safetyLevel !== "review")
        || (custom.snapshot.safetyNote !== undefined && (typeof custom.snapshot.safetyNote !== "string" || custom.snapshot.safetyNote.length > DECK_LIMITS.safetyNote))) return null;
      normalizedCards.push({
        source: "custom", definitionId: custom.definitionId, quantity: custom.quantity,
        snapshot: {
          title: custom.snapshot.title, effect: custom.snapshot.effect, safetyLevel: custom.snapshot.safetyLevel,
          ...(custom.snapshot.safetyNote ? { safetyNote: custom.snapshot.safetyNote } : {}),
          supportedGames: snapshot.formatVersion === 2 ? normalizeSupportedGames(custom.snapshot.supportedGames) : ["chinese_eight"],
        },
      });
    }
  }
  return total <= DECK_LIMITS.cardInstancesPerDeck ? { formatVersion: 2, name: snapshot.name, cards: normalizedCards } : null;
}

export function filterDeckSnapshotForGame(snapshot: DeckSnapshot, game: SupportedGame): DeckGameFilterResult {
  const cards = snapshot.cards.filter((card) => {
    if (card.source === "official") {
      const definition = CARD_DEFINITIONS.find((item) => item.id === card.definitionId);
      return definition?.supportedGames.includes(game) && card.supportedGames.includes(game);
    }
    return card.snapshot.supportedGames.includes(game);
  });
  const originalCount = snapshot.cards.reduce((sum, card) => sum + card.quantity, 0);
  const compatibleCount = cards.reduce((sum, card) => sum + card.quantity, 0);
  return { snapshot: { ...snapshot, cards }, originalCount, compatibleCount, excludedCount: originalCount - compatibleCount };
}

export function officialDeckSnapshot(name = "完整奇招"): DeckSnapshot {
  return {
    formatVersion: 2,
    name,
    cards: CARD_DEFINITIONS.map((card) => ({ source: "official", definitionId: card.id, quantity: card.count, supportedGames: [...card.supportedGames] })),
  };
}

export function deckSnapshotInstances(snapshot: DeckSnapshot): CardInstance[] {
  const official = new Map(CARD_DEFINITIONS.map((card) => [card.id, card]));
  return snapshot.cards.flatMap((card) => {
    const definition = card.source === "official" ? official.get(card.definitionId) : undefined;
    if (card.source === "official" && !definition) return [];
    const title = card.source === "custom" ? card.snapshot.title : definition!.title;
    const effect = card.source === "custom" ? card.snapshot.effect : definition!.effect;
    const safetyNote = card.source === "custom" ? card.snapshot.safetyNote : definition!.safetyNote;
    return Array.from({ length: card.quantity }, (_, index): CardInstance => ({
      instanceId: `${card.source}-${card.definitionId}-${index + 1}`,
      definitionId: card.definitionId,
      displayNumber: card.source === "official" ? card.definitionId.slice(-3) : `自${index + 1}`,
      title,
      effect,
      ...(safetyNote ? { safetyNote } : {}),
    }));
  });
}
