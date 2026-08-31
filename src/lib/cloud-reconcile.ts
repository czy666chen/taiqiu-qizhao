import { isEightBallMatch, type EightBallMatch } from "./eight-ball";
import { isStoredMatch, type BilliardsMatch } from "./match";
import type { AppData } from "./local-storage";
import { isSnookerMatch, type SnookerMatch } from "./snooker";
import { isTeamBattleMatch, type TeamBattleMatch } from "./team-battle";

export type CloudMatchSnapshot = BilliardsMatch | EightBallMatch | SnookerMatch | TeamBattleMatch;

export function reconcileCloudMatches(
  data: AppData,
  snapshots: CloudMatchSnapshot[],
  deletedIds: Iterable<string> = [],
): AppData {
  const deleted = new Set(deletedIds);
  let next = data;
  for (const snapshot of snapshots) {
    // A locally deleted record must win over any (older) cloud snapshot so
    // sync can never resurrect it.
    if (deleted.has(snapshot.id)) continue;
    if (isTeamBattleMatch(snapshot)) {
      const localActive = next.activeTeamBattleMatch?.id === snapshot.id ? next.activeTeamBattleMatch : null;
      if (snapshot.status === "completed") {
        const existing = next.teamBattleHistory.find((item) => item.id === snapshot.id);
        if (!localActive && existing && JSON.stringify(existing) === JSON.stringify(snapshot)) continue;
        next = {
          ...next,
          activeTeamBattleMatch: localActive ? null : next.activeTeamBattleMatch,
          teamBattleHistory: [snapshot, ...next.teamBattleHistory.filter((item) => item.id !== snapshot.id)],
        };
      } else if (localActive && JSON.stringify(localActive) !== JSON.stringify(snapshot)) {
        next = { ...next, activeTeamBattleMatch: snapshot };
      }
      continue;
    }
    if (isSnookerMatch(snapshot)) {
      const localActive = next.activeSnookerMatch?.id === snapshot.id ? next.activeSnookerMatch : null;
      if (snapshot.status === "completed") {
        const existing = next.snookerHistory.find((item) => item.id === snapshot.id);
        if (!localActive && existing && JSON.stringify(existing) === JSON.stringify(snapshot)) continue;
        next = {
          ...next,
          activeSnookerMatch: localActive ? null : next.activeSnookerMatch,
          snookerHistory: [snapshot, ...next.snookerHistory.filter((item) => item.id !== snapshot.id)],
        };
      } else if (localActive && snapshot.matchVersion > localActive.matchVersion) {
        next = { ...next, activeSnookerMatch: snapshot };
      }
      continue;
    }
    if (isEightBallMatch(snapshot)) {
      const localActive = next.activeEightBallMatch?.id === snapshot.id ? next.activeEightBallMatch : null;
      if (snapshot.status === "completed") {
        const existing = next.eightBallHistory.find((item) => item.id === snapshot.id);
        if (!localActive && existing && JSON.stringify(existing) === JSON.stringify(snapshot)) continue;
        next = {
          ...next,
          activeEightBallMatch: localActive ? null : next.activeEightBallMatch,
          eightBallHistory: [snapshot, ...next.eightBallHistory.filter((item) => item.id !== snapshot.id)],
        };
      } else if (localActive && snapshot.matchVersion > localActive.matchVersion) {
        next = { ...next, activeEightBallMatch: snapshot };
      }
      continue;
    }
    if (!isStoredMatch(snapshot)) continue;
    const localActive = next.activeMatch?.id === snapshot.id;
    if (snapshot.status === "completed") {
      const existing = next.history.find((item) => item.id === snapshot.id);
      if (!localActive && existing && JSON.stringify(existing) === JSON.stringify(snapshot)) continue;
      next = {
        ...next,
        activeMatch: localActive ? null : next.activeMatch,
        history: [snapshot, ...next.history.filter((item) => item.id !== snapshot.id)],
      };
    }
  }
  return next;
}
