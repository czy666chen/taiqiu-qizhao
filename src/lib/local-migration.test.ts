import { describe, expect, it, vi } from "vitest";
import { createEightBallMatch, recordEightBallRound } from "./eight-ball";
import { createMatch, DEFAULT_RULES, finishMatch } from "./match";
import {
  APP_DATA_CODEC,
  APP_STORAGE_KEY,
  EMPTY_APP_DATA,
  MemoryStorageAdapter,
  VersionedLocalStore,
} from "./local-storage";
import { prepareLocalMigration, recordMigrationUpload, uploadLocalMigration } from "./local-migration";
import { createSnookerMatch } from "./snooker";
import { createTeamBattleMatch, recordTeamBattleRound } from "./team-battle";

function localArchive() {
  const score = finishMatch(createMatch({
    mode: "score",
    playerNames: ["阿青", "阿蓝"],
    initialScore: 0,
    rules: DEFAULT_RULES,
    cardMode: "none",
    initialHandSize: 0,
  }, 100), 200);
  const eight = recordEightBallRound(createEightBallMatch({
    playerNames: ["阿青", "阿红"],
    raceTo: 3,
    firstServer: 0,
    serveRule: "alternate",
    layout: "stacked",
  }, 300), { winnerId: "match-player-300-1", winType: "normal", fouls: {}, note: "", startedAt: 300 }, 400);
  return {
    ...EMPTY_APP_DATA,
    history: [score],
    eightBallHistory: [eight],
    scorePresets: [{ id: "club-night", name: "俱乐部", rules: DEFAULT_RULES }],
  };
}

describe("local migration preparation", () => {
  it("creates a read-only preview, complete backup checksum, and stable retry identifiers", async () => {
    const archive = localArchive();
    const adapter = new MemoryStorageAdapter({
      [APP_STORAGE_KEY]: JSON.stringify(archive),
      "billiards-eight-layout:v1": "split",
    });
    const store = new VersionedLocalStore(adapter);
    const before = Object.fromEntries(adapter.keys().map((key) => [key, adapter.get(key)]));

    const first = await prepareLocalMigration(store, 1_000);
    const second = await prepareLocalMigration(store, 2_000);

    expect(first.preview).toEqual({ players: 3, presets: 1, decks: 0, matches: 2, eightBallRounds: 1 });
    expect(first.backup.entries).toEqual([
      { key: APP_STORAGE_KEY, value: JSON.stringify(archive) },
      { key: "billiards-eight-layout:v1", value: "split" },
    ]);
    expect(first.backup.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(first.resources).toHaveLength(3);
    expect(second.resources.map(({ resourceId, operationId }) => ({ resourceId, operationId })))
      .toEqual(first.resources.map(({ resourceId, operationId }) => ({ resourceId, operationId })));
    expect(Object.fromEntries(adapter.keys().map((key) => [key, adapter.get(key)]))).toEqual(before);
    expect(store.read(APP_DATA_CODEC).issue).toBeUndefined();
  });

  it("includes active snooker matches in cloud migration resources", async () => {
    const snooker = createSnookerMatch({ playerNames: ["斯诺克甲", "斯诺克乙"], bestOf: 3, firstStriker: 0 }, 500);
    const store = new VersionedLocalStore(new MemoryStorageAdapter({
      [APP_STORAGE_KEY]: JSON.stringify({ ...EMPTY_APP_DATA, activeSnookerMatch: snooker }),
    }));

    const migration = await prepareLocalMigration(store, 1_000);
    expect(migration.preview).toMatchObject({ players: 2, matches: 1 });
    expect(JSON.parse(migration.resources.find(({ kind }) => kind === "match")!.snapshotJson)).toEqual(snooker);
  });

  it("backs up team battles without creating cloud migration resources", async () => {
    let teamBattle = createTeamBattleMatch({ playerNames: ["团战甲", "团战乙"] }, 600);
    teamBattle = recordTeamBattleRound(teamBattle, {
      playerIds: [teamBattle.players[0].id, teamBattle.players[1].id],
      winnerId: teamBattle.players[0].id,
      winType: "normal",
      fouls: {},
      note: "",
      startedAt: 610,
    }, 620);
    const archive = { ...EMPTY_APP_DATA, activeTeamBattleMatch: teamBattle };
    const store = new VersionedLocalStore(new MemoryStorageAdapter({ [APP_STORAGE_KEY]: JSON.stringify(archive) }));

    const migration = await prepareLocalMigration(store, 1_000);

    expect(migration.backup.entries).toContainEqual({ key: APP_STORAGE_KEY, value: JSON.stringify(archive) });
    expect(migration.resources.some(({ localId }) => localId === teamBattle.id)).toBe(false);
    expect(migration.preview.matches).toBe(0);
  });
});

describe("local migration upload", () => {
  it("reports accepted, duplicate, network failure, and cancellation without losing retry state", async () => {
    const store = new VersionedLocalStore(new MemoryStorageAdapter({ [APP_STORAGE_KEY]: JSON.stringify(localArchive()) }));
    const migration = await prepareLocalMigration(store, 1_000);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "accepted", resourceId: "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "duplicate", resourceId: "bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb" }), { status: 200 }))
      .mockRejectedValueOnce(new TypeError("offline"));

    const sourceBefore = store.getRaw(APP_STORAGE_KEY);
    const result = await uploadLocalMigration(migration, { deviceId: "cccccccc-cccc-5ccc-8ccc-cccccccccccc", fetcher });
    expect(result.summary).toEqual({ accepted: 1, duplicate: 1, failed: 1, cancelled: 0 });
    expect(result.items.map((item) => item.status)).toEqual(["accepted", "duplicate", "failed"]);

    const controller = new AbortController();
    controller.abort();
    recordMigrationUpload(store, result, 9_000);
    expect(store.getRaw(APP_STORAGE_KEY)).toBe(sourceBefore);
    const links = JSON.parse(store.getRaw("billiards-cloud-links:v1") ?? "").links as Record<string, unknown>;
    expect(Object.keys(links).sort()).toEqual(result.items.slice(0, 2).map((item) => `${item.resource.kind}:${item.resource.localId}`).sort());

    const cancelled = await uploadLocalMigration(migration, { deviceId: "cccccccc-cccc-5ccc-8ccc-cccccccccccc", fetcher, signal: controller.signal });
    expect(cancelled.summary).toEqual({ accepted: 0, duplicate: 0, failed: 0, cancelled: 3 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
