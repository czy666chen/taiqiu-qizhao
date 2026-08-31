import {
  getPlayerReport,
  getTeamBattleProjection,
  TEAM_BATTLE_REPORT_AUTO_DETAIL_MAX_HEIGHT,
  TEAM_BATTLE_REPORT_HARD_MAX_HEIGHT,
  type EffectiveTeamBattleRound,
  type TeamBattleMatch,
  type TeamBattleReportOptions,
  type TeamBattleReportProjection,
} from "./team-battle";
import { REPORT_THEME_PALETTES, type ReportTheme } from "./report-theme";

const REPORT_WIDTH = 900;
const BASE_HEIGHT = 430;
const ROW_HEIGHT = 56;
const ROUND_ROW_HEIGHT = 62;
const WIN_LABELS = { normal: "普胜", break_clear: "炸清", runout: "接清" } as const;

function reportHeight(match: TeamBattleMatch, options: TeamBattleReportOptions, includeRounds: boolean) {
  const projection = getTeamBattleProjection(match);
  const rowCount = options.scope.kind === "all"
    ? projection.standings.length + projection.pairs.length
    : match.players.length - 1;
  const roundCount = options.scope.kind === "all"
    ? projection.rounds.length
    : projection.rounds.filter(({ playerIds }) => playerIds.includes(options.scope.playerId)).length;
  return Math.max(1_200, BASE_HEIGHT + rowCount * ROW_HEIGHT + (includeRounds ? 80 + roundCount * ROUND_ROW_HEIGHT : 0));
}

export function buildTeamBattleReportProjection(match: TeamBattleMatch, options: TeamBattleReportOptions): TeamBattleReportProjection {
  const fullHeight = reportHeight(match, options, true);
  if (options.detail === "full" && fullHeight > TEAM_BATTLE_REPORT_HARD_MAX_HEIGHT) {
    throw new Error("团战逐局内容过长，请改用自动或摘要报告");
  }
  const omittedRounds = options.detail === "summary"
    || (options.detail === "auto" && fullHeight > TEAM_BATTLE_REPORT_AUTO_DETAIL_MAX_HEIGHT);
  return {
    scope: options.scope,
    requestedDetail: options.detail,
    resolvedDetail: omittedRounds ? "summary" : "full",
    omittedRounds,
    ...(omittedRounds ? { omissionReason: "内容较长，已省略逐局变化，仅展示两两最终比分" } : {}),
    estimatedHeight: reportHeight(match, options, !omittedRounds),
    match: getTeamBattleProjection(match),
    ...(options.scope.kind === "player" ? { player: getPlayerReport(match, options.scope.playerId) } : {}),
  };
}

