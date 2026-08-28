import { describe, expect, it } from "vitest";
import { EMPTY_APP_DATA } from "./local-storage";
import { createMatch, DEFAULT_RULES } from "./match";
import {
  completeLocalTeamBattle,
  deleteLocalTeamBattle,
  restoreLocalTeamBattle,
  startLocalTeamBattle,
  updateLocalTeamBattle,
} from "./team-battle-app";
import { recordTeamBattleRound } from "./team-battle";

describe("local team-battle lifecycle", () => {
  it("starts, updates, completes, restores, and deletes a local-only match", () => {
    const started = startLocalTeamBattle(EMPTY_APP_DATA, { playerNames: ["甲", "乙"] }, 100);
    const match = started.activeTeamBattleMatch!;
    const updatedMatch = recordTeamBattleRound(match, {
      playerIds: [match.players[0].id, match.players[1].id],
      winnerId: match.players[0].id,
      winType: "normal",
      fouls: {},
      note: "",
      startedAt: 110,
    }, 120);
    const updated = updateLocalTeamBattle(started, updatedMatch);
    const completed = completeLocalTeamBattle(updated, 130);

    expect(completed.activeTeamBattleMatch).toBeNull();
    expect(completed.teamBattleHistory[0]).toMatchObject({ id: match.id, status: "completed" });
    const restored = restoreLocalTeamBattle(EMPTY_APP_DATA, completed.teamBattleHistory[0]);
    expect(restored.teamBattleHistory).toHaveLength(1);
    expect(deleteLocalTeamBattle(restored, match.id).teamBattleHistory).toEqual([]);
  });

  it("includes team battles in the single-active-match guard", () => {
    const legacy = createMatch({
      mode: "score",
      playerNames: ["甲", "乙"],
      initialScore: 0,
      rules: DEFAULT_RULES,
      cardMode: "none",
      initialHandSize: 0,
    }, 100);
    expect(() => startLocalTeamBattle({ ...EMPTY_APP_DATA, activeMatch: legacy }, { playerNames: ["丙", "丁"] }, 200))
      .toThrow("请先结束当前对局");
    const teamBattle = startLocalTeamBattle(EMPTY_APP_DATA, { playerNames: ["甲", "乙"] }, 300);
    expect(() => restoreLocalTeamBattle(teamBattle, { ...teamBattle.activeTeamBattleMatch!, id: "another" }))
      .toThrow("请先结束当前对局");
  });
});
