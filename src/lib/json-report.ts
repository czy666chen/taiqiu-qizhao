import { isEightBallMatch, type EightBallMatch } from "./eight-ball";
import { isStoredMatch, type BilliardsMatch } from "./match";

export type MatchReport = BilliardsMatch | EightBallMatch;
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
  if (isStoredMatch(candidate) || isEightBallMatch(candidate)) return candidate;
  throw new Error("未找到可导出的战绩，请使用战绩详情中的“JSON 备份”文件");
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
