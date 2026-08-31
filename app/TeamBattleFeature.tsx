"use client";

import { type MouseEvent, useEffect, useRef, useState } from "react";
import {
  addTeamBattlePlayer,
  correctTeamBattleRound,
  getPairProjection,
  getTeamBattleProjection,
  pauseTeamBattleMatch,
  recordTeamBattleRound,
  renameTeamBattlePlayer,
  resumeTeamBattleMatch,
  TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH,
  TEAM_BATTLE_MAX_PLAYERS,
  teamBattleElapsedMs,
  teamBattlePairKey,
  undoLastTeamBattleRound,
  type EffectiveTeamBattleRound,
  type TeamBattleDraft,
  type TeamBattleMatch,
  type TeamBattleReportDetail,
  type TeamBattleReportScope,
  type TeamBattleWinType,
} from "../src/lib/team-battle";
import { buildTeamBattleReport, buildTeamBattleReportProjection } from "../src/lib/team-battle-report";
import { renderReportPdf, renderReportPng } from "../src/lib/json-report";
import { currentReportTheme } from "../src/lib/report-theme";
import { HeadToHeadScoreboard } from "./HeadToHeadScoreboard";
import { useModalDialog } from "./useModalDialog";

function preferredScrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function handleHistoryBack(event: MouseEvent<HTMLAnchorElement>, onBack: () => void): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onBack();
}

const WIN_LABELS: Record<TeamBattleWinType, string> = { normal: "普胜", break_clear: "炸清", runout: "接清" };

function durationLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分 ${seconds % 60} 秒`;
}

function draftError(names: string[]) {
  const normalized = names.map((name) => name.trim());
  if (normalized.some((name) => !name || Array.from(name).length > TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH)) return `成员姓名必须为 1–${TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH} 个字符`;
  if (new Set(normalized).size !== normalized.length) return "同场成员姓名不能重复";
  return "";
}

export function TeamBattleSetupDialog({
  onClose,
  onStart,
  user,
  onCloudRoomCreated,
}: {
  onClose: () => void;
  onStart: (draft: TeamBattleDraft) => void;
  user: { id: string } | null;
  onCloudRoomCreated: (code: string, matchId: string, operationId: string) => void;
}) {
  const dialogRef = useModalDialog(onClose);
  const errorRef = useRef<HTMLDivElement>(null);
  const [names, setNames] = useState(["成员 1", "成员 2"]);
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState<Record<number, boolean>>({});
  const [error, setError] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= names.length) return;
    const next = [...names];
    [next[index], next[target]] = [next[target], next[index]];
    setNames(next);
  };
  const validDraft = () => {
    const message = draftError(names);
    if (message) {
      setTouched(Object.fromEntries(names.map((_, index) => [index, true])));
      setError(message);
      window.requestAnimationFrame(() => errorRef.current?.focus());
      return null;
    }
    return { playerNames: names.map((name) => name.trim()), title, location, note };
  };
  const submitLocal = () => {
    const draft = validDraft();
    if (!draft) return;
    try { onStart(draft); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建团战"); window.requestAnimationFrame(() => errorRef.current?.focus()); }
  };
  const submitCloud = async () => {
    const draft = validDraft();
    if (!draft || !user || cloudBusy) return;
    setCloudBusy(true);
    setError("");
    try {
      const operationId = crypto.randomUUID();
      const response = await fetch("/api/realtime/rooms/direct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId,
          mode: "team_battle",
          players: draft.playerNames.map((name) => ({ name })),
          title: draft.title,
          location: draft.location,
          note: draft.note,
        }),
      });
      const payload = await response.json() as { matchId?: string; room?: { code: string }; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      if (!payload.matchId || !payload.room?.code) throw new Error("云端房间响应不完整，请重试");
      onCloudRoomCreated(payload.room.code, payload.matchId, operationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建云端实时房间失败");
      window.requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setCloudBusy(false);
    }
  };
  return <dialog ref={dialogRef} className="setup-modal team-battle-setup" aria-labelledby="team-battle-setup-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="modal-heading"><div><p className="kicker">TEAM BATTLE · NEW MATCH</p><h2 id="team-battle-setup-title">创建团战记分</h2></div><button className="icon-button" aria-label="关闭团战设置" onClick={onClose}>×</button></header>
    <div className="setup-body">
      {error && <div ref={errorRef} className="team-form-error" role="alert" tabIndex={-1}>{error}</div>}
      <section className="setup-section"><div className="setup-title"><span>01</span><div><b>在场成员</b><small>2–8 人；实时房间开局后固定席位，本机团战可继续加人</small></div></div>
        <div className="team-setup-players">{names.map((name, index) => {
          const normalized = name.trim();
          const fieldError = touched[index] ? (!normalized || Array.from(normalized).length > TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH ? `成员姓名必须为 1–${TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH} 个字符` : names.filter((item) => item.trim() === normalized).length > 1 ? "同场成员姓名不能重复" : "") : "";
          const errorId = `team-player-${index}-error`;
          return <div key={index} className="team-setup-player">
            <label htmlFor={`team-player-${index}`}>成员 {index + 1}</label>
            <input id={`team-player-${index}`} name={`team-player-${index}-name`} autoComplete="off" maxLength={TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH} value={name} aria-describedby={fieldError ? errorId : undefined} onBlur={() => setTouched({ ...touched, [index]: true })} onChange={(event) => setNames(names.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} />
            <div className="team-row-actions"><button type="button" aria-label={`成员 ${index + 1} 上移`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button><button type="button" aria-label={`成员 ${index + 1} 下移`} disabled={index === names.length - 1} onClick={() => move(index, 1)}>↓</button><button type="button" disabled={names.length <= 2} onClick={() => setNames(names.filter((_, itemIndex) => itemIndex !== index))}>删除</button></div>
            {fieldError && <small id={errorId} className="field-error">{fieldError}</small>}
          </div>;
        })}</div>
        <button type="button" className="add-player" disabled={names.length >= TEAM_BATTLE_MAX_PLAYERS} onClick={() => setNames([...names, `成员 ${names.length + 1}`])}>＋ 添加成员（{names.length}/8）</button>
      </section>
      <section className="setup-section"><div className="setup-title"><span>02</span><div><b>比赛信息</b><small>均为可选项</small></div></div><div className="eight-form-grid"><label className="wide"><span>比赛标题</span><input name="team-battle-title" autoComplete="off" maxLength={40} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label><span>地点</span><input name="team-battle-location" autoComplete="off" maxLength={40} value={location} onChange={(event) => setLocation(event.target.value)} /></label><label className="wide"><span>备注</span><input name="team-battle-note" autoComplete="off" maxLength={120} value={note} onChange={(event) => setNote(event.target.value)} /></label></div></section>
    </div>
    <footer className="modal-actions"><button className="secondary" disabled={cloudBusy} onClick={onClose}>取消</button>{user && <button className="secondary" disabled={cloudBusy} onClick={submitLocal}>开始本机团战</button>}<button className="primary" disabled={cloudBusy} onClick={() => user ? void submitCloud() : submitLocal()}>{cloudBusy ? "正在创建实时房间…" : user ? "创建实时房间" : "开始本机团战"}</button></footer>
  </dialog>;
}

function pairStats(rounds: EffectiveTeamBattleRound[], playerId: string) {
  return {
    normal: rounds.filter((round) => round.winnerId === playerId && round.winType === "normal").length,
    breakClear: rounds.filter((round) => round.winnerId === playerId && round.winType === "break_clear").length,
    runout: rounds.filter((round) => round.winnerId === playerId && round.winType === "runout").length,
    fouls: rounds.reduce((sum, round) => sum + (round.fouls[playerId] ?? 0), 0),
  };
}

export type RealtimeTeamBattleState = {
  mode: "team_battle";
  match: TeamBattleMatch;
  seats: Array<{ playerId: string; userId?: string }>;
  currentPairIds: [string, string];
};

type RealtimeTeamBattleCommandPayload = Record<string, string | number | boolean | Array<string | number> | Record<string, unknown> | undefined>;

export function RealtimeTeamBattlePanel({
  state,
  writable,
  busy,
  isHost,
  onCommand,
}: {
  state: RealtimeTeamBattleState;
  writable: boolean;
  busy: boolean;
  isHost: boolean;
  onCommand: (kind: string, payload: RealtimeTeamBattleCommandPayload) => void;
}) {
  const { match, currentPairIds: pair } = state;
  const projection = getTeamBattleProjection(match);
  const currentPair = getPairProjection(match, pair[0], pair[1]);
  const leftStats = pairStats(currentPair.rounds, pair[0]);
  const rightStats = pairStats(currentPair.rounds, pair[1]);
  const [winnerId, setWinnerId] = useState(pair[0]);
  const [winType, setWinType] = useState<TeamBattleWinType>("normal");
  const [fouls, setFouls] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [roundStartedAt, setRoundStartedAt] = useState(() => Date.now());
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const disabled = busy || !writable;
  const roundDisabled = disabled || !!match.pausedAt;
  const playerName = (id: string) => match.players.find((player) => player.id === id)?.name ?? id;
  const resetDraft = () => {
    setWinnerId(pair[0]);
    setWinType("normal");
    setFouls({});
    setNote("");
    setRoundStartedAt(Date.now());
    setEditingEventId(null);
  };
  const changePair = (side: 0 | 1, playerId: string) => {
    if (playerId === pair[side === 0 ? 1 : 0]) return;
    onCommand("team_battle.pair.set", { playerIds: side === 0 ? [playerId, pair[1]] : [pair[0], playerId] });
  };
  const submitRound = () => onCommand(editingEventId ? "team_battle.round.correct" : "team_battle.round.record", {
    ...(editingEventId ? { eventId: editingEventId } : {}),
    winnerId,
    winType,
    fouls: Object.fromEntries(pair.map((id) => [id, Math.max(0, Math.min(99, Math.trunc(fouls[id] ?? 0)))])),
    note,
    startedAt: roundStartedAt,
  });
  const editRound = (round: EffectiveTeamBattleRound) => {
    setWinnerId(round.winnerId);
    setWinType(round.winType);
    setFouls({ ...round.fouls });
    setNote(round.note);
    setRoundStartedAt(round.startedAt);
    setEditingEventId(round.eventId);
    document.querySelector(".realtime-team-battle .team-round-panel")?.scrollIntoView({ behavior: preferredScrollBehavior() });
  };
  const ledgerRow = (round: EffectiveTeamBattleRound, editable = false) => <article key={round.eventId}><span>第 {round.sequenceNo} 局</span><div><b>{playerName(round.playerIds[0])} vs {playerName(round.playerIds[1])}</b><small>{playerName(round.winnerId)} · {WIN_LABELS[round.winType]} · 犯规 {round.playerIds.map((id) => `${playerName(id)} ${round.fouls[id] ?? 0}`).join(" / ")}{round.note ? ` · ${round.note}` : ""}</small></div><strong>{round.after[round.playerIds[0]] ?? 0} : {round.after[round.playerIds[1]] ?? 0}</strong>{editable && isHost && <button disabled={disabled} onClick={() => editRound(round)}>更正</button>}</article>;
  const statusMessage = !isHost
    ? "当前为只读模式，由房主负责团战计分。"
    : !writable
      ? "实时连接尚未同步，所有团战写操作已暂时禁用。"
      : match.pausedAt
        ? "团战已暂停，可以切换对阵和查看流水；恢复后才能记分。"
        : "已连接服务器，可以记录团战结果。";

  return <section className="realtime-team-battle team-battle-page" aria-label="实时团战计分">
    <div className="realtime-team-toolbar"><div className={`realtime-team-status ${writable ? "ready" : "readonly"}`} role="status" aria-live="polite" aria-atomic="true">{statusMessage}</div>{isHost && match.status !== "completed" && <button className="secondary" disabled={disabled} onClick={() => onCommand(match.pausedAt ? "team_battle.resume" : "team_battle.pause", {})}>{match.pausedAt ? "恢复团战" : "暂停团战"}</button>}</div>
    <section className="team-pair-picker" aria-labelledby="realtime-team-pair-title"><div><p className="kicker">CURRENT MATCHUP · SERVER AUTHORITY</p><h2 id="realtime-team-pair-title">当前共享对阵</h2><small>切换后所有窗口同步显示同一组对阵</small></div><label><span>红方成员</span><select name="realtime-team-battle-red-player" autoComplete="off" aria-label="红方成员" disabled={disabled} value={pair[0]} onChange={(event) => changePair(0, event.target.value)}>{match.players.map((player) => <option key={player.id} value={player.id} disabled={player.id === pair[1]}>{player.name}</option>)}</select></label><b aria-hidden="true">VS</b><label><span>蓝方成员</span><select name="realtime-team-battle-blue-player" autoComplete="off" aria-label="蓝方成员" disabled={disabled} value={pair[1]} onChange={(event) => changePair(1, event.target.value)}>{match.players.map((player) => <option key={player.id} value={player.id} disabled={player.id === pair[0]}>{player.name}</option>)}</select></label><span>{currentPair.rounds.length ? `已交手 ${currentPair.rounds.length} 局` : "首次交手 · 0 : 0"}</span></section>
    <HeadToHeadScoreboard sides={[
      { id: pair[0], name: playerName(pair[0]), label: "RED", score: currentPair.scores[pair[0]], stats: [{ label: "普胜", value: leftStats.normal }, { label: "炸清", value: leftStats.breakClear }, { label: "接清", value: leftStats.runout }, { label: "犯规", value: leftStats.fouls }] },
      { id: pair[1], name: playerName(pair[1]), label: "BLUE", score: currentPair.scores[pair[1]], stats: [{ label: "普胜", value: rightStats.normal }, { label: "炸清", value: rightStats.breakClear }, { label: "接清", value: rightStats.runout }, { label: "犯规", value: rightStats.fouls }] },
    ]} />
    <section className="team-standing-table" aria-labelledby="realtime-team-standing-title"><div className="section-heading"><div><p className="kicker">STANDINGS</p><h2 id="realtime-team-standing-title">总排行</h2></div><span>{projection.rounds.length} 局</span></div>{projection.standings.map((standing) => <article key={standing.player.id}><span>{standing.tied ? "并列 " : ""}{standing.rank}</span><b>{standing.player.name}</b><small>交手 {standing.opponentsPlayed} 人</small><strong>{standing.wins} 胜 {standing.losses} 负</strong><i>{standing.differential >= 0 ? "+" : ""}{standing.differential}</i></article>)}</section>
    <section className="eight-round-panel team-round-panel" aria-labelledby="realtime-team-round-title"><div className="section-heading"><div><p className="kicker">{editingEventId ? "CORRECTION" : `ROUND ${projection.rounds.length + 1}`}</p><h2 id="realtime-team-round-title">{editingEventId ? "更正本局结果" : "记录本局结果"}</h2></div><button className="text-button" disabled={roundDisabled || !currentPair.rounds.length} onClick={() => onCommand("team_battle.round.undo", {})}>↶ 撤销当前组合上一局</button></div>
      <div className="eight-winner-picker">{pair.map((id) => <button key={id} disabled={roundDisabled} className={winnerId === id ? "active" : ""} aria-pressed={winnerId === id} onClick={() => setWinnerId(id)}>{playerName(id)} 获胜</button>)}</div>
      <div className="segmented">{Object.entries(WIN_LABELS).map(([id, label]) => <button key={id} disabled={roundDisabled} className={winType === id ? "active" : ""} aria-pressed={winType === id} onClick={() => setWinType(id as TeamBattleWinType)}>{label}</button>)}</div>
      <div className="eight-fouls">{pair.map((id) => <label key={id}><span>{playerName(id)} 本局犯规</span><input name={`realtime-team-battle-${id}-fouls`} autoComplete="off" type="number" min="0" max="99" inputMode="numeric" disabled={roundDisabled} value={fouls[id] ?? 0} onChange={(event) => setFouls({ ...fouls, [id]: Number(event.target.value) })} /></label>)}</div>
      <label className="score-note"><span>本局备注</span><input name="realtime-team-battle-round-note" autoComplete="off" maxLength={120} disabled={roundDisabled} placeholder="例如：关键球处理…" value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <div className="team-confirm-row">{editingEventId && <button className="secondary" disabled={roundDisabled} onClick={resetDraft}>取消更正</button>}<button className="primary eight-confirm" disabled={roundDisabled} onClick={submitRound}>{editingEventId ? "保存更正" : "确认本局"}</button></div>
    </section>
    <section className="eight-ledger team-pair-ledger"><div className="section-heading"><div><p className="kicker">PAIR LEDGER</p><h2>当前组合流水</h2></div><span>{currentPair.rounds.length} 局</span></div>{currentPair.rounds.length ? [...currentPair.rounds].reverse().map((round) => ledgerRow(round, true)) : <p className="team-empty-ledger">这组成员尚未交手，确认首局后会显示在这里。</p>}</section>
    <details className="team-all-ledger"><summary>全场最近流水 <span>{projection.rounds.length} 局</span></summary><div className="eight-ledger">{projection.rounds.length ? [...projection.rounds].reverse().slice(0, 20).map((round) => ledgerRow(round)) : <p className="team-empty-ledger">本场尚无已确认的对局。</p>}</div></details>
  </section>;
}

export function TeamBattleBoard({ match, onChange, onFinish, toast }: { match: TeamBattleMatch; onChange: (match: TeamBattleMatch) => void; onFinish: () => void; toast: (message: string) => void }) {
  const [, tick] = useState(0);
  const [pair, setPair] = useState<[string, string]>(() => [match.players[0].id, match.players[1].id]);
  const [winnerId, setWinnerId] = useState(pair[0]);
  const [winType, setWinType] = useState<TeamBattleWinType>("normal");
  const [fouls, setFouls] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [roundStartedAt, setRoundStartedAt] = useState(() => Date.now());
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [editingConfirmedAt, setEditingConfirmedAt] = useState<number | null>(null);
  const [memberPanelOpen, setMemberPanelOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>(() => Object.fromEntries(match.players.map((player) => [player.id, player.name])));
  const [ledgerFilter, setLedgerFilter] = useState("all");
  const [error, setError] = useState("");
  useEffect(() => { const timer = window.setInterval(() => tick((value) => value + 1), 1000); return () => window.clearInterval(timer); }, []);

  const projection = getTeamBattleProjection(match);
  const currentPair = getPairProjection(match, pair[0], pair[1]);
  const leftStats = pairStats(currentPair.rounds, pair[0]);
  const rightStats = pairStats(currentPair.rounds, pair[1]);
  const draftDirty = !!editingEventId || winnerId !== pair[0] || winType !== "normal" || !!note.trim() || Object.values(fouls).some((count) => count > 0);
  const resetDraft = (nextPair = pair) => { setWinnerId(nextPair[0]); setWinType("normal"); setFouls({}); setNote(""); setRoundStartedAt(Date.now()); setEditingEventId(null); setEditingConfirmedAt(null); };
  const changePair = (side: 0 | 1, playerId: string) => {
    if (playerId === pair[side === 0 ? 1 : 0]) return;
    if (draftDirty && !window.confirm("切换成员会放弃尚未确认的本局草稿，是否继续？")) return;
    const next: [string, string] = side === 0 ? [playerId, pair[1]] : [pair[0], playerId];
    setPair(next); resetDraft(next); setError("");
  };
  const update = (action: () => TeamBattleMatch, message: string) => {
    try { onChange(action()); setError(""); toast(message); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); return false; }
  };
  const confirm = () => {
    const confirmedAt = editingConfirmedAt ?? Date.now();
    const round = { playerIds: pair, winnerId, winType, fouls: Object.fromEntries(pair.map((id) => [id, Math.max(0, Math.trunc(fouls[id] ?? 0))])), note, startedAt: roundStartedAt, confirmedAt };
    const saved = update(
      () => editingEventId ? correctTeamBattleRound(match, editingEventId, round) : recordTeamBattleRound(match, { playerIds: pair, winnerId, winType, fouls: round.fouls, note, startedAt: roundStartedAt }),
      editingEventId ? "已追加更正事件并重新计算全部比分" : "本局已记录并保存到本机",
    );
    if (saved) resetDraft();
  };
  const editRound = (round: EffectiveTeamBattleRound) => {
    if (draftDirty && editingEventId !== round.eventId && !window.confirm("更正历史局会放弃尚未确认的本局草稿，是否继续？")) return;
    const nextPair: [string, string] = [...round.playerIds];
    setPair(nextPair); setWinnerId(round.winnerId); setWinType(round.winType); setFouls({ ...round.fouls }); setNote(round.note); setRoundStartedAt(round.startedAt); setEditingEventId(round.eventId); setEditingConfirmedAt(round.confirmedAt); setError("");
    document.querySelector(".team-round-panel")?.scrollIntoView({ behavior: preferredScrollBehavior() });
  };
  const addMember = () => update(() => { const next = addTeamBattlePlayer(match, addName); setAddName(""); return next; }, "新成员已加入，原有两两比分保持不变");
  const renameMember = (playerId: string) => update(() => renameTeamBattlePlayer(match, playerId, renameDrafts[playerId] ?? ""), "成员姓名已更新，历史流水 ID 保持不变");
  const filterRounds = projection.rounds.filter((round) => ledgerFilter === "all"
    || (ledgerFilter.startsWith("player:") && round.playerIds.includes(ledgerFilter.slice(7)))
    || (ledgerFilter.startsWith("pair:") && teamBattlePairKey(...round.playerIds) === ledgerFilter.slice(5)));
  const playerName = (id: string) => match.players.find((player) => player.id === id)?.name ?? id;
  const ledgerRow = (round: EffectiveTeamBattleRound) => <article key={round.eventId}><span>第 {round.sequenceNo} 局</span><div><b>{playerName(round.playerIds[0])} vs {playerName(round.playerIds[1])}</b><small>{playerName(round.winnerId)} · {WIN_LABELS[round.winType]} · 犯规 {round.playerIds.map((id) => `${playerName(id)} ${round.fouls[id] ?? 0}`).join(" / ")}{round.note ? ` · ${round.note}` : ""}</small></div><strong>{round.after[round.playerIds[0]] ?? 0} : {round.after[round.playerIds[1]] ?? 0}</strong><button onClick={() => editRound(round)}>更正</button></article>;

  return <div className="eight-page team-battle-page page-shell">
    <section className="eight-topbar"><div><span className="live-label"><i /> 本机团战进行中</span><h1>{match.title || "团战记分"}</h1><p>{match.players.length} 人在场 · {projection.rounds.length} 局 · {durationLabel(teamBattleElapsedMs(match))}{match.location ? ` · ${match.location}` : ""}</p></div><div><button aria-expanded={memberPanelOpen} onClick={() => setMemberPanelOpen(!memberPanelOpen)}>成员管理</button><button onClick={() => update(() => match.pausedAt ? resumeTeamBattleMatch(match) : pauseTeamBattleMatch(match), match.pausedAt ? "团战已继续" : "团战已暂停")}>{match.pausedAt ? "继续计时" : "暂停计时"}</button><button className="danger-text" onClick={onFinish}>结束团战</button></div></section>
    {match.pausedAt && <div className="eight-paused" role="status">团战已暂停：可以查看和切换组合，但不能确认新局。</div>}
    {error && <p className="team-form-error" role="alert">{error}</p>}
    {memberPanelOpen && <section className="team-member-panel" aria-label="团战成员管理"><div className="section-heading"><div><p className="kicker">MEMBERS</p><h2>在场成员</h2></div><span>{match.players.length}/8</span></div><div className="team-member-list">{match.players.map((player, index) => <div key={player.id}><span>{index + 1}</span><label><span className="sr-only">修改{player.name}的姓名</span><input name={`team-member-${player.id}-name`} autoComplete="off" maxLength={TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH} value={renameDrafts[player.id] ?? player.name} onChange={(event) => setRenameDrafts({ ...renameDrafts, [player.id]: event.target.value })} /></label><button disabled={(renameDrafts[player.id] ?? "").trim() === player.name} onClick={() => renameMember(player.id)}>保存姓名</button></div>)}</div><div className="team-add-member"><label htmlFor="team-add-member">加入新成员</label><input id="team-add-member" name="team-add-member-name" autoComplete="off" maxLength={TEAM_BATTLE_MAX_PLAYER_NAME_LENGTH} value={addName} onChange={(event) => setAddName(event.target.value)} /><button disabled={!addName.trim() || match.players.length >= TEAM_BATTLE_MAX_PLAYERS} onClick={addMember}>加入成员</button></div>{match.players.length >= TEAM_BATTLE_MAX_PLAYERS && <small>已达到 8 人上限。</small>}</section>}
    <section className="team-pair-picker" aria-labelledby="team-pair-title"><div><p className="kicker">CURRENT MATCHUP</p><h2 id="team-pair-title">选择当前对阵</h2><small>切换后自动恢复本场两人的历史比分</small></div><label><span>红方成员</span><select name="team-battle-red-player" autoComplete="off" aria-label="红方成员" value={pair[0]} onChange={(event) => changePair(0, event.target.value)}>{match.players.map((player) => <option key={player.id} value={player.id} disabled={player.id === pair[1]}>{player.name}</option>)}</select></label><b aria-hidden="true">VS</b><label><span>蓝方成员</span><select name="team-battle-blue-player" autoComplete="off" aria-label="蓝方成员" value={pair[1]} onChange={(event) => changePair(1, event.target.value)}>{match.players.map((player) => <option key={player.id} value={player.id} disabled={player.id === pair[0]}>{player.name}</option>)}</select></label><span>{currentPair.rounds.length ? `已交手 ${currentPair.rounds.length} 局` : "首次交手 · 0 : 0"}</span></section>
    <HeadToHeadScoreboard sides={[
      { id: pair[0], name: playerName(pair[0]), label: "RED", score: currentPair.scores[pair[0]], stats: [{ label: "普胜", value: leftStats.normal }, { label: "炸清", value: leftStats.breakClear }, { label: "接清", value: leftStats.runout }, { label: "犯规", value: leftStats.fouls }] },
      { id: pair[1], name: playerName(pair[1]), label: "BLUE", score: currentPair.scores[pair[1]], stats: [{ label: "普胜", value: rightStats.normal }, { label: "炸清", value: rightStats.breakClear }, { label: "接清", value: rightStats.runout }, { label: "犯规", value: rightStats.fouls }] },
    ]} />
    <section className="eight-round-panel team-round-panel"><div className="section-heading"><div><p className="kicker">{editingEventId ? "CORRECTION" : `ROUND ${projection.rounds.length + 1}`}</p><h2>{editingEventId ? "更正本局结果" : "记录本局结果"}</h2></div><button className="text-button" disabled={!currentPair.rounds.length} onClick={() => update(() => undoLastTeamBattleRound(match, pair), "已撤销当前组合的上一局")}>↶ 撤销当前组合上一局</button></div>
      <div className="eight-winner-picker">{pair.map((id) => <button key={id} className={winnerId === id ? "active" : ""} aria-pressed={winnerId === id} onClick={() => setWinnerId(id)}>{playerName(id)} 获胜</button>)}</div>
      <div className="segmented">{Object.entries(WIN_LABELS).map(([id, label]) => <button key={id} className={winType === id ? "active" : ""} aria-pressed={winType === id} onClick={() => setWinType(id as TeamBattleWinType)}>{label}</button>)}</div>
      <div className="eight-fouls">{pair.map((id) => <label key={id}><span>{playerName(id)} 本局犯规</span><input name={`team-battle-${id}-fouls`} autoComplete="off" type="number" min="0" inputMode="numeric" value={fouls[id] ?? 0} onChange={(event) => setFouls({ ...fouls, [id]: Number(event.target.value) })} /></label>)}</div>
      <label className="score-note"><span>本局备注</span><input name="team-battle-round-note" autoComplete="off" maxLength={120} placeholder="例如：关键球处理…" value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <div className="team-confirm-row">{editingEventId && <button className="secondary" onClick={() => resetDraft()}>取消更正</button>}<button className="primary eight-confirm" disabled={!!match.pausedAt} onClick={confirm}>{editingEventId ? "保存更正" : "确认本局并进入下一局"}</button></div>
    </section>
    <section className="eight-ledger team-pair-ledger"><div className="section-heading"><div><p className="kicker">PAIR LEDGER</p><h2>当前组合流水</h2></div><span>{currentPair.rounds.length} 局</span></div>{currentPair.rounds.length ? [...currentPair.rounds].reverse().map(ledgerRow) : <p className="team-empty-ledger">这组成员尚未交手，确认首局后会显示在这里。</p>}</section>
    <details className="team-all-ledger"><summary>全场最近流水 <span>{projection.rounds.length} 局</span></summary><label><span>筛选流水</span><select value={ledgerFilter} onChange={(event) => setLedgerFilter(event.target.value)}><option value="all">全部成员与组合</option><optgroup label="按成员">{match.players.map((player) => <option key={player.id} value={`player:${player.id}`}>{player.name}</option>)}</optgroup><optgroup label="按组合">{projection.pairs.map((item) => <option key={item.pairKey} value={`pair:${item.pairKey}`}>{item.players[0].name} / {item.players[1].name}</option>)}</optgroup></select></label><div className="eight-ledger">{[...filterRounds].reverse().slice(0, 20).map(ledgerRow)}</div></details>
  </div>;
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function reportDate(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

export function TeamBattleHistoryDetail({ match, onBack, onDelete }: { match: TeamBattleMatch; onBack: () => void; onDelete: (id: string) => void }) {
  const projection = getTeamBattleProjection(match);
  const [scope, setScope] = useState<TeamBattleReportScope>({ kind: "all" });
  const [detail, setDetail] = useState<Extract<TeamBattleReportDetail, "auto" | "summary">>("auto");
  const [exporting, setExporting] = useState<"" | "png" | "pdf">("");
  const [exportError, setExportError] = useState("");
  const report = buildTeamBattleReportProjection(match, { scope, detail });
  const selectedPlayer = scope.kind === "player" ? match.players.find(({ id }) => id === scope.playerId) : undefined;
  const baseName = `团战战绩${selectedPlayer ? `-${selectedPlayer.name}` : ""}-${reportDate(match.startedAt)}`;
  const exportFile = async (format: "png" | "pdf") => {
    setExporting(format);
    setExportError("");
    try {
      const theme = currentReportTheme();
      const svg = buildTeamBattleReport(match, { scope, detail }, theme);
      downloadBlob(`${baseName}.${format}`, format === "png" ? await renderReportPng(svg) : await renderReportPdf(svg, theme));
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "报告生成失败");
    } finally {
      setExporting("");
    }
  };
  const exportJson = () => downloadBlob(`${baseName}.json`, new Blob([JSON.stringify({
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    match,
    effectiveRounds: projection.rounds,
    projection,
  }, null, 2)], { type: "application/json" }));
  const playerName = (id: string) => match.players.find((player) => player.id === id)?.name ?? id;

  return <div className="content-page page-shell team-battle-history">
    {/* The standalone Vite SPA cannot bundle next/link; this handler keeps navigation client-side. */}
    {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
    <a className="back-link" href="/history" onClick={(event) => handleHistoryBack(event, onBack)}>← 返回战绩</a>
    <header className="page-title split"><div><p className="kicker">TEAM BATTLE · MATCH REPORT</p><h1>{match.title || "团战结算"}</h1><p>{new Date(match.startedAt).toLocaleString("zh-CN")} · {durationLabel(teamBattleElapsedMs(match, match.endedAt))}{match.location ? ` · ${match.location}` : ""}</p></div>
      <div className="report-actions team-report-actions"><div className="team-report-options" aria-label="报告设置"><label><span>报告范围</span><select value={scope.kind === "all" ? "all" : scope.playerId} onChange={(event) => setScope(event.target.value === "all" ? { kind: "all" } : { kind: "player", playerId: event.target.value })}><option value="all">整场团战</option>{match.players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label><label><span>报告内容</span><select value={detail} onChange={(event) => setDetail(event.target.value as "auto" | "summary")}><option value="auto">自动详情</option><option value="summary">仅摘要</option></select></label></div><div className="export-actions"><button disabled={!!exporting} onClick={() => void exportFile("png")}>{exporting === "png" ? "生成中…" : "下载 PNG 长图"}</button><button disabled={!!exporting} onClick={() => void exportFile("pdf")}>{exporting === "pdf" ? "生成中…" : "下载 PDF"}</button></div><div className="export-actions minor"><button disabled={!!exporting} onClick={exportJson}>JSON 备份</button><button className="danger-text" onClick={() => onDelete(match.id)}>删除战绩</button></div></div>
    </header>
    {exportError && <p className="team-form-error" role="alert">{exportError}</p>}
    <section className="event-stats"><div><strong>{match.players.length}</strong><span>成员</span></div><div><strong>{projection.rounds.length}</strong><span>总局数</span></div><div><strong>{projection.pairs.length}</strong><span>实际交手组合</span></div><div><strong>{durationLabel(teamBattleElapsedMs(match, match.endedAt))}</strong><span>比赛用时</span></div></section>
    <section className="team-report-preview" aria-live="polite"><b>报告预览：{selectedPlayer ? `${selectedPlayer.name} 专项` : "整场团战"}</b><span>{report.resolvedDetail === "full" ? `包含 ${report.player?.rounds.length ?? report.match.rounds.length} 局逐局变化` : report.omissionReason}</span></section>
    <section className="team-standing-table"><div className="section-heading"><div><p className="kicker">STANDINGS</p><h2>总排行</h2></div></div>{projection.standings.map((standing) => <article key={standing.player.id}><span>{standing.tied ? "并列 " : ""}{standing.rank}</span><b>{standing.player.name}</b><small>交手 {standing.opponentsPlayed} 人</small><strong>{standing.wins} 胜 {standing.losses} 负</strong><i>{standing.differential >= 0 ? "+" : ""}{standing.differential}</i></article>)}</section>
    <section className="team-pair-results"><div className="section-heading"><div><p className="kicker">HEAD TO HEAD</p><h2>两两比分</h2></div><span>{projection.pairs.length} 组</span></div>{projection.pairs.length ? projection.pairs.map((pair) => <article key={pair.pairKey}><b>{pair.players[0].name}</b><strong>{pair.scores[pair.players[0].id]} : {pair.scores[pair.players[1].id]}</strong><b>{pair.players[1].name}</b><small>{pair.rounds.length} 局</small></article>) : <p className="team-empty-ledger">本场没有已确认的对局。</p>}</section>
    <section className="eight-ledger history"><div className="section-heading"><div><p className="kicker">FULL ROUND LOG</p><h2>逐局流水</h2></div><span>{projection.rounds.length} 局 · 原始事件 {match.events.length} 条</span></div>{projection.rounds.map((round, index) => <article key={round.eventId}><span>第 {index + 1} 局</span><div><b>{playerName(round.playerIds[0])} vs {playerName(round.playerIds[1])}</b><small>{playerName(round.winnerId)} · {WIN_LABELS[round.winType]} · 犯规 {round.playerIds.map((id) => `${playerName(id)} ${round.fouls[id] ?? 0}`).join(" / ")}{round.note ? ` · ${round.note}` : ""}</small></div><strong>{round.after[round.playerIds[0]] ?? 0} : {round.after[round.playerIds[1]] ?? 0}</strong></article>)}</section>
    <details className="raw-events"><summary>查看追加式原始事件与更正记录（{match.events.length}）</summary>{match.events.map((event) => <pre key={event.id}>{JSON.stringify(event, null, 2)}</pre>)}</details>
  </div>;
}
