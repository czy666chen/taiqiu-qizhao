import type { EightBallMatch } from "./eight-ball";
import type { BilliardsMatch, MatchCardState } from "./match";
import type { SnookerMatch } from "./snooker";
import {
  AppData,
  APP_STORAGE_KEY,
  CLOUD_LINKS_CODEC,
  EIGHT_BALL_LAYOUT_KEY,
  loadAppData,
  VersionedLocalStore,
} from "./local-storage";

export type MigrationResourceKind = "preset" | "deck" | "match";

export type MigrationResource = {
  kind: MigrationResourceKind;
  localId: string;
  resourceId: string;
  operationId: string;
  snapshotJson: string;
  checksum: string;
};

export type PreparedLocalMigration = {
  formatVersion: 1;
  preparedAt: number;
  preview: { players: number; presets: number; decks: number; matches: number; eightBallRounds: number };
  backup: {
    formatVersion: 1;
    createdAt: number;
    entries: { key: string; value: string }[];
    checksum: string;
  };
  resources: MigrationResource[];
};

const MIGRATION_KEYS = new Set([APP_STORAGE_KEY, EIGHT_BALL_LAYOUT_KEY, "billiards-trick-cards:v2", "neon-pool-cards:v1"]);

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function stableUuid(namespace: string, localId: string): Promise<string> {
  const hex = await sha256(`${namespace}\u0000${localId}`);
  const bytes = Uint8Array.from(hex.slice(0, 32).match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const id = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function collectMatches(data: AppData): (BilliardsMatch | EightBallMatch | SnookerMatch)[] {
  // Team battles stay in the raw local backup but never become cloud migration resources.
  const candidates = [
    data.activeMatch,
    ...data.history,
    ...data.pausedMatches,
    ...data.recoverySnapshots.map((item) => item.match),
    data.activeEightBallMatch,
    ...data.eightBallHistory,
    data.activeSnookerMatch,
    ...data.snookerHistory,
  ].filter((match): match is BilliardsMatch | EightBallMatch | SnookerMatch => match !== null);
  return [...new Map(candidates.map((match) => [match.id, match])).values()];
}

function collectDecks(matches: (BilliardsMatch | EightBallMatch | SnookerMatch)[]) {
  const decks = new Map<string, MatchCardState["deckSnapshot"]>();
  for (const match of matches) {
    if ("cards" in match && match.cards?.deckSnapshot) {
      const deck = match.cards.deckSnapshot;
      decks.set(`${deck.id}:v${deck.version}`, deck);
    }
  }
  return [...decks.entries()].map(([localId, snapshot]) => ({ localId, snapshot }));
}

function playerNames(matches: (BilliardsMatch | EightBallMatch | SnookerMatch)[]): string[] {
  const names = new Map<string, string>();
  for (const match of matches) {
    for (const player of match.players) {
      const name = player.name.trim();
      if (name) names.set(name.toLocaleLowerCase("zh-CN"), name);
    }
  }
  return [...names.values()];
}

async function resource(kind: MigrationResourceKind, localId: string, snapshot: unknown): Promise<MigrationResource> {
  const snapshotJson = JSON.stringify(snapshot);
  const checksum = await sha256(snapshotJson);
  return {
    kind,
    localId,
    resourceId: await stableUuid(`hei8-r3-${kind}`, localId),
    operationId: await stableUuid("hei8-r3-migration-operation", `${kind}:${localId}:${checksum}`),
    snapshotJson,
    checksum,
  };
}

export async function prepareLocalMigration(store: VersionedLocalStore, now = Date.now()): Promise<PreparedLocalMigration> {
  const loaded = loadAppData(store);
  if (loaded.issue) throw new Error(`无法迁移损坏的本机存档：${loaded.issue.message}`);

  const entries = store.adapter.keys()
    .filter((key) => MIGRATION_KEYS.has(key) || key.startsWith(`${APP_STORAGE_KEY}:corrupt-backup:`))
    .sort()
    .flatMap((key) => {
      const value = store.adapter.get(key);
      return value === null ? [] : [{ key, value }];
    });
  const backupChecksum = await sha256(JSON.stringify({ formatVersion: 1, entries }));
  const matches = collectMatches(loaded.value);
  const decks = collectDecks(matches);
  const resources = await Promise.all([
    ...loaded.value.scorePresets.map((preset) => resource("preset", preset.id, preset)),
    ...decks.map((deck) => resource("deck", deck.localId, deck.snapshot)),
    ...matches.map((match) => resource("match", match.id, match)),
  ]);
  const eightBallRounds = matches.reduce((total, match) => total + ("schemaVersion" in match
    ? match.events.filter((event) => event.type === "round").length
    : 0), 0);

  return {
    formatVersion: 1,
    preparedAt: now,
    preview: {
      players: playerNames(matches).length,
      presets: loaded.value.scorePresets.length,
      decks: decks.length,
      matches: matches.length,
      eightBallRounds,
    },
    backup: { formatVersion: 1, createdAt: now, entries, checksum: backupChecksum },
    resources,
  };
}

type UploadItemStatus = "accepted" | "duplicate" | "failed" | "cancelled";
export type MigrationUploadResult = {
  summary: Record<UploadItemStatus, number>;
  items: { resource: MigrationResource; status: UploadItemStatus; cloudResourceId?: string; message?: string }[];
};

export async function uploadLocalMigration(
  migration: PreparedLocalMigration,
  options: { deviceId: string; fetcher?: typeof fetch; signal?: AbortSignal },
): Promise<MigrationUploadResult> {
  const fetcher = options.fetcher ?? fetch;
  const items: MigrationUploadResult["items"] = [];
  for (const migrationResource of migration.resources) {
    if (options.signal?.aborted) {
      items.push({ resource: migrationResource, status: "cancelled" });
      continue;
    }
    try {
      const response = await fetcher("/api/migrations/local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: migration.backup.checksum, deviceId: options.deviceId, item: migrationResource }),
        signal: options.signal,
      });
      const payload = await response.json() as { result?: string; resourceId?: string; error?: string };
      if (response.ok && (payload.result === "accepted" || payload.result === "duplicate")) {
        items.push({ resource: migrationResource, status: payload.result, cloudResourceId: payload.resourceId });
      } else {
        items.push({ resource: migrationResource, status: "failed", message: payload.error ?? `HTTP ${response.status}` });
      }
    } catch (error) {
      const cancelled = options.signal?.aborted;
      items.push({
        resource: migrationResource,
        status: cancelled ? "cancelled" : "failed",
        message: cancelled ? undefined : error instanceof Error ? error.message : "网络请求失败",
      });
    }
  }
  const summary = { accepted: 0, duplicate: 0, failed: 0, cancelled: 0 };
  items.forEach((item) => { summary[item.status] += 1; });
  return { summary, items };
}

export function recordMigrationUpload(store: VersionedLocalStore, result: MigrationUploadResult, now = Date.now()): void {
  const current = store.read(CLOUD_LINKS_CODEC);
  if (current.issue) throw new Error("云端资源映射已损坏，已停止写入");
  const links = { ...current.value.links };
  for (const item of result.items) {
    if ((item.status !== "accepted" && item.status !== "duplicate") || !item.cloudResourceId) continue;
    links[`${item.resource.kind}:${item.resource.localId}`] = {
      kind: item.resource.kind,
      localId: item.resource.localId,
      resourceId: item.cloudResourceId,
      version: 1,
      lastSyncedAt: now,
      operationId: item.resource.operationId,
    };
  }
  store.write(CLOUD_LINKS_CODEC, { version: 1, links });
}

export function downloadMigrationBackup(migration: PreparedLocalMigration): void {
  const blob = new Blob([JSON.stringify(migration.backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `台球奇招-本机备份-${migration.backup.checksum.slice(0, 12)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
