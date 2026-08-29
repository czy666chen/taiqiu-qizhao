"use client";

import { type AnchorHTMLAttributes, FormEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { getSnookerBreakStats, isSnookerMatch } from "../src/lib/snooker";

type Admin = { id: string; username: string };
type UserSummary = {
  id: string;
  username: string;
  publicCode: string;
  nickname: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  matchCount: number;
  lastMatchAt: number | null;
};
type UserDetail = UserSummary & {
  avatarUrl: string | null;
  deletedAt: number | null;
  passwordResetAt: number | null;
  activeSessionCount: number;
};
type UserMatch = {
  id: string;
  mode: string;
  status: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  isOwner: boolean;
};
type AuthEvent = { id: string; action: string; outcome: string; createdAt: number };
type MatchPlayer = {
  id: string;
  seatNo: number;
  userId: string | null;
  role: string;
  nicknameSnapshot: string;
  username: string | null;
  nickname: string | null;
  userStatus: string | null;
  finalScore?: number;
};
type MatchSummary = {
  id: string;
  mode: string;
  status: string;
  privacy: string;
  version: number;
  owner: { userId: string; username: string | null; nickname: string | null; userStatus: string | null };
  players: MatchPlayer[];
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  isRealtime: boolean;
};
type MatchDetail = MatchSummary & {
  snapshotChecksum: string | null;
  rawSnapshot: unknown;
  realtime: { roomCode: string; status: string } | null;
};
type ScoreEvent = { id: string; sequenceNo: number; actorUsername: string | null; playerNickname: string; scoreDelta: number; occurredAt: number };
type CardEvent = { id: string; sequenceNo: number; actorUsername: string | null; cardInstanceSnapshot: Record<string, unknown>; occurredAt: number };
type MatchAuditEvent = { id: string; actorUsername: string | null; action: string; reason: string | null; createdAt: number };

const STATUS_LABELS: Record<string, string> = {
  active: "正常",
  disabled: "已禁用",
  deleted: "已删除",
  draft: "草稿",
  completed: "已完成",
  cancelled: "已取消",
};
const MODE_LABELS: Record<string, string> = {
  score: "多人追分",
  cards: "奇招牌",
  score_cards: "追分 + 奇招牌",
  chinese_eight: "中式八球",
  snooker: "斯诺克",
};

async function payload<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `请求失败（${response.status}）`);
  return body;
}

function dateTime(value: number | null): string {
  return value === null ? "—" : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(value);
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

function replaceAdminSearch(values: Record<string, string>): void {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value.trim()) params.set(key, value.trim());
  const search = params.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
}

function AdminLink({ href, navigate, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; navigate: (path: string) => void }) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handleClick} {...props} />;
}

function ErrorNotice({ message }: { message: string }) {
  return message ? <p className="admin-error" role="alert">{message}</p> : null;
}

function LoginPage({ onAuthenticated, navigate }: { onAuthenticated: (admin: Admin) => void; navigate: (path: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await payload<{ admin: Admin }>(await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      }));
      onAuthenticated(result.admin);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="admin-login-shell">
      <section className="admin-login-card" aria-labelledby="admin-login-title">
        <div className="admin-mark" aria-hidden="true">8</div>
        <p className="admin-eyebrow">HEI8 CONTROL ROOM</p>
        <h1 id="admin-login-title">管理后台</h1>
        <p className="admin-muted">管理员身份与普通用户完全隔离。</p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="admin-username">管理员用户名</label>
          <input id="admin-username" name="username" autoComplete="username" spellCheck={false} value={username} onChange={(event) => setUsername(event.target.value)} required />
          <label htmlFor="admin-password">密码</label>
          <input id="admin-password" name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          <ErrorNotice message={error} />
          <button className="admin-primary" disabled={busy}>{busy ? "正在验证…" : "进入后台"}</button>
        </form>
        <AdminLink className="admin-home-link" href="/" navigate={navigate}>返回台球奇招</AdminLink>
      </section>
    </main>
  );
}

