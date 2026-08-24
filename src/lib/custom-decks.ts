import { CARD_DEFINITIONS } from "../data/cards";
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
  | { source: "official"; definitionId: string; quantity: number }
  | {
      source: "custom";
      definitionId: string;
      quantity: number;
      snapshot: { title: string; effect: string; safetyLevel: CardSafetyLevel; safetyNote?: string };
    };

export type DeckSnapshot = {
  formatVersion: 1;
  name: string;
  cards: DeckSnapshotCard[];
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
  createdAt: number;
  updatedAt: number;
};

export function parseDeckSnapshot(value: unknown): DeckSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<DeckSnapshot>;
  if (snapshot.formatVersion !== 1 || typeof snapshot.name !== "string" || !snapshot.name.trim()
    || snapshot.name.length > DECK_LIMITS.deckName || !Array.isArray(snapshot.cards)
    || snapshot.cards.length < 1 || snapshot.cards.length > DECK_LIMITS.cardKindsPerDeck) return null;
  const officialIds = new Set(CARD_DEFINITIONS.map((card) => card.id));
  let total = 0;
  const keys = new Set<string>();
  for (const item of snapshot.cards) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const card = item as Partial<DeckSnapshotCard>;
    if ((card.source !== "official" && card.source !== "custom") || typeof card.definitionId !== "string"
      || !Number.isSafeInteger(card.quantity) || card.quantity! < 1 || card.quantity! > DECK_LIMITS.quantityPerCard) return null;
    const key = `${card.source}:${card.definitionId}`;
    if (keys.has(key)) return null;
    keys.add(key); total += card.quantity!;
    if (card.source === "official" && !officialIds.has(card.definitionId)) return null;
    if (card.source === "custom") {
      const custom = card as Extract<DeckSnapshotCard, { source: "custom" }>;
      if (!custom.snapshot || typeof custom.snapshot.title !== "string" || !custom.snapshot.title.trim()
        || custom.snapshot.title.length > DECK_LIMITS.cardTitle || typeof custom.snapshot.effect !== "string"
        || !custom.snapshot.effect.trim() || custom.snapshot.effect.length > DECK_LIMITS.cardEffect
        || !["low", "medium", "review"].includes(custom.snapshot.safetyLevel)
        || (custom.snapshot.safetyNote !== undefined && (typeof custom.snapshot.safetyNote !== "string" || custom.snapshot.safetyNote.length > DECK_LIMITS.safetyNote))) return null;
    }
  }
  return total <= DECK_LIMITS.cardInstancesPerDeck ? snapshot as DeckSnapshot : null;
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
