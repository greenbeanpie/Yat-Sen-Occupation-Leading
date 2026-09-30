import type { Context } from "hono";
import type { AppEnv } from "../env";
import { invalidRequest } from "../shared/errors";

/** Bounded deterministic list pages; callers retain tenant filtering in SQL. */
export async function pageRows(c: Context<AppEnv>, sql: string, bindings: (string | number)[]) {
  const rawCursor = c.req.query("cursor") ?? "0";
  const rawLimit = c.req.query("limit") ?? "100";
  if (!/^\d+$/.test(rawCursor) || !/^\d+$/.test(rawLimit)) throw invalidRequest([{ field: "cursor/limit", issue: "分页参数必须是非负整数" }]);
  const offset = Number(rawCursor); const limit = Number(rawLimit);
  if (!Number.isSafeInteger(offset) || offset > 1_000_000 || limit < 1 || limit > 100) throw invalidRequest([{ field: "cursor/limit", issue: "cursor ≤ 1000000；limit 为 1–100" }]);
  const rows = await c.env.DB.prepare(`${sql} LIMIT ?${bindings.length + 1} OFFSET ?${bindings.length + 2}`).bind(...bindings, limit + 1, offset).all<Record<string, unknown>>();
  return { results: rows.results.slice(0, limit), nextCursor: rows.results.length > limit ? String(offset + limit) : null };
}
