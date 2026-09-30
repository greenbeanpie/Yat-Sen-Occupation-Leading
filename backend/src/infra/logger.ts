/** 脱敏日志：不记录简历正文、模型密钥、完整推送订阅（PLAN.md 组员验收）。 */
const REDACT_KEYS = ["p256dh", "auth", "endpoint", "authorization", "apiKey", "text", "description", "jdText", "quote", "filename", "displayName", "username", "company", "notes", "feedback", "password", "password_hash", "invitationCode", "token_hash", "email", "cookie", "message", "stack"];

export function logJson(level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>): void {
  const safe = data ? redact(data) : {};
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function redact(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (REDACT_KEYS.some((key) => key.toLowerCase() === k.toLowerCase())) {
      out[k] = "[redacted]";
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redact(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      out[k] = `[array:${v.length}]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}