function UsersPage({ navigate }: { navigate: (path: string) => void }) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const load = async (nextCursor?: string, filters = { query, status }) => {
    setBusy(true);
    setError("");
    const params = new URLSearchParams({ limit: "30" });
    if (filters.query.trim()) params.set("query", filters.query.trim());
    if (filters.status) params.set("status", filters.status);
    if (nextCursor) params.set("cursor", nextCursor);
    try {
      const result = await payload<{ users: UserSummary[]; nextCursor: string | null }>(await fetch(`/api/admin/users?${params}`));
      setUsers(nextCursor ? (current) => [...current, ...result.users] : result.users);
      setCursor(result.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "用户读取失败");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const filters = { query: params.get("query") ?? "", status: params.get("status") ?? "" };
    const timer = window.setTimeout(() => {
      setQuery(filters.query);
      setStatus(filters.status);
      void load(undefined, filters);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="admin-page" aria-labelledby="users-title">
      <header className="admin-page-heading"><div><p className="admin-eyebrow">ACCOUNTS</p><h1 id="users-title">用户管理</h1></div><span>{users.length} 个已加载账号</span></header>
      <form className="admin-filters" onSubmit={(event) => { event.preventDefault(); replaceAdminSearch({ query, status }); void load(); }}>
        <label><span>用户名或昵称</span><input name="user-query" autoComplete="off" spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：小王…" /></label>
        <label><span>账号状态</span><select name="user-status" autoComplete="off" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option><option value="active">正常</option><option value="disabled">已禁用</option><option value="deleted">已删除</option></select></label>
        <button className="admin-primary" disabled={busy}>查询</button>
      </form>
      <ErrorNotice message={error} />
      {!busy && !error && users.length === 0 && <div className="admin-empty">没有符合条件的用户</div>}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead><tr><th>用户</th><th>公开编号</th><th>状态</th><th>战绩</th><th>最近比赛</th><th><span className="admin-sr-only">操作</span></th></tr></thead>
          <tbody>{users.map((user) => <tr key={user.id}><td><AdminLink className="admin-link" href={`/admin/users/${user.id}`} navigate={navigate}><b>{user.nickname}</b><small>@{user.username}</small></AdminLink></td><td>{user.publicCode}</td><td><span className={`admin-status ${user.status}`}>{statusLabel(user.status)}</span></td><td>{user.matchCount}</td><td>{dateTime(user.lastMatchAt)}</td><td><AdminLink className="admin-quiet" href={`/admin/users/${user.id}`} navigate={navigate}>查看详情</AdminLink></td></tr>)}</tbody>
        </table>
      </div>
      {busy && <p className="admin-loading" role="status">正在读取用户…</p>}
      {cursor && !busy && <button className="admin-more" onClick={() => void load(cursor)}>加载更多</button>}
    </section>
  );
}

function ResetPasswordDialog({ user, onClose, onReset }: { user: UserDetail; onClose: () => void; onReset: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await payload<{ newPassword: string }>(await fetch(`/api/admin/users/${user.id}/reset-password`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword }),
      }));
      setNewPassword(result.newPassword);
      onReset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "密码重置失败");
    } finally { setBusy(false); }
  };
  return (
      <dialog ref={dialogRef} className="admin-dialog" aria-labelledby="reset-title" onCancel={(event) => {
        if (newPassword && !saved) event.preventDefault();
        else onClose();
      }}>
        <h2 id="reset-title">重置 {user.username} 的密码</h2>
        {!newPassword ? <form onSubmit={(event) => void submit(event)}>
          <p className="admin-warning">这会立即注销该用户的所有旧会话，并将密码重置为 123456。</p>
          <label htmlFor="reset-admin-password">当前管理员密码</label>
          <input id="reset-admin-password" name="admin-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
          <label htmlFor="reset-confirmation">输入目标用户名确认</label>
          <input id="reset-confirmation" name="target-username" autoComplete="off" spellCheck={false} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={`例如：${user.username}…`} required />
          <ErrorNotice message={error} />
          <div className="admin-dialog-actions"><button type="button" className="admin-quiet" onClick={onClose}>取消</button><button className="admin-danger" disabled={busy || confirmation !== user.username}>{busy ? "正在重置…" : "确认重置"}</button></div>
        </form> : <div className="admin-password-result">
          <p>新密码</p><code>{newPassword}</code>
          <button className="admin-quiet" onClick={() => void navigator.clipboard.writeText(newPassword)}>复制密码</button>
          <label className="admin-checkbox"><input name="password-reset-acknowledged" autoComplete="off" type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />我已告知用户登录后立即更改密码</label>
          <button className="admin-primary" disabled={!saved} onClick={onClose}>关闭</button>
        </div>}
      </dialog>
  );
}

