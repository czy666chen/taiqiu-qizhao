import { describe, expect, it, vi } from "vitest";
import { enqueueMigrationResources, flushSyncQueue, removeQueuedMatchUploads, retrySyncQueue, SYNC_QUEUE_CODEC } from "./cloud-sync";
import type { PreparedLocalMigration } from "./local-migration";
import { CLOUD_LINKS_CODEC, MemoryStorageAdapter, VersionedLocalStore } from "./local-storage";

function migration(): PreparedLocalMigration {
  const resource = (localId: string) => ({
    kind: "match" as const,
    localId,
    resourceId: `${localId}0000-0000-5000-8000-000000000000`.slice(0, 36),
    operationId: `${localId}1111-1111-5111-8111-111111111111`.slice(0, 36),
    snapshotJson: JSON.stringify({ id: localId, mode: "score", players: [{ name: "A" }] }),
    checksum: "a".repeat(64),
  });
  return {
    formatVersion: 1,
    preparedAt: 1,
    preview: { players: 1, presets: 0, decks: 0, matches: 2, eightBallRounds: 0 },
    backup: { formatVersion: 1, createdAt: 1, entries: [], checksum: "b".repeat(64) },
    resources: [resource("a"), resource("b")],
  };
}

describe("persistent offline sync queue", () => {
  it("enqueues a changed snapshot even after the same local resource was acknowledged", () => {
    const store = new VersionedLocalStore(new MemoryStorageAdapter());
    const first = migration();
    store.write(CLOUD_LINKS_CODEC, {
      version: 1,
      links: {
        "match:a": {
          kind: "match",
          localId: "a",
          resourceId: "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
          version: 1,
          lastSyncedAt: 100,
          operationId: first.resources[0].operationId,
        },
      },
    });
    const changed = migration();
    changed.resources[0] = {
      ...changed.resources[0],
      operationId: "cccccccc-cccc-5ccc-8ccc-cccccccccccc",
      checksum: "c".repeat(64),
      snapshotJson: JSON.stringify({ id: "a", status: "completed" }),
    };

    expect(enqueueMigrationResources(store, changed, 200)).toBe(2);
    expect(store.read(SYNC_QUEUE_CODEC).value.items.map((item) => item.resource.localId)).toContain("a");
  });

  it("enqueues once, confirms in order, and only removes acknowledged items", async () => {
    const store = new VersionedLocalStore(new MemoryStorageAdapter());
    expect(enqueueMigrationResources(store, migration(), 100)).toBe(2);
    expect(enqueueMigrationResources(store, migration(), 200)).toBe(0);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "accepted", resourceId: "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa" }), { status: 201 }))
      .mockRejectedValueOnce(new TypeError("offline"));

    const result = await flushSyncQueue(store, {
      deviceId: "dddddddd-dddd-5ddd-8ddd-dddddddddddd", fetcher, now: 1_000,
    });
    expect(result).toMatchObject({ accepted: 1, failed: 1, remaining: 1 });
    const queue = store.read(SYNC_QUEUE_CODEC).value.items;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ state: "failed", attempts: 1, nextAttemptAt: 2_000 });
    expect(Object.keys(store.read(CLOUD_LINKS_CODEC).value.links)).toEqual(["match:a"]);
  });

  it("stops on conflict or authentication loss and supports an explicit retry", async () => {
    const store = new VersionedLocalStore(new MemoryStorageAdapter());
    enqueueMigrationResources(store, migration(), 100);
    const conflict = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "版本冲突" }), { status: 409 }));
    await expect(flushSyncQueue(store, { deviceId: crypto.randomUUID(), fetcher: conflict, now: 200 }))
      .resolves.toMatchObject({ conflict: 1, remaining: 2 });
    expect(conflict).toHaveBeenCalledTimes(1);
    retrySyncQueue(store, 300);
    expect(store.read(SYNC_QUEUE_CODEC).value.items[0]).toMatchObject({ state: "pending", nextAttemptAt: 300 });

    const auth = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "请先登录" }), { status: 401 }));
    await expect(flushSyncQueue(store, { deviceId: crypto.randomUUID(), fetcher: auth, now: 300 }))
      .resolves.toMatchObject({ authRequired: true, remaining: 2 });
    expect(store.read(SYNC_QUEUE_CODEC).value.items[0].state).toBe("auth_required");
  });

  it("times out a stalled cloud upload and leaves it retryable", async () => {
    const store = new VersionedLocalStore(new MemoryStorageAdapter());
    enqueueMigrationResources(store, migration(), 100);
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));

    await expect(flushSyncQueue(store, {
      deviceId: crypto.randomUUID(), fetcher: fetcher as typeof fetch, now: 300, timeoutMs: 1,
    })).resolves.toMatchObject({ failed: 1, remaining: 2 });
    expect(store.read(SYNC_QUEUE_CODEC).value.items[0]).toMatchObject({ state: "failed", attempts: 1 });
  });

  it("drops queued uploads of a deleted match so it can never be re-synced", () => {
    const store = new VersionedLocalStore(new MemoryStorageAdapter());
    enqueueMigrationResources(store, migration(), 100);
    expect(store.read(SYNC_QUEUE_CODEC).value.items).toHaveLength(2);

    expect(removeQueuedMatchUploads(store, "a")).toBe(1);
    expect(store.read(SYNC_QUEUE_CODEC).value.items.map((item) => item.resource.localId)).toEqual(["b"]);
    expect(removeQueuedMatchUploads(store, "a")).toBe(0);
    expect(removeQueuedMatchUploads(store, "missing")).toBe(0);
    expect(store.read(SYNC_QUEUE_CODEC).value.items.map((item) => item.resource.localId)).toEqual(["b"]);
  });
});
