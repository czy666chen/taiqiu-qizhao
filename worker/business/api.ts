import type { AuthEnv } from "../auth/api";
import { requireMatchRead, requireMatchWriteLease, requireSession } from "./authorization";
import { findSession } from "../auth/session";
import { CARD_DEFINITIONS, getCardSafetyLevel, type SupportedGame } from "../../src/data/cards";
import { DECK_LIMITS, parseDeckSnapshot, type CardSafetyLevel, type DeckSnapshot, type DeckSnapshotCard } from "../../src/lib/custom-decks";

const MAX_JSON_BYTES = 64 * 1024;
const LEASE_DURATION_MS = 15 * 60 * 1000;

class BusinessValidationError extends Error {}

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.append(key, value));
  return new Response(JSON.stringify(data), { status, headers });
}

function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new BusinessValidationError("请求来源无效");
  }
}

async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new BusinessValidationError("请求必须使用 application/json");
  }
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new BusinessValidationError("请求体过大");
  if (!request.body) throw new BusinessValidationError("请求体不能为空");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BusinessValidationError("请求体过大");
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
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw new BusinessValidationError("请求体不是有效 JSON 对象");
  }
}

function stringField(body: Record<string, unknown>, name: string, maxLength = 128): string {
  const value = body[name];
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new BusinessValidationError(`${name} 无效`);
  }
  return value;
}

function integerField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new BusinessValidationError(`${name} 无效`);
  }
  return value;
}

