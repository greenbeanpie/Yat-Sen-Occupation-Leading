import type { Env } from "../env";
import { AiError } from "./ai";
import { logJson } from "./logger";

/**
 * Web Push（VAPID + aes128gcm，RFC 8291 / RFC 8292）——纯 WebCrypto 实现，
 * 不依赖 Node crypto（backend_plan.md R3）。
 *
 * 密钥格式（scripts/generate-vapid.ts 生成）：
 * - VAPID_PUBLIC_KEY：未压缩 P-256 公钥（65 字节）的 base64url
 * - VAPID_PRIVATE_KEY：私钥 JWK JSON（含 kty/crv/x/y/d）的 base64url
 */

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const bytesToB64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const concatBytes = (...arrays: Uint8Array[]): Uint8Array => {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
};

/** 生成 VAPID 密钥对（npm run generate:vapid）。 */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const rawPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as unknown as Record<string, string>;
  return {
    publicKey: bytesToB64url(rawPublic),
    privateKey: bytesToB64url(new TextEncoder().encode(JSON.stringify(privateJwk))),
  };
}

/** RFC 8291 aes128gcm 加密。 */
async function encryptPayload(subscriptionPublicKeyB64: string, authSecretB64: string, payload: string): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(subscriptionPublicKeyB64);
  const authSecret = b64urlToBytes(authSecretB64);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 1. ECDH：ephemeral × uaPublic
  const ephemeral = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as unknown as CryptoKeyPair;
  const ecdhSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: ephemeral.publicKey } as never,
    ephemeral.privateKey,
    256,
  );
  const ephemeralPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer);

  // 2-3. HKDF 链：IKM → CEK / NONCE
  const keyInfo = concatBytes(new TextEncoder().encode("WebPush: info\0"), uaPublic, ephemeralPublic);
  const ikm = await hkdf(new Uint8Array(ecdhSecret), authSecret, keyInfo, 32);
  const contentEncoding = new TextEncoder().encode("Content-Encoding: aes128gcm\0");
  const cek = await hkdf(ikm, salt, concatBytes(contentEncoding, new Uint8Array([0x01])), 16);
  const nonce = await hkdf(ikm, salt, concatBytes(contentEncoding, new Uint8Array([0x02])), 12);

  // 4. AES-128-GCM（padding 定界符 0x02）
  const plaintext = concatBytes(new TextEncoder().encode(payload), new Uint8Array([0x02]));
  const key = await crypto.subtle.importKey("raw", cek as unknown as ArrayBuffer, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as unknown as ArrayBuffer, tagLength: 128 }, key, plaintext as unknown as ArrayBuffer));

  // 5. aes128gcm 块：salt(16) | rs(4) | idlen(1) | keyid | ciphertext
  const header = concatBytes(salt, new Uint8Array([0x00, 0x00, 0x10, 0x00]), new Uint8Array([ephemeralPublic.length]), ephemeralPublic);
  return concatBytes(header, ciphertext);
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as unknown as ArrayBuffer, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as unknown as ArrayBuffer, info: info as unknown as ArrayBuffer },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** RFC 8292 VAPID JWT（ES256）。 */
async function buildVapidAuthorization(env: Env, endpoint: string): Promise<string> {
  const audience = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64url(
    new TextEncoder().encode(JSON.stringify({ aud: audience, exp, sub: env.VAPID_SUBJECT || "mailto:admin@example.com" })),
  );
  const signingInput = `${header}.${claims}`;

  const jwkText = new TextDecoder().decode(b64urlToBytes(env.VAPID_PRIVATE_KEY || ""));
  const privateJwk = JSON.parse(jwkText) as JsonWebKey;
  const priv = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, new TextEncoder().encode(signingInput)));
  const raw = derToRaw(sig);
  return `${signingInput}.${bytesToB64url(raw)}`;
}

function derToRaw(der: Uint8Array): Uint8Array {
  // ECDSA 签名 DER: 0x30 len 0x02 rlen r 0x02 slen s → raw r||s（各 32 字节）
  let idx = 2;
  const rLen = der[idx + 1]!;
  const r = der.slice(idx + 2, idx + 2 + rLen);
  idx += 2 + rLen;
  const sLen = der[idx + 1]!;
  const s = der.slice(idx + 2, idx + 2 + sLen);
  const pad = (b: Uint8Array): Uint8Array => (b.length === 32 ? b : concatBytes(new Uint8Array(32 - b.length), b));
  return concatBytes(pad(r), pad(s));
}

export interface PushSendResult {
  ok: boolean;
  statusCode?: number;
}

/** 发送一条 Web Push；404/410 由调用方清理订阅。 */
export async function sendWebPush(env: Env, subscription: PushSubscriptionKeys, payload: string): Promise<PushSendResult> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    // 未配置 VAPID：推送为尽力而为，跳过（站内提醒不受影响）
    return { ok: false };
  }
  const encrypted = await encryptPayload(subscription.p256dh, subscription.auth, payload);
  const authorization = await buildVapidAuthorization(env, subscription.endpoint);
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${authorization}, k=${env.VAPID_PUBLIC_KEY}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body: encrypted as unknown as ArrayBuffer,
  });
  if (!res.ok) {
    const err = new AiError(`push endpoint returned ${res.status}`, res.status >= 500 || res.status === 429);
    (err as { statusCode?: number }).statusCode = res.status;
    logJson("warn", "push_http_error", { statusCode: res.status });
    throw err;
  }
  return { ok: true, statusCode: res.status };
}
