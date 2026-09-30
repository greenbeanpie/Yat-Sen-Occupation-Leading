/**
 * 口令哈希（PLAN.md 2.1 注册/登录）：Workers 内无 bcrypt，用 WebCrypto PBKDF2-SHA256。
 * 存储格式：pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>；校验用常数时间比较。
 */
import { scrypt, timingSafeEqual as nativeEqual } from 'node:crypto';
const SCRYPT_PREFIX = 'scrypt$32768$8$3';
export const DUMMY_PASSWORD_HASH = `${SCRYPT_PREFIX}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
async function deriveScrypt(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32,
    { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key)));
}
const SCHEME = "pbkdf2-sha256";
const ITERATIONS = 600_000;
const KEY_LENGTH_BITS = 256;
const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
};

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    KEY_LENGTH_BITS,
  );
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveScrypt(password, salt);
  return `${SCRYPT_PREFIX}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > 128) return false;
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts.slice(0, 4).join('$') !== SCRYPT_PREFIX) return false;
    let saltBytes: Uint8Array; let hashBytes: Uint8Array;
    try { saltBytes = fromBase64Url(parts[4]!); hashBytes = fromBase64Url(parts[5]!); } catch { return false; }
    if (saltBytes.length !== 16 || hashBytes.length !== 32) return false;
    return nativeEqual(await deriveScrypt(password, saltBytes), hashBytes);
  }
  if (stored.split("$").length !== 4) return false;
  const [scheme, iterations, salt, hash] = stored.split("$");
  if (scheme !== SCHEME || !iterations || !salt || !hash) return false;
  const parsed = Number(iterations);
  if (!Number.isInteger(parsed) || (parsed !== 100_000 && parsed !== ITERATIONS)) return false;
  try {
    const saltBytes = fromBase64Url(salt);
    const hashBytes = fromBase64Url(hash);
    if (saltBytes.length !== 16 || hashBytes.length !== 32) return false;
  } catch { return false; }
  // Runtime KDF failures must remain service errors, never false "wrong password" results.
  const candidate = await derive(password, fromBase64Url(salt), parsed);
  return timingSafeEqual(candidate, fromBase64Url(hash));
}
