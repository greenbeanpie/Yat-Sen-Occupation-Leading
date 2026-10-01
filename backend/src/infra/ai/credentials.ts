import type { Env } from '../../env';
import { AiError } from './errors';
const encoder = new TextEncoder();
const CONTEXT = 'yso:ai-settings:key:v1';
export function encryptionAvailable(env: Env): boolean {
  return !!env.SESSION_SECRET && encoder.encode(env.SESSION_SECRET).length >= 32;
}
async function encryptionKey(env: Env): Promise<CryptoKey> {
  if (!encryptionAvailable(env)) throw new AiError('安全加密未配置，无法保存模型密钥；请联系运维', false);
  const root = await crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET!), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('yso:credential-encryption:salt:v1'), info: encoder.encode(CONTEXT) }, root, { name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']);
}
function b64(value: Uint8Array): string { return btoa(String.fromCharCode(...value)); }
function bytes(value: string): Uint8Array { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
export async function encryptApiKey(env: Env, plaintext: string, binding: string, version: number): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify([CONTEXT, version, binding])), tagLength: 128 }, await encryptionKey(env), encoder.encode(plaintext));
  return JSON.stringify({ v: 1, iv: b64(iv), data: b64(new Uint8Array(data)) });
}
export async function decryptApiKey(env: Env, envelope: string, binding: string, version: number): Promise<string> {
  try {
    if (envelope.length > 7000) throw new Error('size');
    const value = JSON.parse(envelope) as Record<string, unknown>;
    if (Object.keys(value).sort().join() !== 'data,iv,v' || value.v !== 1 || typeof value.iv !== 'string' || typeof value.data !== 'string') throw new Error('shape');
    const iv = bytes(value.iv), data = bytes(value.data);
    if (iv.length !== 12 || data.length < 24 || data.length > 4112) throw new Error('size');
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify([CONTEXT, version, binding])), tagLength: 128 }, await encryptionKey(env), data);
    const result = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw);
    if (!/^[\x21-\x7e]{8,4096}$/.test(result)) throw new Error('key');
    return result;
  } catch { throw new AiError('已保存模型密钥无法解密或目标绑定不匹配，请重新输入密钥；不会改用环境密钥', false); }
}
