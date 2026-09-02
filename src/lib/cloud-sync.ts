import type { MigrationResource, PreparedLocalMigration } from "./local-migration";
import { CLOUD_LINKS_CODEC, SYNC_QUEUE_KEY, VersionedLocalStore, type VersionedCodec } from "./local-storage";

export type SyncQueueState = "pending" | "syncing" | "failed" | "conflict" | "auth_required";

export type SyncQueueItem = {
  operationId: string;
  batchId: string;
  resource: MigrationResource;
  state: SyncQueueState;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
  error?: string;
};

export type SyncQueue = { version: 1; items: SyncQueueItem[] };

function isQueueItem(value: unknown): value is SyncQueueItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SyncQueueItem>;
  return typeof item.operationId === "string" && typeof item.batchId === "string"
    && typeof item.attempts === "number" && typeof item.createdAt === "number"
    && typeof item.nextAttemptAt === "number" && !!item.resource
    && typeof item.resource === "object" && typeof item.resource.operationId === "string";
}

export const SYNC_QUEUE_CODEC: VersionedCodec<SyncQueue> = {
  key: SYNC_QUEUE_KEY,
  version: 1,
  empty: { version: 1, items: [] },
  decode(raw) {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("invalid sync queue");
    const value = parsed as Partial<SyncQueue>;
    if (value.version !== 1 || !Array.isArray(value.items) || !value.items.every(isQueueItem)) {
      throw new Error("invalid sync queue");
    }
    return { version: 1, items: value.items };
  },
};

export function enqueueMigrationResources(
  store: VersionedLocalStore,
  migration: PreparedLocalMigration,
  now = Date.now(),
): number {
  const queue = store.read(SYNC_QUEUE_CODEC);
  const links = store.read(CLOUD_LINKS_CODEC);
  if (queue.issue) throw new Error("离线同步队列已损坏，已停止写入");
  if (links.issue) throw new Error("云端资源映射已损坏，已停止写入");
  const existing = new Set(queue.value.items.map((item) => item.operationId));
  const additions = migration.resources.filter((resource) => {
    if (existing.has(resource.operationId)) return false;
    const link = links.value.links[`${resource.kind}:${resource.localId}`];
    return !link || link.operationId !== resource.operationId;
  }).map((resource) => ({
    operationId: resource.operationId,
    batchId: migration.backup.checksum,
    resource,
    state: "pending" as const,
    attempts: 0,
    createdAt: now,
    nextAttemptAt: now,
  }));
  if (additions.length) store.write(SYNC_QUEUE_CODEC, { version: 1, items: [...queue.value.items, ...additions] });
  return additions.length;
}

export type FlushResult = {
  accepted: number;
  duplicate: number;
  failed: number;
  conflict: number;
  authRequired: boolean;
  remaining: number;
};

function retryDelay(attempts: number): number {
  return Math.min(60_000, 1_000 * (2 ** Math.max(0, attempts - 1)));
}

export async function flushSyncQueue(
  store: VersionedLocalStore,
  options: { deviceId: string; fetcher?: typeof fetch; now?: number; maxItems?: number; timeoutMs?: number; signal?: AbortSignal },
): Promise<FlushResult> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now();
  const loaded = store.read(SYNC_QUEUE_CODEC);
  const linksLoaded = store.read(CLOUD_LINKS_CODEC);
  if (loaded.issue) throw new Error("离线同步队列已损坏，已停止补传");
  if (linksLoaded.issue) throw new Error("云端资源映射已损坏，已停止补传");
  const items = loaded.value.items.map((item) => item.state === "syncing" ? { ...item, state: "pending" as const } : { ...item });
  const links = { ...linksLoaded.value.links };
  const result: FlushResult = { accepted: 0, duplicate: 0, failed: 0, conflict: 0, authRequired: false, remaining: 0 };
  let processed = 0;

  for (let index = 0; index < items.length && processed < (options.maxItems ?? 100); index += 1) {
    const item = items[index];
    if (item.state === "conflict" || item.state === "auth_required" || item.nextAttemptAt > now) continue;
    item.state = "syncing";
    store.write(SYNC_QUEUE_CODEC, { version: 1, items });
    processed += 1;
    try {
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
      const response = await fetcher("/api/migrations/local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: item.batchId, deviceId: options.deviceId, item: item.resource }),
        signal,
      });
      const payload = await response.json() as { result?: "accepted" | "duplicate"; resourceId?: string; error?: string };
      if (response.ok && payload.resourceId && (payload.result === "accepted" || payload.result === "duplicate")) {
        result[payload.result] += 1;
        links[`${item.resource.kind}:${item.resource.localId}`] = {
          kind: item.resource.kind,
          localId: item.resource.localId,
          resourceId: payload.resourceId,
          version: 1,
          lastSyncedAt: now,
          operationId: item.operationId,
        };
        items.splice(index, 1);
        index -= 1;
        store.write(CLOUD_LINKS_CODEC, { version: 1, links });
      } else if (response.status === 401) {
        item.state = "auth_required";
        item.error = payload.error ?? "登录已失效";
        result.authRequired = true;
        break;
      } else if (response.status === 409) {
        item.state = "conflict";
        item.error = payload.error ?? "云端版本冲突";
        result.conflict += 1;
        break;
      } else {
        item.attempts += 1;
        item.state = "failed";
        item.error = payload.error ?? `HTTP ${response.status}`;
        item.nextAttemptAt = now + retryDelay(item.attempts);
        result.failed += 1;
        break;
      }
    } catch (error) {
      item.attempts += 1;
      item.state = "failed";
      item.error = error instanceof Error ? error.message : "网络请求失败";
      item.nextAttemptAt = now + retryDelay(item.attempts);
      result.failed += 1;
      break;
    }
  }
  result.remaining = items.length;
  store.write(SYNC_QUEUE_CODEC, { version: 1, items });
  return result;
}

export function retrySyncQueue(store: VersionedLocalStore, now = Date.now()): void {
  const loaded = store.read(SYNC_QUEUE_CODEC);
  if (loaded.issue) throw new Error("离线同步队列已损坏");
  store.write(SYNC_QUEUE_CODEC, {
    version: 1,
    items: loaded.value.items.map((item) => ({
      ...item,
      state: "pending" as const,
      nextAttemptAt: now,
      error: undefined,
    })),
  });
}

export function removeQueuedMatchUploads(store: VersionedLocalStore, localId: string): number {
  const loaded = store.read(SYNC_QUEUE_CODEC);
  if (loaded.issue) return 0;
  const remaining = loaded.value.items.filter(
    (item) => !(item.resource.kind === "match" && item.resource.localId === localId),
  );
  if (remaining.length !== loaded.value.items.length) {
    store.write(SYNC_QUEUE_CODEC, { version: 1, items: remaining });
  }
  return loaded.value.items.length - remaining.length;
}

export function syncQueueSummary(store: VersionedLocalStore): Record<SyncQueueState, number> & { total: number } {
  const loaded = store.read(SYNC_QUEUE_CODEC);
  if (loaded.issue) throw new Error("离线同步队列已损坏");
  const summary = { pending: 0, syncing: 0, failed: 0, conflict: 0, auth_required: 0, total: loaded.value.items.length };
  loaded.value.items.forEach((item) => { summary[item.state] += 1; });
  return summary;
}
