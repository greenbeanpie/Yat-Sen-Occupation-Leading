import type { Env } from '../../env';
import { AiSettingsConfigSchema, type AiSettingsConfig } from '../../shared/schemas/ai-settings';
import { AI_MODELS_BY_PRESET, AI_PROVIDER_PRESETS, capabilitiesFor, protocolFor, resolveAiConfig, type AiConfig, type ProviderPreset } from './config';
import { decryptApiKey, encryptionAvailable } from './credentials';
import { getAiProvider, type AiProvider } from './index';
import { AiError } from './errors';

export interface AiSettingsRow { version: number; config_json: string | null; secret_ciphertext: string | null; updated_at: string | null }
export const defaultSettings = (): AiSettingsConfig => ({ mode: 'environment', providerPreset: 'custom', protocol: 'auto', baseUrl: '', model: '', reasoningEffort: 'default', thinkingBudget: null, temperature: null, topP: null, maxOutputTokens: 4096, timeoutMs: 60000, maxAttempts: 3, requestHeaders: {}, goUserAgent: 'YatSenOccupationLeading/1.0' });
export async function readAiSettings(env: Env): Promise<AiSettingsRow | null> {
  return env.DB.prepare('SELECT version,config_json,secret_ciphertext,updated_at FROM ai_settings WHERE id=1').first<AiSettingsRow>();
}
export function rowConfig(row: AiSettingsRow | null): AiSettingsConfig {
  if (!row) throw new AiError('模型配置记录缺失，请联系运维；不会改用环境配置', false);
  if (row.version === 0 && row.config_json === null && !row.secret_ciphertext) return defaultSettings();
  try { return AiSettingsConfigSchema.parse(JSON.parse(row.config_json ?? '')); }
  catch { throw new AiError('已保存模型配置损坏，请联系超级管理员；不会改用环境配置', false); }
}
export function settingsEnv(env: Env, settings: AiSettingsConfig): Env {
  return { ...env, AI_PROVIDER: 'openai', AI_API_KEY: undefined, AI_DISABLE_DEFAULT_TEMPERATURE: 'true',
    AI_PROVIDER_PRESET: settings.providerPreset, AI_PROTOCOL: settings.protocol, AI_BASE_URL: settings.baseUrl, AI_MODEL: settings.model,
    AI_REASONING_EFFORT: settings.reasoningEffort, AI_THINKING_BUDGET: settings.thinkingBudget === null ? undefined : String(settings.thinkingBudget),
    AI_TEMPERATURE: settings.temperature === null ? undefined : String(settings.temperature), AI_TOP_P: settings.topP === null ? undefined : String(settings.topP),
    AI_MAX_OUTPUT_TOKENS: String(settings.maxOutputTokens), AI_TIMEOUT_MS: String(settings.timeoutMs), AI_MAX_ATTEMPTS: String(settings.maxAttempts),
    AI_REQUEST_HEADERS_JSON: JSON.stringify(settings.requestHeaders), AI_GO_USER_AGENT: settings.goUserAgent,
  };
}
function publicHostname(host: string): boolean {
  // IP literals, local names and non-public suffixes are deliberately unsupported
  // in web settings; legacy operator-only local env configuration is unchanged.
  return host.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(host) && host.includes('.') && !/^\d[\d.]*$/.test(host)
    && !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host) && !host.endsWith('.') && !host.includes('..');
}
export function allowedAiHosts(env: Env): string[] {
  const defaults = Object.values(AI_PROVIDER_PRESETS).map(value => value.baseUrl).filter(Boolean).map(value => new URL(value).hostname);
  const extra = (env.AI_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(publicHostname);
  return [...new Set([...defaults, ...extra])];
}
export function resolveWebConfig(env: Env, settings: AiSettingsConfig): AiConfig {
  const config = resolveAiConfig(settingsEnv(env, settings));
  // Reject encoded traversal/host tricks rather than trying to normalize them.
  if (/[%\\]/.test(config.baseUrl) || /\/(?:\.{1,2})(?:\/|$)/.test(config.baseUrl)) throw new AiError('网页 API 根地址不能包含编码或相对路径段', false);
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'https:' || url.port || !publicHostname(url.hostname) || !allowedAiHosts(env).includes(url.hostname)) {
    throw new AiError('网页模型地址须为允许列表中的公开 HTTPS 主机，使用默认端口；自定义网关请由运维设置 AI_ALLOWED_HOSTS', false);
  }
  config.baseUrl = url.href.replace(/\/+$/, '');
  return config;
}
export function credentialBinding(config: AiConfig): string {
  return JSON.stringify([config.preset, config.protocol, config.baseUrl]);
}
export async function settingsResponse(env: Env, row: AiSettingsRow | null) {
  const config = rowConfig(row);
  let credentialStatus: 'environment'|'not-required'|'missing'|'stored'|'unreadable' = config.mode === 'environment' ? 'environment' : config.mode === 'mock' ? 'not-required' : 'missing';
  if (config.mode === 'real' && row?.secret_ciphertext) {
    try { const resolved = resolveWebConfig(env, config); await decryptApiKey(env, row.secret_ciphertext, credentialBinding(resolved), row.version); credentialStatus = 'stored'; }
    catch { credentialStatus = 'unreadable'; }
  }
  return { version: row?.version ?? 0, config, credentialStatus, updatedAt: row?.updated_at ?? null, encryptionAvailable: encryptionAvailable(env), allowedHosts: allowedAiHosts(env),
    presets: (Object.entries(AI_PROVIDER_PRESETS) as [ProviderPreset, typeof AI_PROVIDER_PRESETS[ProviderPreset]][]).map(([id, value]) => ({ id, ...value,
      models: AI_MODELS_BY_PRESET[id].map(model => { const caps = capabilitiesFor(id, model); return { id: model, protocol: protocolFor(id,model), ...caps, samplingWithNoneOnly: capabilitiesFor(id,model,'none').temperature && !caps.temperature }; }),
    })),
  };
}

