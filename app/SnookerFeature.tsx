"use client";

import { type ReactNode, useEffect, useState } from "react";
import {
  getSnookerBreakStats,
  getSnookerBreakBallCounts,
  recordSnookerCardAction,
  recordSnookerCommand,
  SNOOKER_BALL_VALUES,
  SNOOKER_MAX_REDS,
  SNOOKER_MIN_REDS,
  SNOOKER_OFFICIAL_FOUL_POINTS,
  shouldShowSnookerBreakPrompt,
  undoLastSnookerEvent,
  type SnookerBall,
  type SnookerBreak,
  type SnookerCommand,
  type SnookerDraft,
  type SnookerMatch,
} from "../src/lib/snooker";
import { filterDeckSnapshotForGame, officialDeckSnapshot, type DeckSnapshot } from "../src/lib/custom-decks";
import { useModalDialog } from "./useModalDialog";

const BALLS = Object.keys(SNOOKER_BALL_VALUES) as SnookerBall[];
const BALL_LABELS: Record<SnookerBall, string> = {
  red: "红", yellow: "黄", green: "绿", brown: "棕", blue: "蓝", pink: "粉", black: "黑",
};
const PHASE_LABELS = {
  reds: "红球",
  colour_after_red: "任意彩球",
  colours_clearance: "顺序清彩",
  final_black: "最后黑球",
  respotted_black: "重置黑球",
  completed: "本局已结束",
} as const;

export function SnookerBreakBallCounts({ snookerBreak }: { snookerBreak: Pick<SnookerBreak, "pots"> }) {
  const counts = getSnookerBreakBallCounts(snookerBreak);
  return <ul className="snooker-break-balls" aria-label="本杆各色球进球数">
    {BALLS.map((ball) => <li key={ball} className={`snooker-break-ball ${ball}`} aria-label={`${BALL_LABELS[ball]}球打进 ${counts[ball]} 个`}><b>{counts[ball]}</b><small>{BALL_LABELS[ball]}</small></li>)}
  </ul>;
}

export function snookerElapsedMs(match: SnookerMatch, now = Date.now()) {
  const end = match.endedAt ?? match.pausedAt ?? now;
  return Math.max(0, end - match.startedAt - match.pausedDurationMs);
}

