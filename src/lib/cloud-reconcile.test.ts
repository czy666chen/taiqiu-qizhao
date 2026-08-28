import { describe, expect, it } from "vitest";
import { createEightBallMatch, finishEightBallMatch } from "./eight-ball";
import { EMPTY_APP_DATA } from "./local-storage";
import { reconcileCloudMatches } from "./cloud-reconcile";
import { createSnookerMatch, recordSnookerCommand } from "./snooker";

describe("cloud match reconciliation", () => {
  it("moves a stale active match to history when another device completed it", () => {
    const active = createEightBallMatch({ playerNames: ["红方", "蓝方"], raceTo: 3, firstServer: 0, serveRule: "alternate", layout: "split" }, 100);
    const completed = finishEightBallMatch(active, 500);
    const result = reconcileCloudMatches({ ...EMPTY_APP_DATA, activeEightBallMatch: active }, [completed]);
    expect(result.activeEightBallMatch).toBeNull();
    expect(result.eightBallHistory).toEqual([completed]);
    expect(reconcileCloudMatches(result, [completed])).toBe(result);
  });

  it("never resurrects a match the user deleted, even from a newer cloud snapshot", () => {
    const active = createEightBallMatch({ playerNames: ["红方", "蓝方"], raceTo: 3, firstServer: 0, serveRule: "alternate", layout: "split" }, 100);
    const completed = finishEightBallMatch(active, 500);
    const result = reconcileCloudMatches({ ...EMPTY_APP_DATA }, [completed], [completed.id]);
    expect(result.eightBallHistory).toEqual([]);
    expect(result.activeEightBallMatch).toBeNull();
  });

  it("updates an active snooker match and moves a completed cloud version to history", () => {
    const active = createSnookerMatch({ playerNames: ["甲", "乙"], bestOf: 3, firstStriker: 0 }, 100);
    const newer = recordSnookerCommand(active, { type: "snooker.pot.record", ball: "red" }, 200);
    const updated = reconcileCloudMatches({ ...EMPTY_APP_DATA, activeSnookerMatch: active }, [newer]);
    expect(updated.activeSnookerMatch).toEqual(newer);

    const completed = recordSnookerCommand(newer, { type: "snooker.finish" }, 300);
    const archived = reconcileCloudMatches(updated, [completed]);
    expect(archived.activeSnookerMatch).toBeNull();
    expect(archived.snookerHistory).toEqual([completed]);
  });
});
