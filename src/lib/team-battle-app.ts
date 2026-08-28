import type { AppData } from "./local-storage";
import {
  createTeamBattleMatch,
  finishTeamBattleMatch,
  type TeamBattleDraft,
  type TeamBattleMatch,
} from "./team-battle";

export function hasActiveLocalMatch(data: AppData) {
  return !!(data.activeMatch || data.activeEightBallMatch || data.activeSnookerMatch || data.activeTeamBattleMatch);
}

export function startLocalTeamBattle(data: AppData, draft: TeamBattleDraft, now = Date.now()): AppData {
  if (hasActiveLocalMatch(data)) throw new Error("请先结束当前对局");
  return { ...data, activeTeamBattleMatch: createTeamBattleMatch(draft, now) };
}

export function updateLocalTeamBattle(data: AppData, match: TeamBattleMatch): AppData {
  if (!data.activeTeamBattleMatch || data.activeTeamBattleMatch.id !== match.id || match.status !== "active") {
    throw new Error("进行中的团战不匹配");
  }
  return { ...data, activeTeamBattleMatch: match };
}

export function completeLocalTeamBattle(data: AppData, now = Date.now()): AppData {
  if (!data.activeTeamBattleMatch) throw new Error("没有进行中的团战");
  const completed = finishTeamBattleMatch(data.activeTeamBattleMatch, now);
  return { ...data, activeTeamBattleMatch: null, teamBattleHistory: [completed, ...data.teamBattleHistory] };
}

export function restoreLocalTeamBattle(data: AppData, match: TeamBattleMatch): AppData {
  if (match.status === "completed") {
    return { ...data, teamBattleHistory: [match, ...data.teamBattleHistory.filter((item) => item.id !== match.id)] };
  }
  if (hasActiveLocalMatch(data) && data.activeTeamBattleMatch?.id !== match.id) throw new Error("请先结束当前对局");
  return { ...data, activeTeamBattleMatch: match };
}

export function deleteLocalTeamBattle(data: AppData, id: string): AppData {
  return {
    ...data,
    activeTeamBattleMatch: data.activeTeamBattleMatch?.id === id ? null : data.activeTeamBattleMatch,
    teamBattleHistory: data.teamBattleHistory.filter((match) => match.id !== id),
  };
}