function objectField(body: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = body[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BusinessValidationError(`${name} 无效`);
  return value as Record<string, unknown>;
}

function uuidField(body: Record<string, unknown>, name: string): string {
  const value = stringField(body, name, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BusinessValidationError(`${name} 无效`);
  }
  return value;
}

function hexDigestField(body: Record<string, unknown>, name: string): string {
  const value = stringField(body, name, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new BusinessValidationError(`${name} 无效`);
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function scopedUuid(namespace: string, value: string): Promise<string> {
  const hex = await sha256(`${namespace}\u0000${value}`);
  const bytes = Uint8Array.from(hex.slice(0, 32).match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const id = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

async function registerDevice(request: Request, env: AuthEnv): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const deviceKey = stringField(body, "deviceKey", 128);
  const name = stringField(body, "name", 80);
  const now = Date.now();
  const existing = await env.DB.prepare(
    "SELECT id FROM devices WHERE user_id = ?1 AND device_key = ?2 AND revoked_at IS NULL",
  ).bind(session.user.id, deviceKey).first<string>("id");
  const id = existing ?? crypto.randomUUID();
  if (existing) {
    await env.DB.prepare("UPDATE devices SET name = ?1, last_seen_at = ?2 WHERE id = ?3 AND user_id = ?4")
      .bind(name, now, id, session.user.id).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO devices (id, user_id, device_key, name, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    ).bind(id, session.user.id, deviceKey, name, now).run();
  }
  return json({ device: { id, deviceKey, name } }, existing ? 200 : 201);
}

async function listHistory(request: Request, env: AuthEnv): Promise<Response> {
  const session = await requireSession(env, request);
  const result = await env.DB.prepare(
    `SELECT id, mode, status, version, created_at, ended_at FROM matches
      WHERE owner_user_id = ?1
        AND NOT EXISTS (
          SELECT 1 FROM match_user_states mus
           WHERE mus.match_id = matches.id AND mus.user_id = ?1 AND mus.deleted_at IS NOT NULL
        )
     UNION
     SELECT m.id, m.mode, m.status, m.version, m.created_at, m.ended_at
       FROM match_players mp INDEXED BY match_players_user_match_idx
       JOIN matches m ON m.id = mp.match_id
      WHERE mp.user_id = ?1 AND mp.left_at IS NULL AND mp.role != 'spectator'
        AND NOT EXISTS (
          SELECT 1 FROM match_user_states mus
           WHERE mus.match_id = m.id AND mus.user_id = ?1 AND mus.deleted_at IS NOT NULL
        )
     ORDER BY ended_at DESC, created_at DESC LIMIT 100`,
  ).bind(session.user.id).all();
  return json({ matches: result.results });
}

async function listContacts(request: Request, env: AuthEnv): Promise<Response> {
  const session = await requireSession(env, request);
  const result = await env.DB.prepare(
    `SELECT pc.contact_user_id AS user_id, pc.status, pc.source, pc.last_played_at,
            p.public_code, p.nickname, p.avatar_url
       FROM player_contacts pc INDEXED BY player_contacts_owner_last_played_idx
       JOIN profiles p ON p.user_id = pc.contact_user_id
      WHERE pc.owner_user_id = ?1
      ORDER BY pc.last_played_at DESC LIMIT 100`,
  ).bind(session.user.id).all();
  return json({ contacts: result.results });
}

async function listOwned(request: Request, env: AuthEnv, resource: "presets" | "decks"): Promise<Response> {
  const session = await requireSession(env, request);
  const sql = resource === "presets"
    ? "SELECT id, name, rules_json, version, updated_at FROM score_presets WHERE owner_user_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC"
    : "SELECT id, name, visibility, current_version, updated_at FROM decks WHERE owner_user_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC";
  const result = await env.DB.prepare(sql).bind(session.user.id).all();
  return json({ [resource]: result.results });
}

function trimmedString(body: Record<string, unknown>, name: string, maxLength: number, optional = false): string | undefined {
  const value = body[name];
  if (optional && (value === undefined || value === null || value === "")) return undefined;
  if (typeof value !== "string") throw new BusinessValidationError(`${name} 无效`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new BusinessValidationError(`${name} 无效`);
  return trimmed;
}

function safetyLevel(value: unknown): CardSafetyLevel {
  if (value !== "low" && value !== "medium" && value !== "review") {
    throw new BusinessValidationError("safetyLevel 无效");
  }
  return value;
}

function supportedGames(value: unknown): SupportedGame[] {
  if (value === undefined) return ["chinese_eight"];
  if (!Array.isArray(value) || value.some((game) => game !== "chinese_eight" && game !== "snooker")) {
    throw new BusinessValidationError("supportedGames 无效");
  }
  return Array.from(new Set(["chinese_eight" as const, ...value]));
}

const customCardResult = (row: Record<string, unknown>) => ({
  ...row,
  supportedGames: ["chinese_eight", ...(Number(row.supports_snooker) ? ["snooker"] : [])],
});

async function cardCatalog(request: Request, env: AuthEnv): Promise<Response> {
  const session = await findSession(env, request);
  const custom = session ? await env.DB.prepare(
    `SELECT id, title, effect, default_quantity, safety_level, safety_note, supports_snooker, created_at, updated_at
       FROM custom_cards
      WHERE owner_user_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
  ).bind(session.user.id).all() : { results: [] };
  return json({
    officialVersion: 1,
    officialCards: CARD_DEFINITIONS.map((card) => ({
      id: card.id,
      title: card.title,
      effect: card.effect,
      count: card.count,
      safetyLevel: getCardSafetyLevel(card),
      supportedGames: card.supportedGames,
      ruleImpact: card.ruleImpact,
      ...(card.safetyNote ? { safetyNote: card.safetyNote } : {}),
    })),
    customCards: custom.results.map((row) => customCardResult(row as Record<string, unknown>)),
  });
}

async function listCustomCards(request: Request, env: AuthEnv): Promise<Response> {
  const session = await requireSession(env, request);
  const result = await env.DB.prepare(
    `SELECT id, title, effect, default_quantity, safety_level, safety_note, supports_snooker, created_at, updated_at
       FROM custom_cards WHERE owner_user_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
  ).bind(session.user.id).all();
  return json({ customCards: result.results.map((row) => customCardResult(row as Record<string, unknown>)) });
}

function customCardFields(body: Record<string, unknown>) {
  const defaultQuantity = body.defaultQuantity === undefined ? 1 : integerField(body, "defaultQuantity");
  if (defaultQuantity < 1 || defaultQuantity > DECK_LIMITS.quantityPerCard) {
    throw new BusinessValidationError("defaultQuantity 无效");
  }
  return {
    title: trimmedString(body, "title", DECK_LIMITS.cardTitle)!,
    effect: trimmedString(body, "effect", DECK_LIMITS.cardEffect)!,
    defaultQuantity,
    safetyLevel: safetyLevel(body.safetyLevel ?? "low"),
    safetyNote: trimmedString(body, "safetyNote", DECK_LIMITS.safetyNote, true) ?? null,
    supportedGames: supportedGames(body.supportedGames),
  };
}

async function createCustomCard(request: Request, env: AuthEnv): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const fields = customCardFields(body);
  const count = await env.DB.prepare(
    "SELECT count(*) AS total FROM custom_cards WHERE owner_user_id = ?1 AND deleted_at IS NULL",
  ).bind(session.user.id).first<number>("total") ?? 0;
  if (count >= DECK_LIMITS.customCardsPerUser) return json({ error: "自定义卡牌已达到上限" }, 409);
  const card = { id: crypto.randomUUID(), ...fields, createdAt: Date.now(), updatedAt: Date.now() };
  await env.DB.prepare(
    `INSERT INTO custom_cards
      (id, owner_user_id, title, effect, default_quantity, safety_level, safety_note, supports_snooker, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
  ).bind(card.id, session.user.id, fields.title, fields.effect, fields.defaultQuantity, fields.safetyLevel, fields.safetyNote, fields.supportedGames.includes("snooker") ? 1 : 0, card.createdAt).run();
  return json({ customCard: card }, 201);
}

async function updateCustomCard(request: Request, env: AuthEnv, id: string): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const fields = customCardFields(await readJson(request));
  const updatedAt = Date.now();
  const result = await env.DB.prepare(
    `UPDATE custom_cards SET title = ?1, effect = ?2, default_quantity = ?3,
       safety_level = ?4, safety_note = ?5, supports_snooker = ?6, updated_at = ?7
     WHERE id = ?8 AND owner_user_id = ?9 AND deleted_at IS NULL`,
  ).bind(fields.title, fields.effect, fields.defaultQuantity, fields.safetyLevel, fields.safetyNote, fields.supportedGames.includes("snooker") ? 1 : 0, updatedAt, id, session.user.id).run();
  if ((result.meta.changes ?? 0) !== 1) return json({ error: "自定义卡牌不存在" }, 404);
  return json({ customCard: { id, ...fields, updatedAt } });
}

async function deleteCustomCard(request: Request, env: AuthEnv, id: string): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE custom_cards SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND owner_user_id = ?3 AND deleted_at IS NULL",
  ).bind(now, id, session.user.id).run();
  if ((result.meta.changes ?? 0) !== 1) return json({ error: "自定义卡牌不存在" }, 404);
  return json({ deleted: true, id });
}

type CustomCardRow = { id: string; title: string; effect: string; safety_level: CardSafetyLevel; safety_note: string | null; supports_snooker: number };

async function canonicalDeckSnapshot(env: AuthEnv, userId: string, body: Record<string, unknown>): Promise<DeckSnapshot> {
  const name = trimmedString(body, "name", DECK_LIMITS.deckName)!;
  if (!Array.isArray(body.cards) || body.cards.length < 1 || body.cards.length > DECK_LIMITS.cardKindsPerDeck) {
    throw new BusinessValidationError("cards 无效");
  }
  const requested: Array<{ source: "official" | "custom"; definitionId: string; quantity: number }> = body.cards.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new BusinessValidationError("cards 无效");
    const card = item as Record<string, unknown>;
    if (card.source !== "official" && card.source !== "custom") throw new BusinessValidationError("cards 无效");
    const definitionId = trimmedString(card, "definitionId", 64)!;
    const quantity = integerField(card, "quantity");
    if (quantity < 1 || quantity > DECK_LIMITS.quantityPerCard) throw new BusinessValidationError("quantity 无效");
    return { source: card.source as "official" | "custom", definitionId, quantity };
  });
  if (new Set(requested.map((card) => `${card.source}:${card.definitionId}`)).size !== requested.length) {
    throw new BusinessValidationError("牌组中存在重复卡牌");
  }
  if (requested.reduce((sum, card) => sum + card.quantity, 0) > DECK_LIMITS.cardInstancesPerDeck) {
    throw new BusinessValidationError("牌组卡牌总数超过上限");
  }
  const officialIds = new Set(CARD_DEFINITIONS.map((card) => card.id));
  if (requested.some((card) => card.source === "official" && !officialIds.has(card.definitionId))) {
    throw new BusinessValidationError("官方卡牌不存在");
  }
  const customIds = requested.filter((card) => card.source === "custom").map((card) => card.definitionId);
  const customRows = customIds.length ? await env.DB.prepare(
    `SELECT id, title, effect, safety_level, safety_note, supports_snooker FROM custom_cards
      WHERE owner_user_id = ?1 AND deleted_at IS NULL AND id IN (${customIds.map((_, index) => `?${index + 2}`).join(",")})`,
  ).bind(userId, ...customIds).all<CustomCardRow>() : { results: [] as CustomCardRow[] };
  const customById = new Map(customRows.results.map((card) => [card.id, card]));
  if (customById.size !== customIds.length) throw new BusinessValidationError("自定义卡牌不存在或不属于当前账号");
  const cards: DeckSnapshotCard[] = requested.map((card): DeckSnapshotCard => {
    if (card.source === "official") {
      const definition = CARD_DEFINITIONS.find((item) => item.id === card.definitionId)!;
      return { source: "official", definitionId: card.definitionId, quantity: card.quantity, supportedGames: [...definition.supportedGames] };
    }
    const custom = customById.get(card.definitionId)!;
    return {
      source: "custom",
      definitionId: card.definitionId,
      quantity: card.quantity,
      snapshot: {
        title: custom.title,
        effect: custom.effect,
        safetyLevel: custom.safety_level,
        ...(custom.safety_note ? { safetyNote: custom.safety_note } : {}),
        supportedGames: ["chinese_eight", ...(custom.supports_snooker ? ["snooker" as const] : [])],
      },
    };
  });
  return { formatVersion: 2, name, cards };
}

async function findDeckOperation(env: AuthEnv, userId: string, operationId: string) {
  return env.DB.prepare(
    `SELECT d.id AS deck_id, d.current_version, dv.version_no
       FROM deck_versions dv JOIN decks d ON d.id = dv.deck_id
      WHERE d.owner_user_id = ?1 AND dv.operation_id = ?2`,
  ).bind(userId, operationId).first<{ deck_id: string; current_version: number; version_no: number }>();
}

async function createDeckResource(request: Request, env: AuthEnv): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const operationId = uuidField(body, "operationId");
  const duplicate = await findDeckOperation(env, session.user.id, operationId);
  if (duplicate) return json({ deck: { id: duplicate.deck_id, currentVersion: duplicate.version_no }, duplicate: true });
  const count = await env.DB.prepare("SELECT count(*) AS total FROM decks WHERE owner_user_id = ?1 AND deleted_at IS NULL")
    .bind(session.user.id).first<number>("total") ?? 0;
  if (count >= DECK_LIMITS.decksPerUser) return json({ error: "牌组已达到上限" }, 409);
  const snapshot = await canonicalDeckSnapshot(env, session.user.id, body);
  const snapshotJson = JSON.stringify(snapshot);
  const deckId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO decks (id, owner_user_id, name, current_version, created_at, updated_at) VALUES (?1, ?2, ?3, 1, ?4, ?4)",
      ).bind(deckId, session.user.id, snapshot.name, now),
      env.DB.prepare(
        `INSERT INTO deck_versions (id, deck_id, version_no, snapshot_json, checksum, operation_id, created_by_user_id, created_at)
         VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(versionId, deckId, snapshotJson, await sha256(snapshotJson), operationId, session.user.id, now),
    ]);
  } catch (error) {
    const raced = await findDeckOperation(env, session.user.id, operationId);
    if (raced) return json({ deck: { id: raced.deck_id, currentVersion: raced.version_no }, duplicate: true });
    throw error;
  }
  return json({ deck: { id: deckId, name: snapshot.name, currentVersion: 1, snapshot } }, 201);
}

async function getDeckResource(request: Request, env: AuthEnv, id: string): Promise<Response> {
  const session = await requireSession(env, request);
  const row = await env.DB.prepare(
    `SELECT d.id, d.name, d.current_version, d.updated_at, dv.snapshot_json
       FROM decks d LEFT JOIN deck_versions dv ON dv.deck_id = d.id AND dv.version_no = d.current_version
      WHERE d.id = ?1 AND d.owner_user_id = ?2 AND d.deleted_at IS NULL`,
  ).bind(id, session.user.id).first<{ id: string; name: string; current_version: number; updated_at: number; snapshot_json: string | null }>();
  return row ? json({ deck: { id: row.id, name: row.name, currentVersion: row.current_version, updatedAt: row.updated_at, snapshot: row.snapshot_json ? parseDeckSnapshot(JSON.parse(row.snapshot_json)) : null } }) : json({ error: "牌组不存在" }, 404);
}

async function saveDeckResource(request: Request, env: AuthEnv, id: string): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const operationId = uuidField(body, "operationId");
  const duplicate = await findDeckOperation(env, session.user.id, operationId);
  if (duplicate) return duplicate.deck_id === id
    ? json({ deck: { id, currentVersion: duplicate.version_no }, duplicate: true })
    : json({ error: "operationId 已被其他牌组使用" }, 409);
  const expected = integerField(body, "expectedVersion");
  const deck = await env.DB.prepare(
    "SELECT current_version FROM decks WHERE id = ?1 AND owner_user_id = ?2 AND deleted_at IS NULL",
  ).bind(id, session.user.id).first<{ current_version: number }>();
  if (!deck) return json({ error: "牌组不存在" }, 404);
  if (deck.current_version !== expected) return json({ error: "版本冲突，请先刷新", currentVersion: deck.current_version }, 409);
  const snapshot = await canonicalDeckSnapshot(env, session.user.id, body);
  const snapshotJson = JSON.stringify(snapshot);
  const nextVersion = expected + 1;
  const now = Date.now();
  let results;
  try {
    results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE decks SET name = ?1, current_version = ?2, updated_at = ?3
        WHERE id = ?4 AND owner_user_id = ?5 AND current_version = ?6 AND deleted_at IS NULL`,
    ).bind(snapshot.name, nextVersion, now, id, session.user.id, expected),
    env.DB.prepare(
      `INSERT INTO deck_versions (id, deck_id, version_no, snapshot_json, checksum, operation_id, created_by_user_id, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
        WHERE EXISTS (SELECT 1 FROM decks WHERE id = ?2 AND owner_user_id = ?7 AND current_version = ?3)`,
    ).bind(crypto.randomUUID(), id, nextVersion, snapshotJson, await sha256(snapshotJson), operationId, session.user.id, now),
    ]);
  } catch (error) {
    const raced = await findDeckOperation(env, session.user.id, operationId);
    if (raced?.deck_id === id) return json({ deck: { id, currentVersion: raced.version_no }, duplicate: true });
    throw error;
  }
  if ((results[0].meta.changes ?? 0) !== 1 || (results[1].meta.changes ?? 0) !== 1) {
    const current = await env.DB.prepare("SELECT current_version FROM decks WHERE id = ?1 AND owner_user_id = ?2")
      .bind(id, session.user.id).first<number>("current_version");
    return json({ error: "版本冲突，请先刷新", currentVersion: current }, 409);
  }
  return json({ deck: { id, name: snapshot.name, currentVersion: nextVersion, snapshot } });
}

async function deleteDeckResource(request: Request, env: AuthEnv, id: string): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE decks SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND owner_user_id = ?3 AND deleted_at IS NULL",
  ).bind(now, id, session.user.id).run();
  if ((result.meta.changes ?? 0) !== 1) return json({ error: "牌组不存在" }, 404);
  return json({ deleted: true, id });
}

async function getOwned(request: Request, env: AuthEnv, resource: "presets" | "decks", id: string): Promise<Response> {
  const session = await requireSession(env, request);
  const sql = resource === "presets"
    ? "SELECT id, name, rules_json, version, updated_at FROM score_presets WHERE id = ?1 AND owner_user_id = ?2 AND deleted_at IS NULL"
    : "SELECT id, name, visibility, current_version, updated_at FROM decks WHERE id = ?1 AND owner_user_id = ?2 AND deleted_at IS NULL";
  const row = await env.DB.prepare(sql).bind(id, session.user.id).first();
  return row ? json({ [resource.slice(0, -1)]: row }) : json({ error: "资源不存在" }, 404);
}

type Receipt = { resource_type: string; response_json: string };

async function findReceipt(env: AuthEnv, userId: string, operationId: string): Promise<Receipt | null> {
  return env.DB.prepare(
    "SELECT resource_type, response_json FROM sync_receipts WHERE user_id = ?1 AND operation_id = ?2",
  ).bind(userId, operationId).first<Receipt>();
}

function duplicateResponse(receipt: Receipt | null, resourceType: string): Response | null {
  if (!receipt) return null;
  if (receipt.resource_type !== resourceType) return json({ error: "operationId 已被其他操作使用" }, 409);
  return json(JSON.parse(receipt.response_json));
}

async function createMatch(request: Request, env: AuthEnv): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const operationId = stringField(body, "operationId", 128);
  const deviceId = stringField(body, "deviceId", 36);
  const mode = stringField(body, "mode", 40);
  const duplicate = duplicateResponse(await findReceipt(env, session.user.id, operationId), "match");
  if (duplicate) return duplicate;

  const ownsDevice = await env.DB.prepare(
    "SELECT 1 AS owned FROM devices WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL",
  ).bind(deviceId, session.user.id).first<number>("owned");
  if (!ownsDevice) return json({ error: "设备不存在" }, 404);

  const matchId = crypto.randomUUID();
  const now = Date.now();
  const response = { match: { id: matchId, mode, status: "draft", version: 0, writeLeaseDeviceId: deviceId } };
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO matches
          (id, owner_user_id, mode, status, privacy, version, write_lease_device_id, write_lease_expires_at)
         VALUES (?1, ?2, ?3, 'draft', 'private', 0, ?4, ?5)`,
      ).bind(matchId, session.user.id, mode, deviceId, now + LEASE_DURATION_MS),
      env.DB.prepare(
        `INSERT INTO sync_receipts
          (id, user_id, device_id, operation_id, resource_type, resource_id, result, response_json)
         VALUES (?1, ?2, ?3, ?4, 'match', ?5, 'accepted', ?6)`,
      ).bind(crypto.randomUUID(), session.user.id, deviceId, operationId, matchId, JSON.stringify(response)),
    ]);
  } catch (error) {
    const raced = duplicateResponse(await findReceipt(env, session.user.id, operationId), "match");
    if (raced) return raced;
    throw error;
  }
  return json(response, 201);
}

