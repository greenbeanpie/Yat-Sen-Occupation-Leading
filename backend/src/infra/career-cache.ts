import type { Env } from '../env';
import { AppError } from '../shared/errors';
export const SOURCE_TTL_MS = 15 * 60_000;
export async function readCareerCache<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare('SELECT payload FROM career_source_cache WHERE cache_key=?1 AND expires_at>?2').bind(key, Date.now()).first<{payload: string | null}>();
  return row?.payload ? JSON.parse(row.payload) as T : null;
}
export async function writeCareerCache(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM career_source_cache WHERE payload IS NOT NULL AND expires_at<=?1').bind(Date.now()),
    env.DB.prepare('INSERT INTO career_source_cache(cache_key,payload,expires_at) VALUES(?1,?2,?3) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at').bind(key, JSON.stringify(value), Date.now()+SOURCE_TTL_MS),
    env.DB.prepare('DELETE FROM career_source_cache WHERE payload IS NOT NULL AND cache_key NOT IN (SELECT cache_key FROM career_source_cache WHERE payload IS NOT NULL ORDER BY expires_at DESC,cache_key DESC LIMIT 100)'),
  ]);
}
/** One atomic global lease across isolates, fencing release against an expired owner. */
export async function withCareerLease<T>(env: Env, kind: 'source' | 'model', action: () => Promise<T>): Promise<T> {
  const key = `lease:${kind}`, token = crypto.randomUUID(), now=Date.now();
  const row = await env.DB.prepare(`INSERT INTO career_source_cache(cache_key,lease_until,lease_token) VALUES(?1,?2,?3)
    ON CONFLICT(cache_key) DO UPDATE SET lease_until=excluded.lease_until,lease_token=excluded.lease_token
    WHERE career_source_cache.lease_until<=?4 RETURNING lease_token`).bind(key,now+(kind==='source'?60_000:240_000),token,now).first();
  if (!row) throw new AppError(429,'career_busy','来源或模型正在处理，或处于保护冷却期，请稍后重试');
  let failed=false;
  try { return await action(); } catch(e) { failed=true; throw e; }
  finally {
    // All source failures stop requests for 15 minutes; no retry/UA rotation.
    const pause=kind==='source'?(failed?SOURCE_TTL_MS:1100):1000;
    await env.DB.prepare('UPDATE career_source_cache SET lease_until=?1,lease_token=NULL WHERE cache_key=?2 AND lease_token=?3').bind(Date.now()+pause,key,token).run();
  }
}
