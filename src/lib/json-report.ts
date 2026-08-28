import { isEightBallMatch, type EightBallMatch } from "./eight-ball";
import { isStoredMatch, type BilliardsMatch } from "./match";
import { getSnookerBreakBallCounts, getSnookerBreakStats, isSnookerMatch, type SnookerBreak, type SnookerMatch } from "./snooker";

export type MatchReport = BilliardsMatch | EightBallMatch | SnookerMatch;
export type PdfJpegPage = { bytes: Uint8Array; width: number; height: number };

export function parseMatchReport(source: string): MatchReport {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("请上传战绩 JSON 文件或粘贴战绩 JSON 内容");
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); }
  catch { throw new Error("JSON 格式无效，请检查括号、引号和逗号"); }
  const candidate = parsed && typeof parsed === "object" && "match" in parsed
    ? (parsed as { match?: unknown }).match
    : parsed;
  if (isStoredMatch(candidate) || isEightBallMatch(candidate) || isSnookerMatch(candidate)) return candidate;
  throw new Error("未找到可导出的战绩，请使用战绩详情中的“JSON 备份”文件");
}

const SNOOKER_BALLS = [
  { id: "red", label: "红", fill: "#d93c4b", text: "#ffffff" },
  { id: "yellow", label: "黄", fill: "#f2c94c", text: "#172018" },
  { id: "green", label: "绿", fill: "#2f9e64", text: "#ffffff" },
  { id: "brown", label: "棕", fill: "#8b5a35", text: "#ffffff" },
  { id: "blue", label: "蓝", fill: "#3478c8", text: "#ffffff" },
  { id: "pink", label: "粉", fill: "#e884ad", text: "#172018" },
  { id: "black", label: "黑", fill: "#111815", text: "#ffffff" },
] as const;
const SNOOKER_END_LABELS = { normal: "正常结束", resignation: "认输", award: "判罚" } as const;

