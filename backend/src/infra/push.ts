import type { Env } from '../env';
import { logJson } from './logger';

export interface PushSubscription { endpoint: string; p256dh: string; auth: string }
export interface PushPayload { title: string; body: string; data: { userId: string; notificationId: string; url: string } }
const encoder = new TextEncoder();
export function base64url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
export function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error('Invalid push key');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
}
export function safePushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint); const h = url.hostname;
    return endpoint.length <= 2048 && url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
      (h === 'fcm.googleapis.com' || h === 'updates.push.services.mozilla.com' || h.endsWith('.push.services.mozilla.com') || h === 'web.push.apple.com' || h.endsWith('.notify.windows.com'));
  } catch { return false; }
}
export async function validPushKeys(p256dh: string, auth: string): Promise<boolean> {
  try {
    const pub = decodeBase64url(p256dh);
    if (pub.length !== 65 || pub[0] !== 4 || decodeBase64url(auth).length !== 16) return false;
    await crypto.subtle.importKey('raw', pub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return true;
  } catch { return false; }
}
function subject(env: Env): string { return env.VAPID_SUBJECT ?? ''; }
export function isPushConfigured(env: Env): boolean {
  try {
    const pub = decodeBase64url(env.VAPID_PUBLIC_KEY ?? '');
    const contact = new URL(subject(env));
    const jwk = JSON.parse(new TextDecoder().decode(decodeBase64url(env.VAPID_PRIVATE_KEY ?? ''))) as JsonWebKey;
    return pub.length === 65 && pub[0] === 4 && jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.d === 'string' &&
      ['https:', 'mailto:'].includes(contact.protocol);
  } catch { return false; }
}
async function hkdf(secret: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}
/** RFC 8291 / RFC 8188, one aes128gcm record. Optional inputs support the published RFC test vector. */
export async function encryptPush(payload: Uint8Array, subscription: Pick<PushSubscription, 'p256dh' | 'auth'>, fixture?: { keyPair: CryptoKeyPair; salt: Uint8Array }): Promise<Uint8Array> {
  if (payload.length > 3993) throw new Error('Push payload too large');
  const ua = decodeBase64url(subscription.p256dh); const auth = decodeBase64url(subscription.auth);
  if (ua.length !== 65 || ua[0] !== 4 || auth.length !== 16) throw new Error('Invalid push key');
  const recipient = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const pair = fixture?.keyPair ?? await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer);
  const salt = fixture?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error('Invalid push salt');
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: recipient } as unknown as SubtleCryptoDeriveKeyAlgorithm, pair.privateKey, 256));
  const ikm = await hkdf(shared, auth, join(encoder.encode('WebPush: info\0'), ua, pub), 32);
  const cek = await hkdf(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, encoder.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, join(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21); header.set(salt); new DataView(header.buffer).setUint32(16, 4096); header[20] = pub.length;
  return join(header, pub, ciphertext);
}
export interface PushSubscriptionKeys extends PushSubscription {}
export interface PushSendResult { ok: boolean; statusCode?: number }
export async function sendWebPush(env: Env, subscription: PushSubscription, payloadText: string): Promise<PushSendResult> {
  const payload = JSON.parse(payloadText) as PushPayload;
  if (!isPushConfigured(env)) return { ok: false };
  if (!safePushEndpoint(subscription.endpoint) || !/^\/(?!\/)[A-Za-z0-9/?=&_%.-]+$/.test(payload.data.url) || payload.data.url.includes('..')) throw new Error('Invalid push destination');
  const key = await crypto.subtle.importKey('jwk', JSON.parse(new TextDecoder().decode(decodeBase64url(env.VAPID_PRIVATE_KEY!))) as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const jwt = `${base64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))}.${base64url(encoder.encode(JSON.stringify({ aud: new URL(subscription.endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject(env) })))}`;
  // WebCrypto returns the JOSE-compatible 64-octet r||s signature, not DER.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(jwt)));
  if (signature.length !== 64) throw new Error('Invalid VAPID signature');
  const body = await encryptPush(encoder.encode(JSON.stringify(payload)), subscription);
  const response = await fetch(subscription.endpoint, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `vapid t=${jwt}.${base64url(signature)}, k=${env.VAPID_PUBLIC_KEY}`, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Topic: payload.data.notificationId.replaceAll('-', '').slice(0, 32) },
    body,
  });
  await response.body?.cancel();
  if (!response.ok) {
    logJson('warn', 'push_http_error', { statusCode: response.status });
    throw Object.assign(new Error('Push service rejected delivery'), { statusCode: response.status });
  }
  return { ok: true, statusCode: response.status };
}

/** 生成 VAPID 密钥对（npm run generate:vapid）。 */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const rawPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as unknown as Record<string, string>;
  return {
    publicKey: base64url(rawPublic),
    privateKey: base64url(new TextEncoder().encode(JSON.stringify(privateJwk))),
  };
}
