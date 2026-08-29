"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import styles from "./preview-test.module.css";

type User = { id: string; username: string; nickname: string; publicCode: string };
type CloudMatch = { id: string; mode: string; status: string; version: number; created_at: number };
type TestResult = {
  attempt: number;
  status: number;
  requestId: string;
  roomCode: string;
  matchId: string;
  retryable: boolean;
  message: string;
};

const MODE_LABELS: Record<string, string> = {
  score: "多人追分",
  score_cards: "追分 + 奇招牌",
  chinese_eight: "中八双人赛",
  cards: "奇招牌局",
};

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export default function RealtimePreviewTest() {
  const [user, setUser] = useState<User | null>(null);
  const [matches, setMatches] = useState<CloudMatch[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<TestResult[]>([]);

  const selectedMatch = useMemo(
    () => matches.find((match) => match.id === selectedMatchId),
    [matches, selectedMatchId],
  );

  const refresh = async () => {
    setLoading(true);
    setMessage("");
    try {
      const sessionResponse = await fetch("/api/auth/me", { cache: "no-store" });
      const sessionPayload = await readPayload(sessionResponse) as { user?: User | null };
      if (!sessionResponse.ok || !sessionPayload.user) {
        setUser(null);
        setMatches([]);
        return;
      }
      setUser(sessionPayload.user);
      const historyResponse = await fetch("/api/history", { cache: "no-store" });
      const historyPayload = await readPayload(historyResponse) as { matches?: CloudMatch[]; error?: string };
      if (!historyResponse.ok) throw new Error(historyPayload.error ?? `读取云端对局失败（${historyResponse.status}）`);
      const available = (historyPayload.matches ?? []).filter(
        (match) => match.status !== "completed" && match.status !== "cancelled",
      );
      setMatches(available);
      setSelectedMatchId((current) => available.some((match) => match.id === current) ? current : available[0]?.id ?? "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "预览数据加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const createAttempt = async (attempt: number): Promise<TestResult> => {
    const response = await fetch("/api/realtime/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchId: selectedMatchId }),
    });
    const payload = await readPayload(response);
    const room = payload.room && typeof payload.room === "object" ? payload.room as Record<string, unknown> : {};
    return {
      attempt,
      status: response.status,
      requestId: response.headers.get("X-Request-Id") ?? String(payload.requestId ?? "—"),
      roomCode: typeof room.code === "string" ? room.code : "—",
      matchId: typeof room.matchId === "string" ? room.matchId : selectedMatchId,
      retryable: payload.retryable === true,
      message: response.ok ? (response.status === 201 ? "首次创建成功" : "已复用现有房间") : String(payload.error ?? "请求失败"),
    };
  };

  const runTest = async () => {
    if (!selectedMatchId) return;
    setRunning(true);
    setResults([]);
    setMessage("正在创建房间并验证重复请求……");
    try {
      const first = await createAttempt(1);
      setResults([first]);
      if (first.status >= 400) {
        setMessage(first.retryable ? "服务暂时不可用，但恢复信息完整；可稍后再次运行。" : "首次请求失败，请查看下方详情。");
        return;
      }
      const second = await createAttempt(2);
      setResults([first, second]);
      const passed = second.status === 200 && first.roomCode !== "—" && first.roomCode === second.roomCode;
      setMessage(passed
        ? `验收通过：两次请求均指向房间 ${first.roomCode}，没有产生重复房间。`
        : "验收未通过：两次请求未稳定复用同一房间码，请保留下方 requestId。",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "测试请求未完成");
    } finally {
      setRunning(false);
    }
  };

  const passed = results.length === 2
    && results[1].status === 200
    && results[0].roomCode !== "—"
    && results[0].roomCode === results[1].roomCode;

  return <main className={styles.page}>
    <header className={styles.hero}>
      <div className={styles.eyebrow}><span /> V5.1.1 · PREVIEW ACCEPTANCE</div>
      <h1>实时房间稳定性<br />一键验收</h1>
      <p>验证首次创建、重复请求复用、请求追踪与可恢复错误。测试只使用已有云端对局，不修改计分流水。</p>
      <div className={styles.links}><Link href="/">返回应用</Link><Link href="/profile">账号与云端</Link></div>
    </header>

    <section className={styles.panel}>
      <div className={styles.stepHeader}><span>01</span><div><b>环境与账号</b><small>使用当前浏览器内的台球奇招登录会话</small></div></div>
      {loading ? <div className={styles.notice}>正在检查预览环境……</div> : user ? <div className={styles.account}>
        <span>{user.nickname.slice(0, 1)}</span><div><b>{user.nickname}</b><small>@{user.username} · {user.publicCode}</small></div><i>已登录</i>
      </div> : <div className={`${styles.notice} ${styles.warning}`}><b>尚未登录</b><span>请先前往“账号与云端”登录，再返回本页运行测试。</span><Link href="/profile">去登录</Link></div>}
    </section>

    <section className={styles.panel}>
      <div className={styles.stepHeader}><span>02</span><div><b>选择未结束对局</b><small>第一次请求创建房间，第二次请求必须复用同一码</small></div></div>
      {user && !matches.length && !loading ? <div className={`${styles.notice} ${styles.warning}`}><b>没有可用云端对局</b><span>请先在应用中创建并同步一场未结束对局。</span><Link href="/play">创建对局</Link></div> : <label className={styles.selectLabel}>
        <span>云端对局</span>
        <select name="preview-match" autoComplete="off" disabled={!user || loading || running} value={selectedMatchId} onChange={(event) => { setSelectedMatchId(event.target.value); setResults([]); setMessage(""); }}>
          <option value="">请选择</option>
          {matches.map((match) => <option key={match.id} value={match.id}>{MODE_LABELS[match.mode] ?? match.mode} · {formatTime(match.created_at)} · {match.status}</option>)}
        </select>
      </label>}
      {selectedMatch && <div className={styles.matchId}>MATCH ID <code>{selectedMatch.id}</code></div>}
      <button className={styles.runButton} disabled={!user || !selectedMatchId || running} onClick={() => void runTest()}>{running ? "正在执行两次请求……" : "运行创建与复用测试"}<span>→</span></button>
    </section>

    <section className={styles.panel} aria-live="polite">
      <div className={styles.stepHeader}><span>03</span><div><b>验收结果</b><small>成功标准：第二次返回 200，且两次房间码完全相同</small></div></div>
      {!results.length ? <div className={styles.empty}>运行测试后，这里会显示两次请求的独立结果。</div> : <div className={styles.results}>
        {results.map((result) => <article key={result.attempt} className={result.status < 400 ? styles.successCard : styles.errorCard}>
          <header><span>请求 {result.attempt}</span><strong>HTTP {result.status}</strong></header>
          <dl><div><dt>房间码</dt><dd>{result.roomCode}</dd></div><div><dt>结果</dt><dd>{result.message}</dd></div><div><dt>Request ID</dt><dd><code>{result.requestId}</code></dd></div></dl>
        </article>)}
      </div>}
      {message && <div className={`${styles.summary} ${passed ? styles.passed : ""}`} role="status" aria-live="polite"><span aria-hidden="true">{passed ? "✓" : running ? "…" : "!"}</span>{message}</div>}
    </section>

    <footer className={styles.footer}>台球奇招 · A4 PREVIEW GATE · 不写入 Cookie、密码或完整请求体</footer>
  </main>;
}
