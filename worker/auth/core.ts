import { registrationUsernameError } from "../../src/lib/username-rules";

const encoder = new TextEncoder();
const RESERVED_USERNAMES = new Set([
  "admin",
  "administrator",
  "root",
  "system",
  "support",
  "staff",
  "moderator",
  "api",
]);

export const SESSION_COOKIE_NAME = "hei8_session";
export class AuthValidationError extends Error {
  constructor(
    message: string,
    readonly field: "username" | "password" | "nickname" | "request",
  ) {
    super(message);
    this.name = "AuthValidationError";
  }
}

export function normalizeUsername(input: unknown): { normalized: string; display: string } {
  if (typeof input !== "string") {
    throw new AuthValidationError("用户名格式无效", "username");
  }

  const display = input.trim();
  const normalized = display.toLowerCase();
  if (!/^[a-z0-9_]{2,24}$/.test(normalized) || RESERVED_USERNAMES.has(normalized)) {
    throw new AuthValidationError("用户名格式无效", "username");
  }

  return { normalized, display };
}

export function validateRegistrationUsername(input: unknown): { normalized: string; display: string } {
  if (typeof input !== "string") {
    throw new AuthValidationError("用户名格式无效", "username");
  }

  const display = input.trim();
  const normalized = display.toLowerCase();
  const formatError = registrationUsernameError(display);
  if (formatError) throw new AuthValidationError(formatError, "username");
  if (RESERVED_USERNAMES.has(normalized)) {
    throw new AuthValidationError("用户名格式无效", "username");
  }

  return { normalized, display };
}

export function validatePassword(input: unknown): string {
  if (typeof input !== "string" || input.length < 6 || input.length > 64) {
    throw new AuthValidationError("密码长度必须为 6 到 64 个字符", "password");
  }
  return input;
}

export function validateNickname(input: unknown, fallback: string): string {
  const nickname = input === undefined ? fallback : typeof input === "string" ? input.trim() : "";
  if (nickname.length < 1 || nickname.length > 40) {
    throw new AuthValidationError("昵称长度必须为 1 到 40 个字符", "nickname");
  }
  return nickname;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
}

export function digestPassword(key: string, normalizedUsername: string, password: string): Promise<string> {
  return hmacSha256(key, `password-v1\0${normalizedUsername}\0${password}`);
}

export function digestSession(key: string, token: string): Promise<string> {
  return hmacSha256(key, `session-v1\0${token}`);
}

export function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function timingSafeEqual(left: Uint8Array, right: Uint8Array): Promise<boolean> {
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  };
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(left, right);

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function verifySecret(provided: string, expected: string): Promise<boolean> {
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash));
}

export function parseCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function parseSessionCookie(cookieHeader: string | null): string | null {
  return parseCookie(cookieHeader, SESSION_COOKIE_NAME);
}
