import type { Env } from "../env";
import { AppError } from "../shared/errors";
import { fingerprintOf } from "./db/helpers";

/** D1 atomic fixed window: shared across isolates, no raw IP stored. Edge limits remain an operator control. */
export async function rateLimit(env: Env, key: string, limit: number, seconds = 60): Promise<void> {
  const window = Math.floor(Date.now() / 1000 / seconds);
  const digest = await fingerprintOf([key]);
  const row = await env.DB.prepare(`INSERT INTO rate_limits (key, window, hits, expires_at) VALUES (?1, ?2, 1, ?3)
    ON CONFLICT(key, window) DO UPDATE SET hits = MIN(hits + 1, ?4) RETURNING hits`)
    .bind(digest, window, (window + 1) * seconds, limit + 1).first<{ hits: number }>();
  if (!row || row.hits > limit) throw new AppError(429, "rate_limited", "请求过于频繁，请稍后重试");
}
