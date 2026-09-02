import { digestSession } from "./core";

type RateLimitEnv = { DB: D1Database; SESSION_HMAC_KEY: string };

async function bucketKey(env: RateLimitEnv, request: Request, scope: string, subject: string): Promise<string> {
  const source = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return digestSession(env.SESSION_HMAC_KEY, `rate-limit-v1\u0000${scope}\u0000${subject}\u0000${source}`);
}

export async function reserveRateLimit(
  env: RateLimitEnv,
  request: Request,
  scope: string,
  subject: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; key: string }> {
  const key = await bucketKey(env, request, scope, subject);
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO auth_rate_limits (bucket_key, window_started_at, attempts)
     VALUES (?1, ?2, 1)
     ON CONFLICT(bucket_key) DO UPDATE SET
       attempts = CASE WHEN auth_rate_limits.window_started_at <= ?3 THEN 1 ELSE auth_rate_limits.attempts + 1 END,
       window_started_at = CASE WHEN auth_rate_limits.window_started_at <= ?3 THEN ?2 ELSE auth_rate_limits.window_started_at END
     RETURNING attempts`,
  ).bind(key, now, now - windowMs).first<{ attempts: number }>();
  return { allowed: (row?.attempts ?? limit + 1) <= limit, key };
}

export async function clearRateLimit(env: RateLimitEnv, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM auth_rate_limits WHERE bucket_key = ?1").bind(key).run();
}