function durationLabel(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function frameTarget(match: SnookerMatch) {
  const frame = match.currentFrame;
  if (!frame) return "无";
  if (frame.pendingFreeBall) return `自由球：${BALL_LABELS[frame.pendingFreeBall.nominatedBall]}作${BALL_LABELS[frame.pendingFreeBall.valueAs]}`;
  if (frame.phase === "colour_after_red") return "任意彩球";
  if (frame.phase === "colours_clearance" || frame.phase === "final_black" || frame.phase === "respotted_black") {
    return frame.nextColour ? `${BALL_LABELS[frame.nextColour]}球` : "黑球";
  }
  return frame.phase === "completed" ? "等待确认本局" : "红球";
}

function ballIsLegal(match: SnookerMatch, ball: SnookerBall) {
  const frame = match.currentFrame;
  if (!frame || frame.status !== "active" || match.pausedAt) return false;
  if (frame.pendingFreeBall) return ball === frame.pendingFreeBall.nominatedBall;
  if (frame.phase === "reds") return ball === "red";
  if (frame.phase === "colour_after_red") return ball !== "red";
  return ball === (frame.nextColour ?? "black");
}

export function SnookerSetupDialog({ onClose, onStart, user, onCloudRoomCreated }: { onClose: () => void; onStart: (draft: SnookerDraft) => void; user: { id: string } | null; onCloudRoomCreated: (code: string, matchId?: string, operationId?: string) => void }) {
  const dialogRef = useModalDialog(onClose);
  const [names, setNames] = useState<[string, string]>(["玩家 A", "玩家 B"]);
  const [bestOf, setBestOf] = useState<number | null>(3);
  const [initialReds, setInitialReds] = useState(SNOOKER_MAX_REDS);
  const [redCountMode, setRedCountMode] = useState<"standard" | "custom">("standard");
  const [firstStriker, setFirstStriker] = useState<0 | 1>(0);
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [note, setNote] = useState("");
  const [useCards, setUseCards] = useState(false);
  const [handSize, setHandSize] = useState(3);
  const [decks, setDecks] = useState<Array<{ id: string; name: string }>>([]);
  const [deckId, setDeckId] = useState("official");
  const [deckVersion, setDeckVersion] = useState(0);
  const [deckSnapshot, setDeckSnapshot] = useState<DeckSnapshot>();
  const [hostMode, setHostMode] = useState<"local" | "cloud">("local");
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudError, setCloudError] = useState("");
  const preview = filterDeckSnapshotForGame(deckSnapshot ?? officialDeckSnapshot(), "snooker");
  const redCountValid = redCountMode === "standard"
    ? initialReds === SNOOKER_MAX_REDS
    : Number.isInteger(initialReds) && initialReds >= SNOOKER_MIN_REDS && initialReds < SNOOKER_MAX_REDS;
  const valid = names.every((name) => name.trim()) && (bestOf === null || (Number.isInteger(bestOf) && bestOf > 0 && bestOf % 2 === 1))
    && redCountValid
    && (!useCards || preview.compatibleCount >= handSize * 2);

  useEffect(() => {
    if (!useCards) return;
    void fetch("/api/decks").then(async (response) => response.ok
      ? await response.json() as { decks?: Array<{ id: string; name: string }> }
      : { decks: [] })
      .then((payload) => setDecks(payload.decks ?? []));
  }, [useCards]);
  const selectDeck = async (id: string) => {
    setDeckId(id);
    if (id === "official") { setDeckVersion(0); setDeckSnapshot(undefined); return; }
    const response = await fetch(`/api/decks/${id}`);
    if (!response.ok) return;
    const payload = await response.json() as { deck?: { currentVersion?: number; snapshot?: DeckSnapshot } };
    setDeckVersion(payload.deck?.currentVersion ?? 0);
    setDeckSnapshot(payload.deck?.snapshot);
  };
  const draft = (): SnookerDraft => ({ playerNames: names, bestOf, firstStriker, initialReds, title, location, note, variant: useCards ? "trick_cards" : "standard", cardMode: useCards ? "independent" : "none", initialHandSize: handSize, deckSnapshot });
  const submitCloud = async () => {
    if (!user || cloudBusy) return;
    setCloudBusy(true); setCloudError("");
    try {
      const operationId = crypto.randomUUID();
      const response = await fetch("/api/realtime/rooms/direct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId, mode: "snooker", players: names.map((name) => ({ name: name.trim() })),
          bestOf, firstStriker, initialReds, title, location, note, cardMode: useCards ? "independent" : "none",
          deckId: "complete",
          deckRef: deckId === "official" ? { kind: "official", id: "complete", version: 1 } : { kind: "user", deckId, versionNo: deckVersion },
          handSizes: [handSize, handSize],
        }),
      });
      const payload = await response.json() as { matchId?: string; room?: { code: string }; error?: string };
      if (!response.ok || !payload.room?.code) throw new Error(payload.error ?? "云端房间响应不完整");
      onCloudRoomCreated(payload.room.code, payload.matchId, operationId);
    } catch (error) { setCloudError(error instanceof Error ? error.message : "创建云端实时房间失败"); }
    finally { setCloudBusy(false); }
  };

  return <dialog ref={dialogRef} className="setup-modal snooker-setup" aria-labelledby="snooker-setup-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="modal-heading"><div><p className="kicker">SNOOKER · NEW MATCH</p><h2 id="snooker-setup-title">创建斯诺克比赛</h2></div><button type="button" className="icon-button" aria-label="关闭斯诺克比赛设置" onClick={onClose}>×</button></header>
    <div className="setup-body">
      <section className="setup-section"><div className="setup-title"><span>00</span><div><b>对局方式</b><small>本机计分离线可用；云端实时房间仅登录用户可用</small></div></div><div className="segmented"><button type="button" className={hostMode === "local" ? "active" : ""} aria-pressed={hostMode === "local"} onClick={() => setHostMode("local")}>本机计分</button><button type="button" className={hostMode === "cloud" ? "active" : ""} aria-pressed={hostMode === "cloud"} disabled={!user} onClick={() => setHostMode("cloud")}>云端实时房间</button></div>{!user && <p className="form-message">登录后可创建实时斯诺克房间。</p>}</section>
      <section className="setup-section"><div className="setup-title"><span>01</span><div><b>双方选手</b></div></div><div className="player-inputs">{names.map((name, index) => <label className="player-input" key={index}><span>{index ? "乙" : "甲"}</span><input name={`snooker-player-${index + 1}-name`} autoComplete="off" aria-label={`斯诺克玩家 ${index + 1} 姓名`} maxLength={16} value={name} onChange={(event) => setNames(names.map((item, itemIndex) => itemIndex === index ? event.target.value : item) as [string, string])} /></label>)}</div></section>
      <section className="setup-section"><div className="setup-title"><span>02</span><div><b>赛制、红球与先手</b><small>标准局固定 15 红；练习或短局可单独选择自定义红球数</small></div></div><div className="eight-form-grid"><label><span>赛制</span><select name="snooker-best-of" autoComplete="off" value={bestOf ?? "free"} onChange={(event) => setBestOf(event.target.value === "free" ? null : Number(event.target.value))}><option value={1}>Best of 1</option><option value={3}>Best of 3</option><option value={5}>Best of 5</option><option value={7}>Best of 7</option><option value={9}>Best of 9</option><option value="free">自由局</option></select></label><div className="snooker-red-count-field"><span>每局红球数</span><div className="segmented snooker-red-count-switch" role="group" aria-label="红球数类型"><button type="button" className={redCountMode === "standard" ? "active" : ""} aria-pressed={redCountMode === "standard"} onClick={() => { setRedCountMode("standard"); setInitialReds(SNOOKER_MAX_REDS); }}>标准 15 红</button><button type="button" className={redCountMode === "custom" ? "active" : ""} aria-pressed={redCountMode === "custom"} onClick={() => { setRedCountMode("custom"); if (initialReds === SNOOKER_MAX_REDS) setInitialReds(6); }}>自定义</button></div></div><label><span>首局先手</span><select name="snooker-first-striker" autoComplete="off" value={firstStriker} onChange={(event) => setFirstStriker(Number(event.target.value) as 0 | 1)}><option value={0}>{names[0] || "玩家 A"}</option><option value={1}>{names[1] || "玩家 B"}</option></select></label>{redCountMode === "custom" ? <label><span>自定义红球数（{SNOOKER_MIN_REDS}–{SNOOKER_MAX_REDS - 1}）</span><input name="snooker-red-count" autoComplete="off" aria-label="每局红球数" type="number" inputMode="numeric" min={SNOOKER_MIN_REDS} max={SNOOKER_MAX_REDS - 1} value={initialReds} onChange={(event) => setInitialReds(Number(event.target.value))} /></label> : <p className="snooker-reds-hint"><b>15 红</b><span>标准斯诺克 · 每个新小局固定沿用</span></p>}</div></section>
      <section className="setup-section"><div className="setup-title"><span>03</span><div><b>比赛资料</b><small>名称、地点和备注会随战绩保存</small></div></div><div className="eight-form-grid"><label><span>比赛名称</span><input name="snooker-title" autoComplete="off" maxLength={40} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label><span>地点</span><input name="snooker-location" autoComplete="off" maxLength={40} value={location} onChange={(event) => setLocation(event.target.value)} /></label><label className="wide"><span>备注</span><input name="snooker-note" autoComplete="off" maxLength={120} value={note} onChange={(event) => setNote(event.target.value)} /></label></div></section>
      <section className="setup-section"><div className="setup-title"><span>04</span><div><b>奇招牌</b><small>启用后仅装载人工确认兼容斯诺克的牌，并标记为变体局</small></div></div><div className="segmented"><button type="button" className={!useCards ? "active" : ""} aria-pressed={!useCards} onClick={() => setUseCards(false)}>不使用</button><button type="button" className={useCards ? "active" : ""} aria-pressed={useCards} onClick={() => setUseCards(true)}>独立手牌</button></div>{useCards ? <div className="eight-form-grid"><label><span>牌组</span><select value={deckId} onChange={(event) => void selectDeck(event.target.value)}><option value="official">官方全量牌库</option>{decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name}</option>)}</select></label><label><span>每人初始手牌</span><select value={handSize} onChange={(event) => setHandSize(Number(event.target.value))}>{[1,2,3,4,5].map((size) => <option key={size} value={size}>{size} 张</option>)}</select></label><p className="wide snooker-standard-note">原牌数 {preview.originalCount} · 兼容 {preview.compatibleCount} · 排除 {preview.excludedCount}。这是奇招牌变体局，不属于纯标准规则局。</p>{preview.compatibleCount < handSize * 2 && <p className="wide form-message">兼容牌不足：两人初始手牌需要 {handSize * 2} 张。</p>}</div> : <p className="snooker-standard-note">{initialReds === SNOOKER_MAX_REDS ? "标准 15 红 · WPBSA 2024–09" : `自定义 ${initialReds} 红`} · 无奇招牌</p>}</section>
    </div>
    {cloudError && <p className="form-message" role="alert">{cloudError}</p>}
    <footer className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button type="button" className="primary" disabled={!valid || cloudBusy} onClick={() => hostMode === "cloud" ? void submitCloud() : onStart(draft())}>{cloudBusy ? "正在创建…" : "确认并开始"} <span aria-hidden="true">→</span></button></footer>
  </dialog>;
}