function DeleteUserDialog({ user, onClose, onDeleted }: { user: UserDetail; onClose: () => void; onDeleted: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await payload(await fetch(`/api/admin/users/${user.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, confirmation }),
      }));
      onDeleted();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "账户删除失败"); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialogRef} className="admin-dialog" aria-labelledby="delete-user-title" onCancel={onClose}><h2 id="delete-user-title">删除 {user.username} 的账户</h2><form onSubmit={(event) => void submit(event)}><p className="admin-warning">该操作不可恢复。用户专属数据会被删除；已有其他注册参与者的共享对局会保留，并解除该用户关联。</p><label htmlFor="delete-admin-password">当前管理员密码</label><input id="delete-admin-password" name="admin-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /><label htmlFor="delete-user-confirmation">输入目标用户名确认</label><input id="delete-user-confirmation" name="target-username" autoComplete="off" spellCheck={false} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={`例如：${user.username}`} required /><ErrorNotice message={error} /><div className="admin-dialog-actions"><button type="button" className="admin-quiet" disabled={busy} onClick={onClose}>取消</button><button className="admin-danger" disabled={busy || confirmation !== user.username}>{busy ? "正在删除…" : "永久删除账户"}</button></div></form></dialog>;
}

function UserDetailPage({ userId, navigate }: { userId: string; navigate: (path: string) => void }) {
  const [data, setData] = useState<{ user: UserDetail; recentMatches: UserMatch[]; recentAuthEvents: AuthEvent[] } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    try { setData(await payload(await fetch(`/api/admin/users/${userId}`))); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "用户详情读取失败"); }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <section className="admin-page"><AdminLink className="admin-back" href="/admin/users" navigate={navigate}>← 返回用户</AdminLink><ErrorNotice message={error} /></section>;
  if (!data) return <p className="admin-loading" role="status">正在读取用户详情…</p>;
  const { user } = data;
  return (
    <section className="admin-page">
      <AdminLink className="admin-back" href="/admin/users" navigate={navigate}>← 返回用户</AdminLink>
      <header className="admin-detail-heading"><div className="admin-avatar">{user.nickname.slice(0, 1)}</div><div><p className="admin-eyebrow">{user.publicCode}</p><h1>{user.nickname}</h1><p>@{user.username}</p></div><span className={`admin-status ${user.status}`}>{statusLabel(user.status)}</span></header>
      <div className="admin-metrics"><article><small>战绩</small><strong>{user.matchCount}</strong></article><article><small>有效会话</small><strong>{user.activeSessionCount}</strong></article><article><small>注册时间</small><strong>{dateTime(user.createdAt)}</strong></article><article><small>最近重置密码</small><strong>{dateTime(user.passwordResetAt)}</strong></article></div>
      <div className="admin-detail-actions">{user.status === "active" && <button className="admin-danger" onClick={() => setResetOpen(true)}>重置用户密码</button>}<button className="admin-danger" onClick={() => setDeleteOpen(true)}>删除账户</button></div>
      <div className="admin-detail-grid">
        <section className="admin-panel"><h2>最近战绩</h2>{data.recentMatches.length ? data.recentMatches.map((match) => <AdminLink className="admin-record" key={match.id} href={`/admin/matches/${match.id}`} navigate={navigate}><span><b>{modeLabel(match.mode)}</b><small>{dateTime(match.createdAt)} · {match.isOwner ? "房主" : "参与者"}</small></span><span className={`admin-status ${match.status}`}>{statusLabel(match.status)}</span></AdminLink>) : <p className="admin-muted">暂无战绩</p>}</section>
        <section className="admin-panel"><h2>最近认证事件</h2>{data.recentAuthEvents.length ? data.recentAuthEvents.map((event) => <article className="admin-record" key={event.id}><span><b>{event.action}</b><small>{dateTime(event.createdAt)}</small></span><span className={`admin-status ${event.outcome}`}>{event.outcome}</span></article>) : <p className="admin-muted">暂无认证事件</p>}</section>
      </div>
      {resetOpen && <ResetPasswordDialog user={user} onClose={() => setResetOpen(false)} onReset={() => void load()} />}
      {deleteOpen && <DeleteUserDialog user={user} onClose={() => setDeleteOpen(false)} onDeleted={() => navigate("/admin/users")} />}
    </section>
  );
}

function MatchesPage({ navigate }: { navigate: (path: string) => void }) {
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("");
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const load = async (nextCursor?: string, filters = { query, mode, status }) => {
    setBusy(true); setError("");
    const params = new URLSearchParams({ limit: "30" });
    if (filters.query.trim()) params.set("query", filters.query.trim());
    if (filters.mode) params.set("mode", filters.mode);
    if (filters.status) params.set("status", filters.status);
    if (nextCursor) params.set("cursor", nextCursor);
    try {
      const result = await payload<{ matches: MatchSummary[]; nextCursor: string | null }>(await fetch(`/api/admin/matches?${params}`));
      setMatches(nextCursor ? (current) => [...current, ...result.matches] : result.matches);
      setCursor(result.nextCursor);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "战绩读取失败"); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const filters = { query: params.get("query") ?? "", mode: params.get("mode") ?? "", status: params.get("status") ?? "" };
    const timer = window.setTimeout(() => {
      setQuery(filters.query);
      setMode(filters.mode);
      setStatus(filters.status);
      void load(undefined, filters);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="admin-page" aria-labelledby="matches-title">
      <header className="admin-page-heading"><div><p className="admin-eyebrow">MATCH ARCHIVE</p><h1 id="matches-title">战绩管理</h1></div><span>{matches.length} 场已加载对局</span></header>
      <form className="admin-filters matches" onSubmit={(event) => { event.preventDefault(); replaceAdminSearch({ query, mode, status }); void load(); }}>
        <label><span>编号或玩家</span><input name="match-query" autoComplete="off" spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：房间编号或玩家昵称…" /></label>
        <label><span>模式</span><select name="match-mode" autoComplete="off" value={mode} onChange={(event) => setMode(event.target.value)}><option value="">全部模式</option><option value="score">多人追分</option><option value="cards">奇招牌</option><option value="score_cards">追分 + 奇招牌</option><option value="chinese_eight">中式八球</option><option value="snooker">斯诺克</option></select></label>
        <label><span>状态</span><select name="match-status" autoComplete="off" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option><option value="draft">草稿</option><option value="active">进行中</option><option value="completed">已完成</option><option value="cancelled">已取消</option></select></label>
        <button className="admin-primary" disabled={busy}>查询</button>
      </form>
      <ErrorNotice message={error} />
      <div className="admin-match-list">{matches.map((match) => <AdminLink key={match.id} href={`/admin/matches/${match.id}`} navigate={navigate}><div><span className="admin-mode">{modeLabel(match.mode)}</span>{match.isRealtime && <span className="admin-live">实时</span>}<span className={`admin-status ${match.status}`}>{statusLabel(match.status)}</span></div><h2>{match.players.map((player) => player.nickname ?? player.nicknameSnapshot).join(" · ") || "无玩家"}</h2><p>房主 {match.owner.nickname ?? match.owner.username ?? "已删除用户"} · {dateTime(match.createdAt)}</p><code>{match.id}</code></AdminLink>)}</div>
      {!busy && !error && matches.length === 0 && <div className="admin-empty">没有符合条件的战绩</div>}
      {busy && <p className="admin-loading" role="status">正在读取战绩…</p>}
      {cursor && !busy && <button className="admin-more" onClick={() => void load(cursor)}>加载更多</button>}
    </section>
  );
}

function MatchDetailPage({ matchId, navigate }: { matchId: string; navigate: (path: string) => void }) {
  const [data, setData] = useState<{ match: MatchDetail; scoreEvents: ScoreEvent[]; cardEvents: CardEvent[]; auditEvents: MatchAuditEvent[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch(`/api/admin/matches/${matchId}`)
      .then((response) => payload<{ match: MatchDetail; scoreEvents: ScoreEvent[]; cardEvents: CardEvent[]; auditEvents: MatchAuditEvent[] }>(response))
      .then(setData)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "战绩详情读取失败"));
  }, [matchId]);
  if (error) return <section className="admin-page"><AdminLink className="admin-back" href="/admin/matches" navigate={navigate}>← 返回战绩</AdminLink><ErrorNotice message={error} /></section>;
  if (!data) return <p className="admin-loading" role="status">正在读取战绩详情…</p>;
  const { match } = data;
  const snooker = isSnookerMatch(match.rawSnapshot) ? match.rawSnapshot : null;
  const snookerStats = snooker ? getSnookerBreakStats(snooker) : null;
  return (
    <section className="admin-page">
      <AdminLink className="admin-back" href="/admin/matches" navigate={navigate}>← 返回战绩</AdminLink>
      <header className="admin-page-heading"><div><p className="admin-eyebrow">{match.id}</p><h1>{modeLabel(match.mode)}</h1><p>{dateTime(match.createdAt)} · 版本 {match.version}</p></div><span className={`admin-status ${match.status}`}>{statusLabel(match.status)}</span></header>
      <div className="admin-score-grid">{match.players.map((player) => <article key={player.id}><small>{player.role} · 座位 {player.seatNo + 1}</small><b>{player.nickname ?? player.nicknameSnapshot}</b><strong>{snooker ? snooker.framesWon[snooker.players[player.seatNo]?.id] ?? 0 : player.finalScore ?? 0}</strong><span>{player.username ? `@${player.username}` : "游客"}</span></article>)}</div>
      {snooker && snookerStats && <section className="admin-panel"><h2>斯诺克只读摘要</h2><p>{snooker.players.map((player) => `${player.name} ${snooker.framesWon[player.id]}`).join(" : ")} · {snooker.currentFrame ? `当前局 ${snooker.players.map((player) => snooker.currentFrame!.scores[player.id]).join(" : ")}` : `${snooker.completedFrames.length} 局已结束`} · 最高单杆 {snookerStats.highestBreak} · 30+ {snookerStats.breaks30PlusCount} · {snooker.variant === "trick_cards" ? "奇招牌变体局" : "标准规则"}</p></section>}
      <div className="admin-detail-grid">
        <section className="admin-panel"><h2>比分事件 · {data.scoreEvents.length}</h2>{data.scoreEvents.map((event) => <article className="admin-timeline" key={event.id}><span>{event.sequenceNo}</span><div><b>{event.playerNickname} {event.scoreDelta >= 0 ? "+" : ""}{event.scoreDelta}</b><small>{event.actorUsername ?? "系统"} · {dateTime(event.occurredAt)}</small></div></article>)}</section>
        <section className="admin-panel"><h2>卡牌事件 · {data.cardEvents.length}</h2>{data.cardEvents.map((event) => <article className="admin-timeline" key={event.id}><span>{event.sequenceNo}</span><div><b>{String(event.cardInstanceSnapshot.name ?? event.cardInstanceSnapshot.title ?? "卡牌操作")}</b><small>{event.actorUsername ?? "系统"} · {dateTime(event.occurredAt)}</small></div></article>)}</section>
      </div>
      <section className="admin-panel"><h2>对局审计 · {data.auditEvents.length}</h2>{data.auditEvents.map((event) => <article className="admin-record" key={event.id}><span><b>{event.action}</b><small>{event.actorUsername ?? "系统"} · {dateTime(event.createdAt)}</small></span><small>{event.reason ?? "—"}</small></article>)}</section>
      <details className="admin-snapshot"><summary>查看原始快照</summary><pre>{JSON.stringify(match.rawSnapshot, null, 2)}</pre></details>
    </section>
  );
}

export default function AdminApp({ path, navigate }: { path: string; navigate: (path: string) => void }) {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let active = true;
    void fetch("/api/admin/auth/session")
      .then((response) => payload<{ admin: Admin | null }>(response))
      .then((result) => { if (active) setAdmin(result.admin); })
      .catch(() => { if (active) setAdmin(null); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (checking) return;
    if (!admin && path !== "/admin/login") navigate("/admin/login");
    if (admin && (path === "/admin" || path === "/admin/login")) navigate("/admin/users");
  }, [admin, checking, navigate, path]);
  if (checking) return <main className="admin-login-shell"><p className="admin-loading" role="status">正在验证管理员会话…</p></main>;
  if (!admin) return <LoginPage navigate={navigate} onAuthenticated={(next) => { setAdmin(next); navigate("/admin/users"); }} />;

  const logout = async () => {
    try { await payload(await fetch("/api/admin/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })); } finally { setAdmin(null); navigate("/admin/login"); }
  };
  const userId = path.match(/^\/admin\/users\/([^/]+)$/)?.[1];
  const matchId = path.match(/^\/admin\/matches\/([^/]+)$/)?.[1];
  return (
    <main className="admin-root">
      <a className="admin-skip" href="#admin-content">跳到主要内容</a>
      <aside className="admin-sidebar"><AdminLink className="admin-brand" href="/admin/users" navigate={navigate}><span>8</span><div><b>台球奇招</b><small>管理后台</small></div></AdminLink><nav aria-label="管理后台导航"><AdminLink className={path.startsWith("/admin/users") ? "active" : ""} href="/admin/users" navigate={navigate} aria-current={path.startsWith("/admin/users") ? "page" : undefined}>用户</AdminLink><AdminLink className={path.startsWith("/admin/matches") ? "active" : ""} href="/admin/matches" navigate={navigate} aria-current={path.startsWith("/admin/matches") ? "page" : undefined}>战绩</AdminLink></nav><div className="admin-account"><span>{admin.username.slice(0, 1).toUpperCase()}</span><div><b>{admin.username}</b><small>管理员</small></div><button onClick={() => void logout()}>退出</button></div></aside>
      <div className="admin-mobile-bar"><AdminLink className="admin-mobile-brand" href="/admin/users" navigate={navigate}>8 · 管理后台</AdminLink><nav aria-label="移动端管理导航"><AdminLink href="/admin/users" navigate={navigate}>用户</AdminLink><AdminLink href="/admin/matches" navigate={navigate}>战绩</AdminLink><button onClick={() => void logout()}>退出</button></nav></div>
      <div id="admin-content" className="admin-content" tabIndex={-1}>{userId ? <UserDetailPage userId={userId} navigate={navigate} /> : matchId ? <MatchDetailPage matchId={matchId} navigate={navigate} /> : path === "/admin/matches" ? <MatchesPage navigate={navigate} /> : <UsersPage navigate={navigate} />}</div>
    </main>
  );
}