/** Reads the saved row for every operation. Never falls back after key/config failure. */
export async function runtimeAiEnv(env: Env, userId?: string): Promise<Env> {
  if (userId) {
    const user = await env.DB.prepare('SELECT is_demo FROM users WHERE id=?1 AND deleted=0 AND disabled=0').bind(userId).first<{is_demo:number}>();
    if (!user) throw new AiError('账户状态不可用', false);
    if (user.is_demo === 1) return { ...env, AI_PROVIDER: 'mock', AI_API_KEY: undefined };
  }
  const row = await readAiSettings(env);
  const settings = rowConfig(row);
  if (settings.mode === 'environment') return env;
  if (settings.mode === 'mock') return { ...env, AI_PROVIDER: 'mock', AI_API_KEY: undefined };
  const resolved = resolveWebConfig(env, settings);
  if (!row?.secret_ciphertext) throw new AiError('网页模型配置缺少密钥，请联系超级管理员；不会改用环境密钥', false);
  const apiKey = await decryptApiKey(env, row.secret_ciphertext, credentialBinding(resolved), row.version);
  return { ...settingsEnv(env, settings), AI_BASE_URL: resolved.baseUrl, AI_API_KEY: apiKey };
}
export async function getConfiguredAiProvider(env: Env, userId: string, conversationId?: string): Promise<AiProvider> {
  const provider = getAiProvider(await runtimeAiEnv(env, userId));
  if (!conversationId) return provider;
  // Operation IDs are random UUIDs, not user identifiers. Reuse across workflow
  // retries as well as HTTP retries, including when a provider is reconstructed.
  return { name: provider.name, supportsTemperature: provider.supportsTemperature,
    complete: (messages, options) => provider.complete(messages, { ...options, sessionId: options?.sessionId ?? conversationId }),
  };
}