async function getMatch(request: Request, env: AuthEnv, matchId: string): Promise<Response> {
  const session = await requireSession(env, request);
  await requireMatchRead(env, session, matchId);
  const [match, players, scores, cards] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, owner_user_id, mode, status, privacy, version, snapshot_json,
              write_lease_device_id, write_lease_expires_at,
              created_at, updated_at, started_at, ended_at
         FROM matches WHERE id = ?1`,
    ).bind(matchId),
    env.DB.prepare(
      "SELECT id, seat_no, user_id, role, nickname_snapshot, joined_at, left_at FROM match_players WHERE match_id = ?1 ORDER BY seat_no",
    ).bind(matchId),
    env.DB.prepare(
      "SELECT id, operation_id, sequence_no, actor_user_id, player_id, score_delta, correction_event_id, payload_json, occurred_at FROM score_events WHERE match_id = ?1 ORDER BY sequence_no",
    ).bind(matchId),
    env.DB.prepare(
      "SELECT id, operation_id, sequence_no, actor_user_id, card_instance_snapshot_json, score_event_id, occurred_at FROM card_events WHERE match_id = ?1 ORDER BY sequence_no",
    ).bind(matchId),
  ]);
  return json({ match: match.results[0], players: players.results, scoreEvents: scores.results, cardEvents: cards.results });
}

async function deleteMatch(request: Request, env: AuthEnv, matchId: string): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const userId = session.user.id;

  // Idempotent: an existing tombstone is a successful delete, even when the
  // row was already physically removed by an earlier call.
  const tombstoned = await env.DB.prepare(
    "SELECT 1 AS deleted FROM match_user_states WHERE match_id = ?1 AND user_id = ?2 AND deleted_at IS NOT NULL",
  ).bind(matchId, userId).first<number>("deleted");
  if (tombstoned) return json({ deleted: true, matchId, alreadyDeleted: true });

  const match = await requireMatchRead(env, session, matchId);
  if (match.status === "draft" || match.status === "active") {
    return json({ error: "进行中的对局不能删除，请先结束或取消" }, 409);
  }
  const liveRoom = await env.DB.prepare(
    "SELECT 1 AS active_room FROM realtime_rooms WHERE match_id = ?1 AND status IN ('draft', 'active')",
  ).bind(matchId).first<number>("active_room");
  if (liveRoom) return json({ error: "实时房间仍在进行，请先结束对局" }, 409);

  const participant = match.owner_user_id === userId || await env.DB.prepare(
    "SELECT 1 AS participant FROM match_players WHERE match_id = ?1 AND user_id = ?2 AND left_at IS NULL AND role != 'spectator'",
  ).bind(matchId, userId).first<number>("participant");
  if (!participant) return json({ error: "无权删除此战绩" }, 403);

  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO match_user_states (match_id, user_id, deleted_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?3, ?3)
       ON CONFLICT(match_id, user_id) DO UPDATE SET
         deleted_at = excluded.deleted_at, updated_at = excluded.updated_at`,
    ).bind(matchId, userId, now),
    // Physical cleanup: only when the deleter is the owner and no other user
    // can still see the record (no active non-spectator participant that has
    // not also deleted it). Shared records and their append-only event stream
    // are kept for the remaining participants; tombstones survive the row
    // deletion so offline re-uploads cannot resurrect the record.
    env.DB.prepare(
      `DELETE FROM matches
        WHERE id = ?1 AND owner_user_id = ?2
          AND NOT EXISTS (
            SELECT 1 FROM match_players mp
             WHERE mp.match_id = ?1 AND mp.user_id IS NOT NULL AND mp.user_id <> ?2
               AND mp.left_at IS NULL AND mp.role != 'spectator'
               AND NOT EXISTS (
                 SELECT 1 FROM match_user_states mus
                  WHERE mus.match_id = ?1 AND mus.user_id = mp.user_id AND mus.deleted_at IS NOT NULL
               )
          )`,
    ).bind(matchId, userId),
  ]);
  return json({ deleted: true, matchId, physical: (results[1].meta.changes ?? 0) > 0 });
}