export function SnookerBoard({ match, onChange, onFinish, toast }: { match: SnookerMatch; onChange: (match: SnookerMatch) => void; onFinish: () => void; toast: (message: string) => void }) {
  const [foulOpen, setFoulOpen] = useState(false);
  const [refereeOpen, setRefereeOpen] = useState(false);
  const [freeBall, setFreeBall] = useState<SnookerBall>("yellow");
  const [freeBallAs, setFreeBallAs] = useState<SnookerBall>("red");
  const frame = match.currentFrame;
  if (!frame) return null;
  const striker = match.players.find(({ id }) => id === frame.strikerId)!;
  const opponent = match.players.find(({ id }) => id !== frame.strikerId)!;
  const stats = getSnookerBreakStats(match);
  const targetFrames = match.bestOf ? Math.ceil(match.bestOf / 2) : null;
  const targetReached = targetFrames !== null && Object.values(match.framesWon).some((wins) => wins >= targetFrames);
  const command = (next: SnookerCommand, message: string) => {
    try { onChange(recordSnookerCommand(match, next)); toast(message); }
    catch (error) { toast(error instanceof Error ? error.message : "操作无效"); }
  };
  return <div className="snooker-page page-shell">
    <section className="snooker-topbar"><div><span className="live-label"><i /> 斯诺克比赛进行中</span><h1>{match.title || `第 ${frame.number} 局`}</h1><p>{match.bestOf ? `Best of ${match.bestOf}` : "自由局"} · {match.initialReds} 红 · {durationLabel(snookerElapsedMs(match))} · {match.variant === "trick_cards" ? "奇招牌变体局" : match.initialReds === SNOOKER_MAX_REDS ? "标准规则" : "自定义红球局"}</p></div><div><button onClick={() => command({ type: match.pausedAt ? "snooker.resume" : "snooker.pause" }, match.pausedAt ? "比赛已恢复" : "比赛已暂停")}>{match.pausedAt ? "继续比赛" : "暂停比赛"}</button><button className="danger-text" onClick={onFinish}>结束比赛</button></div></section>
    {match.pausedAt && <div className="eight-paused">比赛已暂停，计分操作已锁定，当前状态仍会自动保存。</div>}
    {targetReached && <div className="target-notice">已达到获胜局数，请核对后手动结束比赛。</div>}
    <section className="snooker-match-score" aria-label="大局比分">{match.players.map((player) => <article key={player.id} className={player.id === frame.strikerId ? "current" : ""}><small>大局 · {player.id === frame.strikerId ? "当前击球" : "等待"}</small><b>{player.name}</b><strong>{match.framesWon[player.id]}</strong><span>局</span></article>)}</section>
    <section className="snooker-frame-scoreboard" aria-label={`第 ${frame.number} 小局比分`}>{match.players.map((player, index) => <article className={index ? "blue" : "red"} key={player.id}><div><b>{player.name}</b><small>{player.id === frame.strikerId ? "当前击球" : "等待击球"}</small></div><strong>{frame.scores[player.id]}</strong><span>第 {frame.number} 局 · 小局得分</span></article>)}</section>
    <section className="snooker-frame-card" aria-label={`第 ${frame.number} 局计分`}>
      <header><div><p className="kicker">FRAME {frame.number}</p><h2>本局操作</h2></div><dl><div><dt>当前击球</dt><dd>{striker.name}</dd></div><div><dt>目标球</dt><dd>{frameTarget(match)}</dd></div><div><dt>剩余红球</dt><dd>{frame.redsRemaining}</dd></div></dl></header>
      <div className="snooker-break-line" aria-live="polite"><div><span>当前单杆</span><strong>{frame.currentBreak.points}</strong></div><div><span>本局最高</span><strong>{Math.max(0, ...frame.breaks.map(({ points }) => points), frame.currentBreak.points)}</strong></div>{shouldShowSnookerBreakPrompt(frame.currentBreak.points) && <div className="snooker-break-prompt"><b>当前单杆 {frame.currentBreak.points}</b><SnookerBreakBallCounts snookerBreak={frame.currentBreak} /></div>}</div>
      <div className="snooker-ball-row" aria-label="球值计分">{BALLS.map((ball) => <button key={ball} className={`snooker-ball ${ball}`} disabled={!ballIsLegal(match, ball)} onClick={() => command({ type: "snooker.pot.record", ball }, `${striker.name} 打进${BALL_LABELS[ball]}球`)}><span>{SNOOKER_BALL_VALUES[ball]}</span><b>{BALL_LABELS[ball]}</b></button>)}<button className="snooker-foul" disabled={!!match.pausedAt || frame.status !== "active"} aria-expanded={foulOpen} onClick={() => setFoulOpen(!foulOpen)}><span>犯规</span><b>+N 给对方</b></button></div>
      {foulOpen && <div className="snooker-foul-picker" role="group" aria-label={`犯规罚分给${opponent.name}`}><span>{striker.name} 犯规，罚分给 {opponent.name}</span>{SNOOKER_OFFICIAL_FOUL_POINTS.map((points) => <button key={points} onClick={() => { command({ type: "snooker.foul.record", values: [points] }, `${opponent.name} 获得 ${points} 分罚分`); setFoulOpen(false); }}>+{points}</button>)}</div>}
      <div className="snooker-primary-actions"><button className="primary" disabled={!!match.pausedAt || frame.status !== "active"} onClick={() => command({ type: "snooker.visit.end", reason: "miss" }, `本杆结束，轮到 ${opponent.name}`)}>未进／结束本杆</button><button className="secondary" disabled={!match.events.length} onClick={() => { try { onChange(undoLastSnookerEvent(match)); toast("已撤销上一事件并重新计算"); } catch (error) { toast(error instanceof Error ? error.message : "撤销失败"); } }}>撤销上一事件</button><button className="secondary" aria-expanded={refereeOpen} onClick={() => setRefereeOpen(!refereeOpen)}>裁判操作</button></div>
      {frame.status === "completed" && <div className="snooker-frame-finished"><b>{match.players.find(({ id }) => id === frame.winnerId)?.name} 赢得第 {frame.number} 局</b><button className="primary" onClick={() => command({ type: "snooker.frame.finish", reason: "normal", winnerId: frame.winnerId }, "本局已确认，进入下一局")}>确认本局并进入下一局</button></div>}
      {refereeOpen && <section className="snooker-referee" aria-label="裁判操作"><h3>裁判操作</h3><div className="snooker-referee-grid"><label><span>自由球指定球</span><select value={freeBall} onChange={(event) => setFreeBall(event.target.value as SnookerBall)}>{BALLS.map((ball) => <option key={ball} value={ball}>{BALL_LABELS[ball]}球</option>)}</select></label><label><span>作为目标球</span><select value={freeBallAs} onChange={(event) => setFreeBallAs(event.target.value as SnookerBall)}>{BALLS.map((ball) => <option key={ball} value={ball}>{BALL_LABELS[ball]}球</option>)}</select></label><button onClick={() => command({ type: "snooker.free_ball.declare", nominatedBall: freeBall, valueAs: freeBallAs }, "自由球已声明")}>声明自由球</button></div><div className="snooker-referee-actions">{frame.lastFoul?.isMiss && <><button onClick={() => command({ type: "snooker.replay.request", kind: "from_position" }, "已选择从现位重打")}>从现位重打</button><button onClick={() => command({ type: "snooker.replay.request", kind: "restore" }, "已选择复原后重打")}>复原后重打</button></>}{frame.phase === "final_black" && frame.scores[match.players[0].id] === frame.scores[match.players[1].id] && match.players.map((player) => <button key={player.id} onClick={() => command({ type: "snooker.respotted_black.start", firstStrikerId: player.id }, `${player.name} 先打重置黑球`)}>重置黑球：{player.name} 先手</button>)}{match.players.map((player) => <button key={player.id} onClick={() => command({ type: "snooker.frame.finish", winnerId: player.id, reason: "resignation" }, `${player.name} 赢得本局`)}>认输／判 {player.name} 胜</button>)}<button onClick={() => command({ type: "snooker.frame.restart" }, "本局已按僵局规则重开")}>僵局重开本局</button></div></section>}
    </section>
    <section className="snooker-summary"><div><strong>{stats.highestBreak}</strong><span>整场最高单杆</span></div><div><strong>{stats.breaks30PlusCount}</strong><span>30+ 单杆</span></div><div><strong>{match.events.length}</strong><span>追加式事件</span></div><div><strong>{PHASE_LABELS[frame.phase]}</strong><span>当前阶段</span></div></section>
    {match.cards && <section className="card-board"><div className="section-heading"><div><p className="kicker">TRICK CARDS · SNOOKER</p><h2>斯诺克兼容手牌</h2></div><span>{match.cards.deckSnapshot.cardCount} 张兼容牌 · 已排除 {match.cards.deckSnapshot.excludedForGameCount ?? 0} 张</span></div><div className="hand-grid">{match.players.map((player) => <article key={player.id}><h3>{player.name}</h3><div className="card-hand">{(match.cards!.hands[player.id] ?? []).map((card) => <div className="play-card" key={card.instanceId}><small>{card.displayNumber}</small><b>{card.title}</b><p>{card.effect}</p><div><button disabled={!!match.pausedAt} onClick={() => onChange(recordSnookerCardAction(match, player.id, card.instanceId, "play"))}>使用</button><button disabled={!!match.pausedAt} onClick={() => onChange(recordSnookerCardAction(match, player.id, card.instanceId, "skip"))}>安全跳过</button></div></div>)}</div></article>)}</div></section>}
  </div>;
}

