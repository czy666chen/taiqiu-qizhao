import { describe, expect, it } from "vitest";
import {
  addDeletedMatch,
  APP_DATA_CODEC,
  APP_STORAGE_KEY,
  DELETED_MATCHES_KEY,
  EMPTY_APP_DATA,
  loadDeletedMatchIds,
  MemoryStorageAdapter,
  VersionedLocalStore,
} from "./local-storage";
import { createSnookerMatch, recordSnookerCommand } from "./snooker";

describe("versioned local storage", () => {
  it("migrates an existing v1 archive to v2 without losing legacy matches", () => {
    const existing = { ...EMPTY_APP_DATA, version: 1, scorePresets: [{ id: "friday", name: "周五", rules: [] }], activeSnookerMatch: undefined, snookerHistory: undefined };
    const adapter = new MemoryStorageAdapter({ [APP_STORAGE_KEY]: JSON.stringify(existing) });
    const store = new VersionedLocalStore(adapter);

    const migrated = { ...EMPTY_APP_DATA, scorePresets: existing.scorePresets };
    expect(store.read(APP_DATA_CODEC)).toEqual({ value: migrated });

    store.write(APP_DATA_CODEC, migrated);
    expect(JSON.parse(adapter.get(APP_STORAGE_KEY) ?? "")).toEqual(migrated);
  });

  it("restores a valid active snooker match and isolates a damaged snapshot", () => {
    const active = createSnookerMatch({ playerNames: ["甲", "乙"], bestOf: 3, firstStriker: 0 }, 100);
    const validStore = new VersionedLocalStore(new MemoryStorageAdapter({
      [APP_STORAGE_KEY]: JSON.stringify({ ...EMPTY_APP_DATA, activeSnookerMatch: active }),
    }));
    expect(validStore.read(APP_DATA_CODEC).value.activeSnookerMatch).toEqual(active);

    const damagedStore = new VersionedLocalStore(new MemoryStorageAdapter({
      [APP_STORAGE_KEY]: JSON.stringify({ ...EMPTY_APP_DATA, activeSnookerMatch: { ...active, currentFrame: { phase: "reds" } } }),
    }));
    expect(damagedStore.read(APP_DATA_CODEC).value.activeSnookerMatch).toBeNull();
  });

  it("round-trips a Best of 3 with frame scores and break state intact", () => {
    let match = createSnookerMatch({ playerNames: ["甲", "乙"], bestOf: 3, firstStriker: 0 }, 100);
    match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "red" }, 110);
    match = recordSnookerCommand(match, { type: "snooker.pot.record", ball: "black" }, 120);
    match = recordSnookerCommand(match, { type: "snooker.visit.end", reason: "safety" }, 130);
    match = recordSnookerCommand(match, { type: "snooker.frame.finish", winnerId: match.players[0].id, reason: "resignation" }, 140);
    match = recordSnookerCommand(match, { type: "snooker.frame.finish", winnerId: match.players[0].id, reason: "resignation" }, 150);
    const store = new VersionedLocalStore(new MemoryStorageAdapter());
    store.write(APP_DATA_CODEC, { ...EMPTY_APP_DATA, activeSnookerMatch: match });

    const restored = store.read(APP_DATA_CODEC).value.activeSnookerMatch!;
    expect(restored.framesWon[restored.players[0].id]).toBe(2);
    expect(restored.completedFrames).toHaveLength(2);
    expect(restored.completedFrames[0].breaks[0].points).toBe(8);
    expect(restored.currentFrame?.number).toBe(3);
  });

  it("reports corrupt data without overwriting the original archive", () => {
    const adapter = new MemoryStorageAdapter({ [APP_STORAGE_KEY]: "{broken" });
    const store = new VersionedLocalStore(adapter);

    expect(store.read(APP_DATA_CODEC)).toEqual({
      value: EMPTY_APP_DATA,
      issue: { message: "数据格式或版本无法识别", raw: "{broken" },
    });
    expect(adapter.get(APP_STORAGE_KEY)).toBe("{broken");
  });

  it("persists deleted-match tombstones that survive reload and are idempotent", () => {
    const adapter = new MemoryStorageAdapter();
    const store = new VersionedLocalStore(adapter);

    expect(loadDeletedMatchIds(store)).toEqual([]);
    expect(addDeletedMatch(store, "match-a")).toEqual(["match-a"]);
    expect(addDeletedMatch(store, "match-a")).toEqual(["match-a"]);
    expect(addDeletedMatch(store, "match-b")).toEqual(["match-a", "match-b"]);

    const reloaded = new VersionedLocalStore(new MemoryStorageAdapter({ [DELETED_MATCHES_KEY]: adapter.get(DELETED_MATCHES_KEY) ?? "" }));
    expect(loadDeletedMatchIds(reloaded)).toEqual(["match-a", "match-b"]);

    const corrupt = new VersionedLocalStore(new MemoryStorageAdapter({ [DELETED_MATCHES_KEY]: "{broken" }));
    expect(loadDeletedMatchIds(corrupt)).toEqual([]);
    expect(addDeletedMatch(corrupt, "match-c")).toEqual(["match-c"]);
  });
});