async function takeOverMatch(request: Request, env: AuthEnv, matchId: string): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const operationId = uuidField(body, "operationId");
  const deviceId = uuidField(body, "deviceId");
  const expectedVersion = integerField(body, "expectedVersion");

  const duplicate = duplicateResponse(await findReceipt(env, session.user.id, operationId), "lease_takeover");
  if (duplicate) return duplicate;

  const match = await requireMatchRead(env, session, matchId);
  if (match.owner_user_id !== session.user.id) return json({ error: "无权接管此对局" }, 403);
  if (match.status === "completed" || match.status === "cancelled") return json({ error: "对局已结束，不能接管" }, 409);
  if (match.version !== expectedVersion) {
    return json({ error: "版本冲突，请先恢复云端最新版本", currentVersion: match.version }, 409);
  }
  const ownsDevice = await env.DB.prepare(
    "SELECT 1 AS owned FROM devices WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL",
  ).bind(deviceId, session.user.id).first<number>("owned");
  if (!ownsDevice) return json({ error: "设备不存在" }, 404);

  const now = Date.now();
  if (match.write_lease_device_id && match.write_lease_device_id !== deviceId
    && (match.write_lease_expires_at ?? 0) >= now) {
    return json({
      error: "另一台设备仍持有主写租约",
      currentVersion: match.version,
      leaseExpiresAt: match.write_lease_expires_at,
    }, 409);
  }

  const leaseExpiresAt = now + LEASE_DURATION_MS;
  const response = { matchId, deviceId, version: match.version, leaseExpiresAt };
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE matches
            SET write_lease_device_id = ?1, write_lease_expires_at = ?2, updated_at = ?3
          WHERE id = ?4 AND owner_user_id = ?5 AND version = ?6
            AND status IN ('draft', 'active')
            AND (write_lease_device_id IS NULL OR write_lease_device_id = ?1 OR write_lease_expires_at < ?3)`,
      ).bind(deviceId, leaseExpiresAt, now, matchId, session.user.id, expectedVersion),
      env.DB.prepare(
        `INSERT INTO sync_receipts
          (id, user_id, device_id, operation_id, resource_type, resource_id, result, response_json)
         SELECT ?1, ?2, ?3, ?4, 'lease_takeover', ?5, 'accepted', ?6
          WHERE EXISTS (
            SELECT 1 FROM matches
             WHERE id = ?5 AND owner_user_id = ?2 AND write_lease_device_id = ?3
               AND write_lease_expires_at = ?7 AND version = ?8
          )`,
      ).bind(
        crypto.randomUUID(), session.user.id, deviceId, operationId, matchId,
        JSON.stringify(response), leaseExpiresAt, expectedVersion,
      ),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1 || (results[1].meta.changes ?? 0) !== 1) {
      return json({ error: "接管条件已变化，请刷新后重试" }, 409);
    }
  } catch (error) {
    const raced = duplicateResponse(await findReceipt(env, session.user.id, operationId), "lease_takeover");
    if (raced) return raced;
    throw error;
  }
  return json(response);
}

async function appendScoreEvent(request: Request, env: AuthEnv, matchId: string): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request);
  const operationId = stringField(body, "operationId", 128);
  const deviceId = stringField(body, "deviceId", 36);
  const playerId = stringField(body, "playerId", 36);
  const expectedVersion = integerField(body, "expectedVersion");
  const scoreDelta = integerField(body, "scoreDelta");
  const occurredAt = body.occurredAt === undefined ? Date.now() : integerField(body, "occurredAt");

  const duplicate = duplicateResponse(await findReceipt(env, session.user.id, operationId), "score_event");
  if (duplicate) return duplicate;
  await requireMatchWriteLease(env, session, matchId, deviceId);
  const playerExists = await env.DB.prepare(
    "SELECT 1 AS found FROM match_players WHERE id = ?1 AND match_id = ?2",
  ).bind(playerId, matchId).first<number>("found");
  if (!playerExists) return json({ error: "对局玩家不存在" }, 404);

  const eventId = crypto.randomUUID();
  const nextVersion = expectedVersion + 1;
  const response = { event: { id: eventId, operationId, sequenceNo: nextVersion, playerId, scoreDelta }, version: nextVersion };
  const now = Date.now();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO score_events
          (id, match_id, operation_id, sequence_no, actor_user_id, actor_device_id,
           player_id, score_delta, payload_json, occurred_at)
         SELECT ?1, m.id, ?2, ?3, ?4, ?5, ?6, ?7, '{}', ?8
           FROM matches m
          WHERE m.id = ?9 AND m.owner_user_id = ?4 AND m.version = ?10
            AND m.write_lease_device_id = ?5 AND m.write_lease_expires_at >= ?11
            AND m.status IN ('draft', 'active')`,
      ).bind(eventId, operationId, nextVersion, session.user.id, deviceId, playerId, scoreDelta, occurredAt, matchId, expectedVersion, now),
      env.DB.prepare(
        `UPDATE matches SET version = ?1, updated_at = ?2
          WHERE id = ?3 AND owner_user_id = ?4 AND version = ?5
            AND EXISTS (SELECT 1 FROM score_events WHERE id = ?6 AND match_id = ?3)`,
      ).bind(nextVersion, now, matchId, session.user.id, expectedVersion, eventId),
      env.DB.prepare(
        `INSERT INTO sync_receipts
          (id, user_id, device_id, operation_id, resource_type, resource_id, result, response_json)
         SELECT ?1, ?2, ?3, ?4, 'score_event', ?5, 'accepted', ?6
          WHERE EXISTS (SELECT 1 FROM score_events WHERE id = ?5 AND match_id = ?7)`,
      ).bind(crypto.randomUUID(), session.user.id, deviceId, operationId, eventId, JSON.stringify(response), matchId),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) return json({ error: "版本冲突，请刷新后重试" }, 409);
  } catch (error) {
    const raced = duplicateResponse(await findReceipt(env, session.user.id, operationId), "score_event");
    if (raced) return raced;
    throw error;
  }
  return json(response, 201);
}

