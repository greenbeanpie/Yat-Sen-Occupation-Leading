import { DEFAULT_TIMEZONE } from "./constants";

export const nowIso = (): string => new Date().toISOString();

export const uuid = (): string => crypto.randomUUID();

/**
 * 计算“用户时区某日的 09:00”对应的 UTC 时间（ISO）。
 * 使用 Intl 反推偏移量；workerd/Node 均支持 IANA 时区。
 */
export function zonedMorningUtc(dateYmd: string, tz: string = DEFAULT_TIMEZONE, hour = 9): string {
  const naive = `${dateYmd}T${String(hour).padStart(2, "0")}:00:00`;
  return zonedToUtc(naive, tz);
}

/** 把“不带时区的本地时间字符串”按 tz 转成真实 UTC ISO。 */
export function zonedToUtc(naiveLocal: string, tz: string): string {
  const guess = new Date(`${naiveLocal}Z`);
  const offsetMinutes = tzOffsetMinutes(guess, tz);
  let result = new Date(guess.getTime() - offsetMinutes * 60_000);
  // DST 边界修正一次
  const corrected = tzOffsetMinutes(result, tz);
  if (corrected !== offsetMinutes) {
    result = new Date(guess.getTime() - corrected * 60_000);
  }
  return result.toISOString();
}

function tzOffsetMinutes(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** UTC ISO 的“用户时区日期”（YYYY-MM-DD）。 */
export function zonedDateOf(instantIso: string, tz: string = DEFAULT_TIMEZONE): string {
  const d = new Date(instantIso);
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(d);
}

export const addMinutesIso = (iso: string, minutes: number): string =>
  new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