function escapeSvg(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function snookerReportBreaks(match: SnookerMatch): Array<{ frameNumber: number; snookerBreak: SnookerBreak }> {
  const completed = match.completedFrames.flatMap((frame) => frame.breaks.map((snookerBreak) => ({ frameNumber: frame.number, snookerBreak })));
  if (!match.currentFrame) return completed;
  const current = [...match.currentFrame.breaks, ...(match.currentFrame.currentBreak.points ? [match.currentFrame.currentBreak] : [])];
  return [...completed, ...current.map((snookerBreak) => ({ frameNumber: match.currentFrame!.number, snookerBreak }))];
}

export function buildSnookerReport(match: SnookerMatch, options: { time: boolean; trend: boolean; stats: boolean }) {
  const stats = getSnookerBreakStats(match);
  const players = match.players;
  const breaks50 = stats.breaks30Plus.filter(({ points }) => points >= 50).length;
  const breaks100 = stats.breaks30Plus.filter(({ points }) => points >= 100).length;
  const breaks20Plus = snookerReportBreaks(match).filter(({ snookerBreak }) => snookerBreak.points >= 20);
  const rows: string[] = [];
  let y = 220;
  const text = (x: number, rowY: number, value: string, className = "row", anchor = "start") => `<text x="${x}" y="${rowY}" text-anchor="${anchor}" class="${className}">${escapeSvg(value)}</text>`;
  const section = (title: string) => { y += 34; rows.push(text(50, y, title, "section")); y += 22; };
  const row = (left: string, right = "") => {
    rows.push(`<rect x="50" y="${y}" width="800" height="44" rx="10" fill="${Math.floor(y / 44) % 2 ? "#0d1b16" : "#10211a"}"/>`, text(70, y + 28, left), text(830, y + 28, right, "strong", "end"));
    y += 56;
  };
  const breakRow = (frameNumber: number, snookerBreak: SnookerBreak) => {
    const player = players.find(({ id }) => id === snookerBreak.playerId)?.name ?? "选手";
    const counts = getSnookerBreakBallCounts(snookerBreak);
    rows.push(`<rect x="50" y="${y}" width="800" height="112" rx="14" fill="#10211a" stroke="#28483a"/>`, text(70, y + 29, `${player} · 第 ${frameNumber} 局`, "strong"), text(830, y + 29, `${snookerBreak.points} 分`, "breakScore", "end"));
    rows.push(...SNOOKER_BALLS.map((ball, index) => {
      const x = 105 + index * 105;
      return `<g data-ball="${ball.id}" aria-label="${ball.label}球 ${counts[ball.id]} 颗"><circle cx="${x}" cy="${y + 67}" r="20" fill="${ball.fill}" stroke="${ball.id === "black" ? "#8ca097" : "#ffffff33"}" stroke-width="2"/><text x="${x}" y="${y + 73}" text-anchor="middle" class="ballValue" fill="${ball.text}">${counts[ball.id]}</text><text x="${x}" y="${y + 101}" text-anchor="middle" class="ballLabel">${ball.label}</text></g>`;
    }));
    y += 120;
  };
  rows.push(`<rect width="900" height="100%" fill="#07110d"/><circle cx="830" cy="20" r="180" fill="#123325"/><text x="50" y="62" class="date">${escapeSvg(new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(match.startedAt))}</text><text x="50" y="126" class="title">${escapeSvg(match.title || "斯诺克比赛")}</text><text x="50" y="164" class="score">${escapeSvg(players.map((player) => `${player.name} ${match.framesWon[player.id]}`).join(" : "))}</text><text x="50" y="198" class="meta">${escapeSvg(`${match.bestOf ? `Best of ${match.bestOf}` : "自由局"} · ${match.initialReds} 红 · ${match.location || "本地比赛"} · ${match.variant === "trick_cards" ? "奇招牌变体局" : match.initialReds === 15 ? "标准规则" : "自定义红球局"}`)}</text><line x1="50" y1="218" x2="850" y2="218" stroke="#315445"/>`);
  if (options.stats) {
    section("单杆统计");
    row(`最高单杆 ${stats.highestBreak} · 30+ ${stats.breaks30PlusCount} · 50+ ${breaks50} · 100+ ${breaks100}`, `147 ${stats.completed147} · 155 ${stats.completed155}`);
    players.forEach((player) => row(`${player.name} · 最高单杆 ${stats.highestByPlayer[player.id]}`, stats.breaks30Plus.filter(({ playerId }) => playerId === player.id).map(({ points }) => points).join("、") || "无 30+"));
  }
  if (options.trend && match.completedFrames.length) {
    const running = Object.fromEntries(players.map(({ id }) => [id, 0]));
    section("场级局分进程");
    match.completedFrames.forEach((frame) => {
      running[frame.winnerId] += 1;
      row(`第 ${frame.number} 局后`, players.map((player) => running[player.id]).join(" : "));
    });
  }
  section("每局比分");
  if (match.completedFrames.length) match.completedFrames.forEach((frame) => row(`第 ${frame.number} 局 · ${SNOOKER_END_LABELS[frame.endReason]} · 最高单杆 ${Math.max(0, ...frame.breaks.map(({ points }) => points))}`, players.map((player) => frame.scores[player.id]).join(" : ")));
  else row("比赛尚无已结束局", players.map((player) => match.currentFrame?.scores[player.id] ?? 0).join(" : "));
  section("20+ 单杆球型");
  if (breaks20Plus.length) breaks20Plus.forEach(({ frameNumber, snookerBreak }) => breakRow(frameNumber, snookerBreak));
  else row("本场暂无 20+ 单杆");
  y += 35;
  const height = Math.max(1200, y);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}" role="img" aria-label="斯诺克比赛战报"><style>.title{font:800 42px system-ui,'Noto Sans SC';fill:#f3faf6}.date{font:800 25px system-ui,'Noto Sans SC';fill:#76e6ad}.meta{font:16px system-ui,'Noto Sans SC';fill:#9cb3a8}.section{font:800 22px system-ui,'Noto Sans SC';fill:#eff8f2}.score{font:800 29px system-ui,'Noto Sans SC';fill:#76e6ad}.row{font:15px system-ui,'Noto Sans SC';fill:#dce9e1}.strong{font:700 15px system-ui,'Noto Sans SC';fill:#eff8f2}.breakScore{font:800 20px system-ui,'Noto Sans SC';fill:#76e6ad}.ballValue{font:800 16px system-ui,'Noto Sans SC'}.ballLabel{font:13px system-ui,'Noto Sans SC';fill:#9cb3a8}</style>${rows.join("")}<text x="450" y="${height - 22}" text-anchor="middle" class="meta">台球奇招 · SNOOKER MATCH REPORT</text></svg>`;
}