type LocalMigrationKind = "preset" | "deck" | "match";

function migrationSnapshot(kind: LocalMigrationKind, snapshotJson: string): Record<string, unknown> {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(snapshotJson);
  } catch {
    throw new BusinessValidationError("snapshotJson 无效");
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new BusinessValidationError("snapshotJson 无效");
  }
  const value = snapshot as Record<string, unknown>;
  if (kind === "preset" && (typeof value.name !== "string" || !Array.isArray(value.rules))) {
    throw new BusinessValidationError("预设快照无效");
  }
  if (kind === "deck" && typeof value.name !== "string") throw new BusinessValidationError("牌组快照无效");
  if (kind === "match" && (typeof value.id !== "string" || !Array.isArray(value.players) || typeof value.mode !== "string")) {
    throw new BusinessValidationError("对局快照无效");
  }
  return value;
}

async function importLocalResource(request: Request, env: AuthEnv): Promise<Response> {
  requireSameOrigin(request);
  const session = await requireSession(env, request);
  const body = await readJson(request, 512 * 1024);
  hexDigestField(body, "batchId");
  const deviceId = uuidField(body, "deviceId");
  const item = objectField(body, "item");
  const kindValue = stringField(item, "kind", 16);
  if (kindValue !== "preset" && kindValue !== "deck" && kindValue !== "match") {
    throw new BusinessValidationError("kind 无效");
  }
  const kind: LocalMigrationKind = kindValue;
  const localId = stringField(item, "localId", 160);
  const clientResourceId = uuidField(item, "resourceId");
  const operationId = uuidField(item, "operationId");
  const snapshotJson = stringField(item, "snapshotJson", 480 * 1024);
  const checksum = hexDigestField(item, "checksum");
  if (await sha256(snapshotJson) !== checksum) throw new BusinessValidationError("快照校验和不匹配");
  const snapshot = migrationSnapshot(kind, snapshotJson);
  const resourceType = `migration_${kind}`;

  const existingReceipt = await findReceipt(env, session.user.id, operationId);
  if (existingReceipt) {
    if (existingReceipt.resource_type !== resourceType) return json({ error: "operationId 已被其他操作使用" }, 409);
    const previous = JSON.parse(existingReceipt.response_json) as Record<string, unknown>;
    return json({ ...previous, result: "duplicate" });
  }

  const ownsDevice = await env.DB.prepare(
    "SELECT 1 AS owned FROM devices WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL",
  ).bind(deviceId, session.user.id).first<number>("owned");
  if (!ownsDevice) return json({ error: "设备不存在" }, 404);

  const resourceId = await scopedUuid(`hei8-r3-cloud-${kind}`, `${session.user.id}:${clientResourceId}`);
  const response: Record<string, unknown> = { result: "accepted", kind, localId, clientResourceId, resourceId, checksum };
  const statements: D1PreparedStatement[] = [];
  const now = Date.now();
  let tombstonedMatch = false;

  if (kind === "preset") {
    const name = String(snapshot.name).trim();
    if (!name || name.length > 80) throw new BusinessValidationError("预设名称无效");
    statements.push(env.DB.prepare(
      `INSERT INTO score_presets (id, owner_user_id, name, rules_json, version, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, rules_json = excluded.rules_json,
         version = score_presets.version + 1, updated_at = excluded.updated_at
       WHERE score_presets.owner_user_id = excluded.owner_user_id`,
    ).bind(resourceId, session.user.id, name, JSON.stringify(snapshot.rules), now));
  } else if (kind === "deck") {
    const name = String(snapshot.name).trim();
    if (!name || name.length > 80) throw new BusinessValidationError("牌组名称无效");
    const versionId = await scopedUuid("hei8-r3-cloud-deck-version", `${resourceId}:1`);
    statements.push(
      env.DB.prepare(
        `INSERT INTO decks (id, owner_user_id, name, visibility, current_version, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'private', 1, ?4, ?4)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
         WHERE decks.owner_user_id = excluded.owner_user_id`,
      ).bind(resourceId, session.user.id, name, now),
      env.DB.prepare(
        `INSERT INTO deck_versions (id, deck_id, version_no, snapshot_json, checksum, created_by_user_id, created_at)
         VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json, checksum = excluded.checksum`,
      ).bind(versionId, resourceId, snapshotJson, checksum, session.user.id, now),
    );
  } else {
    // A match the user deleted must not be recreated by a re-upload (cross
    // device, offline re-sync): acknowledge the upload and keep the record
    // deleted instead of inserting it again.
    const tombstoned = await env.DB.prepare(
      "SELECT 1 AS deleted FROM match_user_states WHERE match_id = ?1 AND user_id = ?2 AND deleted_at IS NOT NULL",
    ).bind(resourceId, session.user.id).first<number>("deleted");
    if (tombstoned) {
      tombstonedMatch = true;
      response.deleted = true;
    } else {
      const players = snapshot.players as unknown[];
      if (players.length < 1 || players.length > 8) throw new BusinessValidationError("对局玩家无效");
      const status = snapshot.status === "completed" ? "completed" : "active";
      const version = Number.isSafeInteger(snapshot.matchVersion) && Number(snapshot.matchVersion) >= 0 ? Number(snapshot.matchVersion) : 0;
      const createdAt = Number.isSafeInteger(snapshot.createdAt) ? Number(snapshot.createdAt) : now;
      const startedAt = Number.isSafeInteger(snapshot.startedAt) ? Number(snapshot.startedAt) : createdAt;
      const endedAt = status === "completed" && Number.isSafeInteger(snapshot.endedAt) ? Number(snapshot.endedAt) : null;
      statements.push(env.DB.prepare(
        `INSERT INTO matches
          (id, owner_user_id, mode, status, privacy, version, write_lease_device_id, write_lease_expires_at,
           snapshot_json, snapshot_checksum, created_at, updated_at, started_at, ended_at)
         VALUES (?1, ?2, ?3, ?4, 'private', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET
           mode = excluded.mode,
           status = excluded.status,
           version = excluded.version,
           write_lease_device_id = excluded.write_lease_device_id,
           write_lease_expires_at = excluded.write_lease_expires_at,
           snapshot_json = excluded.snapshot_json,
           snapshot_checksum = excluded.snapshot_checksum,
           updated_at = excluded.updated_at,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at
         WHERE matches.owner_user_id = excluded.owner_user_id
           AND matches.status != 'completed'
           AND (excluded.status = 'completed' OR excluded.version >= matches.version)`,
      ).bind(
        resourceId, session.user.id, String(snapshot.mode).slice(0, 40), status, version,
        status === "active" ? deviceId : null, status === "active" ? now + LEASE_DURATION_MS : null,
        snapshotJson, checksum, createdAt, now, startedAt, endedAt,
      ));
      for (let seat = 0; seat < players.length; seat += 1) {
        const player = players[seat];
        if (!player || typeof player !== "object" || typeof (player as Record<string, unknown>).name !== "string") {
          throw new BusinessValidationError("对局玩家无效");
        }
        const nickname = String((player as Record<string, unknown>).name).trim();
        if (!nickname || nickname.length > 80) throw new BusinessValidationError("对局玩家无效");
        const playerId = await scopedUuid("hei8-r3-cloud-match-player", `${resourceId}:${seat}:${String((player as Record<string, unknown>).id ?? nickname)}`);
        statements.push(env.DB.prepare(
          `INSERT INTO match_players (id, match_id, seat_no, role, nickname_snapshot, joined_at)
           VALUES (?1, ?2, ?3, 'player', ?4, ?5)
           ON CONFLICT(id) DO UPDATE SET nickname_snapshot = excluded.nickname_snapshot`,
        ).bind(playerId, resourceId, seat, nickname, startedAt));
      }
    }
  }

  statements.push(env.DB.prepare(
    `INSERT INTO sync_receipts
      (id, user_id, device_id, operation_id, resource_type, resource_id, result, response_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'accepted', ?7)`,
  ).bind(crypto.randomUUID(), session.user.id, deviceId, operationId, resourceType, resourceId, JSON.stringify(response)));

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const raced = await findReceipt(env, session.user.id, operationId);
    if (raced?.resource_type === resourceType) {
      const previous = JSON.parse(raced.response_json) as Record<string, unknown>;
      return json({ ...previous, result: "duplicate" });
    }
    throw error;
  }
  return json(response, tombstonedMatch ? 200 : 201);
}

