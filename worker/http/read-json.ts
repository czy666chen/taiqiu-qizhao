export class JsonBodyError extends Error {}

export async function readJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new JsonBodyError("请求必须使用 application/json");
  }
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new JsonBodyError("请求体过大");
  if (!request.body) throw new JsonBodyError("请求体不能为空");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new JsonBodyError("请求体过大");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw new JsonBodyError("请求体不是有效 JSON 对象");
  }
}