function svgDimensions(svg: string) {
  const width = Number(svg.match(/<svg[^>]*\bwidth="([\d.]+)"/)?.[1]);
  const height = Number(svg.match(/<svg[^>]*\bheight="([\d.]+)"/)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("战绩报告尺寸无效");
  if (height > 30_000) throw new Error("战绩过长，无法生成单张长图");
  return { width, height };
}

export async function renderReportCanvas(svg: string): Promise<HTMLCanvasElement> {
  const dimensions = svgDimensions(svg);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法生成图片");
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("战绩报告渲染失败"));
      image.src = url;
    });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally { URL.revokeObjectURL(url); }
}

export function splitReportCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement[] {
  const pageWidth = 1240;
  const pageHeight = 1754;
  const sourcePageHeight = Math.floor(canvas.width * pageHeight / pageWidth);
  const pageCount = Math.max(1, Math.ceil(canvas.height / sourcePageHeight));
  return Array.from({ length: pageCount }, (_, index) => {
    const page = document.createElement("canvas");
    page.width = pageWidth;
    page.height = pageHeight;
    const context = page.getContext("2d");
    if (!context) throw new Error("当前浏览器无法生成 PDF");
    context.fillStyle = "#07110d";
    context.fillRect(0, 0, pageWidth, pageHeight);
    const sourceY = index * sourcePageHeight;
    const sourceHeight = Math.min(sourcePageHeight, canvas.height - sourceY);
    context.drawImage(canvas, 0, sourceY, canvas.width, sourceHeight, 0, 0, pageWidth, sourceHeight * pageWidth / canvas.width);
    return page;
  });
}

function ascii(text: string): Uint8Array { return new TextEncoder().encode(text); }
function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export function buildPdf(pages: PdfJpegPage[]): Uint8Array {
  if (!pages.length) throw new Error("没有可写入 PDF 的页面");
  const objects: Uint8Array[] = [];
  const pageRefs = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ");
  objects.push(ascii("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(ascii(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`));
  pages.forEach((page, index) => {
    const pageObject = 3 + index * 3;
    const imageObject = pageObject + 1;
    const contentObject = pageObject + 2;
    const pageWidth = 595.28;
    const pageHeight = 841.89;
    objects.push(ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>`));
    objects.push(concat([ascii(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`), page.bytes, ascii("\nendstream")]));
    const commands = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ`;
    objects.push(ascii(`<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`));
  });
  const parts = [ascii("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n")];
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(parts.reduce((length, part) => length + part.length, 0));
    parts.push(ascii(`${index + 1} 0 obj\n`), object, ascii("\nendobj\n"));
  });
  const xrefOffset = parts.reduce((length, part) => length + part.length, 0);
  parts.push(ascii(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
  offsets.slice(1).forEach((offset) => parts.push(ascii(`${offset.toString().padStart(10, "0")} 00000 n \n`)));
  parts.push(ascii(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`));
  return concat(parts);
}

export function canvasJpeg(canvas: HTMLCanvasElement): PdfJpegPage {
  const data = atob(canvas.toDataURL("image/jpeg", 0.92).split(",")[1]);
  return { bytes: Uint8Array.from(data, (character) => character.charCodeAt(0)), width: canvas.width, height: canvas.height };
}

export async function renderReportPng(svg: string): Promise<Blob> {
  const canvas = await renderReportCanvas(svg);
  try {
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("长图生成失败")), "image/png"));
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

export async function renderReportPdf(svg: string): Promise<Blob> {
  const canvas = await renderReportCanvas(svg);
  try {
    const pages = splitReportCanvas(canvas).map((pageCanvas) => {
      const page = canvasJpeg(pageCanvas);
      pageCanvas.width = 1;
      pageCanvas.height = 1;
      return page;
    });
    return new Blob([buildPdf(pages) as BlobPart], { type: "application/pdf" });
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}