const FRAME_END_LABELS = { normal: "正常结束", resignation: "认输", award: "判罚" } as const;

function specialEventLabel(event: SnookerMatch["events"][number]) {
  if (event.type === "snooker.event.correct") return "事件更正";
  const command = event.command;
  if (!command) return event.type;
  if (command.type === "snooker.foul.record") return `犯规 ${Math.max(...command.values)} 分${command.isMiss ? " · foul and a miss" : ""}`;
  if (command.type === "snooker.free_ball.declare") return `自由球：${BALL_LABELS[command.nominatedBall]}作${BALL_LABELS[command.valueAs]}`;
  if (command.type === "snooker.replay.request") return command.kind === "restore" ? "复原后重打" : "从现位重打";
  if (command.type === "snooker.respotted_black.start") return "重置黑球";
  if (command.type === "snooker.frame.restart") return "僵局重开";
  if (command.type === "snooker.frame.finish") return `结束本局 · ${FRAME_END_LABELS[command.reason]}`;
  return command.type;
}

export function SnookerHistoryDetail({ match, onBack, reportActions }: { match: SnookerMatch; onBack: () => void; reportActions?: ReactNode }) {
  const stats = getSnookerBreakStats(match);
  const winner = [...match.players].sort((a, b) => match.framesWon[b.id] - match.framesWon[a.id])[0];
  const specialEvents = match.events.filter(({ type }) => ["snooker.foul.record", "snooker.free_ball.declare", "snooker.replay.request", "snooker.respotted_black.start", "snooker.frame.restart", "snooker.frame.finish", "snooker.event.correct"].includes(type));
  return <div className="content-page page-shell"><button className="back-link" onClick={onBack}>← 返回战绩</button><header className="page-title split"><div><p className="kicker">SNOOKER · MATCH DETAIL</p><h1>{match.title || "斯诺克比赛"}</h1><p>{new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(match.startedAt)} · {durationLabel(snookerElapsedMs(match))}{match.location ? ` · ${match.location}` : ""} · {match.variant === "trick_cards" ? "奇招牌变体局" : "标准规则"}</p></div>{reportActions}</header><section className="snooker-history-result"><div><span>最终局分</span><strong>{match.players.map((player) => `${player.name} ${match.framesWon[player.id]}`).join(" : ")}</strong><small>获胜者：{winner.name}</small></div><div><span>最高单杆</span><strong>{stats.highestBreak}</strong><small>30+ {stats.breaks30PlusCount} · 50+ {stats.breaks30Plus.filter(({ points }) => points >= 50).length} · 100+ {stats.breaks30Plus.filter(({ points }) => points >= 100).length} · 147 {stats.completed147} · 155 {stats.completed155}</small></div></section><section className="snooker-frame-history"><div className="section-heading"><div><p className="kicker">FRAME RESULTS</p><h2>每局比分与单杆</h2></div><span>{match.completedFrames.length} 局</span></div>{match.completedFrames.map((frame) => <article key={frame.id}><span>第 {frame.number} 局</span><div><b>{match.players.find(({ id }) => id === frame.winnerId)?.name} · {FRAME_END_LABELS[frame.endReason]}</b><small>{match.players.map((player) => `${player.name} 最高 ${Math.max(0, ...frame.breaks.filter(({ playerId }) => playerId === player.id).map(({ points }) => points))}`).join(" · ")}{frame.breaks.some(({ points }) => points >= 31) ? ` · 30+：${frame.breaks.filter(({ points }) => points >= 31).map(({ points }) => points).join("、")}` : ""}</small></div><strong>{match.players.map((player) => frame.scores[player.id]).join(" : ")}</strong></article>)}</section>{specialEvents.length > 0 && <section className="history-detail"><div className="section-heading"><div><p className="kicker">REFEREE EVENTS</p><h2>特殊事件</h2></div><span>{specialEvents.length} 条</span></div>{specialEvents.map((event) => <div className="timeline-row unified" key={event.id}><span>#{event.sequenceNo}</span><div><b>{specialEventLabel(event)}</b><small>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(event.occurredAt)}</small></div></div>)}</section>}{match.cards && <section className="history-detail"><div className="section-heading"><div><p className="kicker">TRICK CARD TIMELINE</p><h2>奇招牌事件</h2></div><span>{match.cards.events.length} 条</span></div>{[...match.cards.events].reverse().map((event) => <div className="timeline-row unified card" key={event.id}><span>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(event.occurredAt)}</span><div><b>{event.label}</b><small>{event.card?.title ?? ""}</small></div></div>)}</section>}<details className="raw-events"><summary>查看追加式原始事件（{match.events.length}）</summary>{match.events.map((event) => <pre key={event.id}>{JSON.stringify(event, null, 2)}</pre>)}</details></div>;
}