function escapeSvg(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function dateLabel(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(timestamp);
}

function clockLabel(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

function elapsedLabel(match: TeamBattleMatch) {
  const seconds = Math.floor(Math.max(0, (match.endedAt ?? match.startedAt) - match.startedAt - match.pausedDurationMs) / 1_000);
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
}

export function buildTeamBattleReport(match: TeamBattleMatch, options: TeamBattleReportOptions, theme: ReportTheme = "night") {
  const palette = REPORT_THEME_PALETTES[theme];
  const report = buildTeamBattleReportProjection(match, options);
  const rows: string[] = [];
  let y = 235;
  const text = (x: number, rowY: number, value: string, className = "row", anchor = "start") => `<text x="${x}" y="${rowY}" text-anchor="${anchor}" class="${className}">${escapeSvg(value)}</text>`;
  const section = (title: string) => { y += 42; rows.push(text(50, y, title, "section")); y += 20; };
  const row = (left: string, middle: string, right = "") => {
    rows.push(`<rect x="50" y="${y}" width="800" height="46" rx="10" fill="${Math.floor(y / ROW_HEIGHT) % 2 ? palette.surfaceAlt : palette.surface}"/>`, text(70, y + 29, left, "strong"), text(365, y + 29, middle), text(830, y + 29, right, "score", "end"));
    y += ROW_HEIGHT;
  };
  const title = report.player ? `${report.player.player.name} · 团战专项报告` : match.title || "团战战绩";
  const subtitle = `${match.players.length} 名成员 · ${report.match.rounds.length} 局 · ${report.match.pairs.length} 组实际交手 · ${elapsedLabel(match)}`;
  rows.push(`<rect width="${REPORT_WIDTH}" height="100%" fill="${palette.background}"/><circle cx="830" cy="20" r="180" fill="${palette.decoration}"/><text x="50" y="62" class="date">${escapeSvg(dateLabel(match.startedAt))}</text><text x="50" y="126" class="title">${escapeSvg(title)}</text><text x="50" y="166" class="meta">${escapeSvg(subtitle)}</text><text x="50" y="196" class="meta">${escapeSvg(match.location || "本机团战")}</text><line x1="50" y1="218" x2="850" y2="218" stroke="${palette.border}"/>`);

  if (report.player) {
    section("成员汇总");
    row(report.player.player.name, `胜 ${report.player.wins} · 负 ${report.player.losses}`, `净胜 ${report.player.differential >= 0 ? "+" : ""}${report.player.differential}`);
    section("与其他成员的最终比分");
    report.player.opponents.forEach(({ opponent, scores, played }) => row(opponent.name, played ? "已交手" : "未交手", `${scores[report.player!.player.id]} : ${scores[opponent.id]}`));
  } else {
    section("总排行");
    report.match.standings.forEach((standing) => row(`${standing.tied ? "并列 " : ""}${standing.rank} · ${standing.player.name}`, `胜 ${standing.wins} · 负 ${standing.losses} · 交手 ${standing.opponentsPlayed} 人`, `净胜 ${standing.differential >= 0 ? "+" : ""}${standing.differential}`));
    section("两两最终比分");
    if (report.match.pairs.length) report.match.pairs.forEach((pair) => row(`${pair.players[0].name} vs ${pair.players[1].name}`, `${pair.rounds.length} 局`, `${pair.scores[pair.players[0].id]} : ${pair.scores[pair.players[1].id]}`));
    else row("本场尚无实际交手", "", "0 局");
  }

  if (report.omittedRounds) {
    section("报告说明");
    row(report.omissionReason!, "", "摘要");
  } else {
    section("逐局变化");
    const rounds = report.player?.rounds ?? report.match.rounds;
    if (rounds.length) rounds.forEach((round, index) => roundRow(rows, round, match, index, y += index ? 0 : 0, theme));
    if (rounds.length) y += rounds.length * ROUND_ROW_HEIGHT;
    else row("本场尚无逐局记录", "", "0 局");
  }

  y += 55;
  const height = Math.max(1_200, y);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${REPORT_WIDTH}" height="${height}" viewBox="0 0 ${REPORT_WIDTH} ${height}" role="img" aria-label="团战比赛报告"><style>.title{font:800 42px system-ui,'Noto Sans SC';fill:${palette.strong}}.date{font:800 25px system-ui,'Noto Sans SC';fill:${palette.accent}}.meta{font:16px system-ui,'Noto Sans SC';fill:${palette.muted}}.section{font:800 22px system-ui,'Noto Sans SC';fill:${palette.strong}}.row{font:15px system-ui,'Noto Sans SC';fill:${palette.text}}.strong{font:700 15px system-ui,'Noto Sans SC';fill:${palette.strong}}.score{font:800 18px system-ui,'Noto Sans SC';fill:${palette.accent}}</style>${rows.join("")}<text x="450" y="${height - 22}" text-anchor="middle" class="meta">台球奇招 · TEAM BATTLE REPORT</text></svg>`;
}

function roundRow(rows: string[], round: EffectiveTeamBattleRound, match: TeamBattleMatch, index: number, startY: number, theme: ReportTheme) {
  const palette = REPORT_THEME_PALETTES[theme];
  const y = startY + index * ROUND_ROW_HEIGHT;
  const player = (id: string) => match.players.find((item) => item.id === id)!;
  const first = player(round.playerIds[0]);
  const second = player(round.playerIds[1]);
  const winner = player(round.winnerId);
  const note = round.note ? ` · ${round.note.slice(0, 18)}` : "";
  rows.push(`<rect x="50" y="${y}" width="800" height="52" rx="10" fill="${index % 2 ? palette.surfaceAlt : palette.surface}"/><text x="70" y="${y + 23}" class="strong">第 ${round.sequenceNo} 局 · ${escapeSvg(first.name)} vs ${escapeSvg(second.name)}</text><text x="70" y="${y + 43}" class="meta">${clockLabel(round.confirmedAt)} · ${escapeSvg(winner.name)} ${WIN_LABELS[round.winType]}${escapeSvg(note)}</text><text x="830" y="${y + 32}" text-anchor="end" class="score">${round.after[first.id] ?? 0} : ${round.after[second.id] ?? 0}</text>`);
}