async function listReceipts(request: Request, env: AuthEnv): Promise<Response> {
  const session = await requireSession(env, request);
  const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) throw new BusinessValidationError("after 无效");
  const result = await env.DB.prepare(
    `SELECT operation_id, resource_type, resource_id, result, response_json, received_at
       FROM sync_receipts
      WHERE user_id = ?1 AND received_at > ?2
      ORDER BY received_at LIMIT 200`,
  ).bind(session.user.id, after).all();
  return json({ receipts: result.results });
}

export async function handleBusinessApiRequest(request: Request, env: AuthEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  try {
    if (pathname === "/api/devices" && request.method === "POST") return await registerDevice(request, env);
    if (pathname === "/api/history" && request.method === "GET") return await listHistory(request, env);
    if (pathname === "/api/contacts" && request.method === "GET") return await listContacts(request, env);
    if (pathname === "/api/card-catalog" && request.method === "GET") return await cardCatalog(request, env);
    if (pathname === "/api/custom-cards" && request.method === "GET") return await listCustomCards(request, env);
    if (pathname === "/api/custom-cards" && request.method === "POST") return await createCustomCard(request, env);
    if (pathname === "/api/presets" && request.method === "GET") return await listOwned(request, env, "presets");
    if (pathname === "/api/decks" && request.method === "GET") return await listOwned(request, env, "decks");
    if (pathname === "/api/decks" && request.method === "POST") return await createDeckResource(request, env);
    if (pathname === "/api/matches" && request.method === "POST") return await createMatch(request, env);
    if (pathname === "/api/migrations/local" && request.method === "POST") return await importLocalResource(request, env);
    if (pathname === "/api/sync/receipts" && request.method === "GET") return await listReceipts(request, env);

    const customCard = pathname.match(/^\/api\/custom-cards\/([0-9a-f-]{36})$/);
    if (customCard && request.method === "PATCH") return await updateCustomCard(request, env, customCard[1]);
    if (customCard && request.method === "DELETE") return await deleteCustomCard(request, env, customCard[1]);
    const owned = pathname.match(/^\/api\/(presets|decks)\/([0-9a-f-]{36})$/);
    if (owned && request.method === "GET") return owned[1] === "decks"
      ? await getDeckResource(request, env, owned[2])
      : await getOwned(request, env, "presets", owned[2]);
    if (owned?.[1] === "decks" && request.method === "PUT") return await saveDeckResource(request, env, owned[2]);
    if (owned?.[1] === "decks" && request.method === "DELETE") return await deleteDeckResource(request, env, owned[2]);
    const match = pathname.match(/^\/api\/matches\/([0-9a-f-]{36})$/);
    if (match && request.method === "GET") return await getMatch(request, env, match[1]);
    if (match && request.method === "DELETE") return await deleteMatch(request, env, match[1]);
    const scoreEvent = pathname.match(/^\/api\/matches\/([0-9a-f-]{36})\/score-events$/);
    if (scoreEvent && request.method === "POST") return await appendScoreEvent(request, env, scoreEvent[1]);
    const takeover = pathname.match(/^\/api\/matches\/([0-9a-f-]{36})\/takeover$/);
    if (takeover && request.method === "POST") return await takeOverMatch(request, env, takeover[1]);

    if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof BusinessValidationError) return json({ error: error.message }, 400);
    console.error(JSON.stringify({ level: "error", event: "business_api_failure" }));
    return json({ error: "服务器内部错误" }, 500);
  }
}
