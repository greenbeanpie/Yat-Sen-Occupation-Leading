import type { Env } from '../../env';
import { AiError } from './errors';

export const AI_PROVIDER_PRESETS = {
  custom: { label: '自定义 OpenAI 兼容 API', baseUrl: '' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  'opencode-zen': { label: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1' },
  'opencode-go': { label: 'OpenCode Go（请先核对套餐用途）', baseUrl: 'https://opencode.ai/zen/go/v1' },
} as const;

/** Conservative operation-only test limit for the currently verified Go model.
 * Anomaly models.dev lists its inherited output limit as 384k; we request at most 32k.
 * https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers/opencode-go/models/deepseek-v4.1-flash.toml
 */
export function careerDiagnosticTokenLimit(config: Pick<AiConfig, 'preset'|'model'>): number {
  return config.preset === 'opencode-go' && config.model === 'deepseek-v4.1-flash' ? 32768 : 0;
}
export type ProviderPreset = keyof typeof AI_PROVIDER_PRESETS;
export type AiProtocol = 'chat-completions' | 'responses' | 'messages' | 'generate-content';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface AiConfig {
  preset: ProviderPreset;
  baseUrl: string;
  model: string;
  protocol: AiProtocol;
  maxOutputTokens: number;
  timeoutMs: number;
  maxAttempts: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: ReasoningEffort;
  thinkingBudget?: number;
  headers: Record<string, string>;
  goUserAgent?: string;
  capabilities: { temperature: boolean; topP: boolean; reasoningEfforts: readonly ReasoningEffort[] };
}

// Snapshot of official endpoint tables, 2026-10-01. Unknown models fail closed;
// update this reviewed table from https://opencode.ai/docs/{go,zen}/, not prefixes.
const GO_CHAT = ['glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'longcat-2.0', 'longcat-2.5-preview-free', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.5', 'mimo-v2.5-pro', 'hy4-preview', 'hy3', 'space-bunny-free'];
const GO_MESSAGES = ['minimax-m3', 'minimax-m2.7', 'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus'];
const GO_RESPONSES = ['grok-4.7', 'grok-4.6', 'gpt-6-luna', 'gpt-5.6-luna', 'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'];
const ZEN_RESPONSES = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5', 'gpt-5-codex', 'gpt-5-nano', 'grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-build-0.1', 'muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.3-contributor-free'];
const ZEN_MESSAGES = ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus'];
const ZEN_CHAT = ['qwen3.8-max', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'minimax-m3', 'minimax-m2.7', 'minimax-m2.5', 'glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5', 'kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3', 'big-pickle', 'space-bunny-free', 'longcat-2.5-preview-free', 'mimo-v2.6-flash-free', 'mimo-v2.5-free', 'ling-3.0-flash-fin-free', 'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free'];
const BASIC_EFFORTS = ['low', 'medium', 'high'] as const;

export function boundedNumber(value: string | number | undefined, label: string, min: number, max: number, fallback?: number, integer = false): number | undefined {
  if (value === undefined || value === '') return fallback;
  const result = typeof value === 'number' ? value : Number(value);
  if ((typeof value === 'string' && !value.trim()) || !Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) {
    throw new AiError(`${label} 必须为 ${min}–${max} 范围内的${integer ? '整数' : '数值'}`, false);
  }
  return result;
}

export function protocolFor(preset: ProviderPreset, model: string): AiProtocol {
  if (preset === 'openai') return 'responses';
  if (preset === 'anthropic') return 'messages';
  if (preset === 'gemini') return 'generate-content';
  if (preset !== 'opencode-go' && preset !== 'opencode-zen') return 'chat-completions';
  if ((preset === 'opencode-go' ? GO_CHAT : ZEN_CHAT).includes(model)) return 'chat-completions';
  if ((preset === 'opencode-go' ? GO_MESSAGES : ZEN_MESSAGES).includes(model)) return 'messages';
  if ((preset === 'opencode-go' ? GO_RESPONSES : ZEN_RESPONSES).includes(model)) return 'responses';
  throw new AiError('该 OpenCode 模型尚无经过核对的协议适配；请使用文档列出的受支持模型', false);
}

export function capabilitiesFor(preset: ProviderPreset, model: string, effort?: string): AiConfig['capabilities'] {
  if (preset === 'custom') return { temperature: true, topP: true, reasoningEfforts: [] };
  if (preset === 'deepseek') {
    if (!['deepseek-flash', 'deepseek-v4-pro'].includes(model)) throw new AiError('DeepSeek 预设支持 deepseek-flash / deepseek-v4-pro；其他模型请先核对能力', false);
    return { temperature: effort === 'none', topP: effort !== 'none', reasoningEfforts: ['none', 'low', 'high', 'max'] };
  }
  if (preset === 'anthropic') {
    return { temperature: false, topP: false, reasoningEfforts: model === 'claude-opus-4-6' ? ['low', 'medium', 'high', 'max'] : [] };
  }
  if (preset === 'gemini') {
    const levels: readonly ReasoningEffort[] = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.1-pro-preview'].includes(model)
      ? BASIC_EFFORTS : ['gemini-3-flash', 'gemini-3.5-flash', 'gemini-3.6-flash'].includes(model) ? ['minimal', ...BASIC_EFFORTS] : [];
    const sampling = ['gemini-2.5-flash', 'gemini-2.5-pro'].includes(model);
    return { temperature: sampling, topP: sampling, reasoningEfforts: levels };
  }
  if (preset === 'openrouter') {
    // Explicit model metadata verified 2026-10-01; do not infer gateway
    // support from upstream model names. Require supported routing at send time.
    return { temperature: false, topP: false, reasoningEfforts: model === 'openai/gpt-5' ? ['minimal', ...BASIC_EFFORTS] : [] };
  }
  // Gateway model capability is not inferred from the underlying vendor name.
  // Endpoint support does not prove support for optional sampling/reasoning fields.
  if (preset === 'opencode-go' || preset === 'opencode-zen') return { temperature: false, topP: false, reasoningEfforts: [] };
  const openaiModel = model;
  if (['gpt-5', 'gpt-5-mini', 'gpt-5-nano'].includes(openaiModel)) {
    return { temperature: false, topP: false, reasoningEfforts: ['minimal', ...BASIC_EFFORTS] };
  }
  if (['gpt-5.1', 'gpt-6-sol', 'gpt-6-luna'].includes(openaiModel)) {
    return { temperature: effort === 'none', topP: effort === 'none', reasoningEfforts: openaiModel === 'gpt-5.1' ? ['none', ...BASIC_EFFORTS] : ['none', ...BASIC_EFFORTS, 'xhigh', 'max'] };
  }
  if (['gpt-6-astra', 'gpt-6.1-sol'].includes(openaiModel)) {
    return { temperature: false, topP: false, reasoningEfforts: [...BASIC_EFFORTS, 'xhigh', 'max'] };
  }
  if (['o3', 'o3-mini', 'o4-mini'].includes(openaiModel)) {
    return { temperature: false, topP: false, reasoningEfforts: BASIC_EFFORTS };
  }
  if (['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini'].includes(openaiModel)) {
    return { temperature: true, topP: true, reasoningEfforts: [] };
  }
  // Unknown models remain usable with provider defaults, but cannot opt into
  // parameters whose semantics/support have not been established.
  return { temperature: false, topP: false, reasoningEfforts: [] };
}

function safeHeaders(raw: string | undefined, preset: ProviderPreset): Record<string, string> {
  if (!raw?.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new AiError('AI_REQUEST_HEADERS_JSON 必须为 JSON 对象', false); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AiError('AI_REQUEST_HEADERS_JSON 必须为 JSON 对象', false);
  const headers: Record<string, string> = {};
  const allowed: Record<string, string> = { 'http-referer': 'HTTP-Referer', 'x-openrouter-title': 'X-OpenRouter-Title', 'x-title': 'X-Title' };
  for (const [name, item] of Object.entries(value)) {
    const key = name.toLowerCase();
    if (preset !== 'openrouter' || !allowed[key] || typeof item !== 'string' || !item.trim() || item.length > 200 || /[^\x20-\x7e]/.test(item) || headers[allowed[key]]) {
      throw new AiError('请求头只允许 OpenRouter 的非敏感应用归属信息；不得配置凭据、身份伪装或换行', false);
    }
    if (key === 'http-referer') {
      let url: URL;
      try { url = new URL(item); } catch { throw new AiError('HTTP-Referer 必须为公开 HTTPS 应用地址', false); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new AiError('HTTP-Referer 必须为不含凭据、查询或片段的 HTTPS 应用地址', false);
    }
    headers[allowed[key]] = item;
  }
  if (headers['X-Title'] && headers['X-OpenRouter-Title']) throw new AiError('请只配置一个 OpenRouter 应用名称请求头', false);
  return headers;
}

/** Pure, non-secret deployment config. No key, config writes, network, or logging. */
export function resolveAiConfig(env: Env): AiConfig {
  const presetValue = env.AI_PROVIDER_PRESET?.trim() || 'custom';
  if (!Object.hasOwn(AI_PROVIDER_PRESETS, presetValue)) throw new AiError('不支持的 AI_PROVIDER_PRESET', false);
  const preset = presetValue as ProviderPreset;
  const baseUrl = (env.AI_BASE_URL?.trim() || AI_PROVIDER_PRESETS[preset].baseUrl).replace(/\/+$/, '');
  if (!baseUrl) throw new AiError('AI_PROVIDER=openai 时必须配置 AI_BASE_URL', false);
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new AiError('AI_BASE_URL 必须为有效 API 根地址', false); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (preset !== 'custom' && url.protocol !== 'https:')) {
    throw new AiError('AI_BASE_URL 不得含凭据、查询或片段；供应商预设必须使用 HTTPS', false);
  }
  // Keep explicit endpoint overrides for enterprise gateways, but do not route
  // Go through a legacy custom preset that would silently omit required headers.
  if (url.hostname === 'opencode.ai' && /^\/zen\/go(?:\/|$)/.test(url.pathname) && preset !== 'opencode-go') {
    throw new AiError('OpenCode Go 地址必须选择 opencode-go 预设以启用专用协议和请求头', false);
  }
  if (preset === 'opencode-go' && url.href.replace(/\/+$/, '') !== AI_PROVIDER_PRESETS['opencode-go'].baseUrl) throw new AiError('OpenCode Go 专用身份请求头仅可发送到官方 Go API 根地址', false);
  if (/\/(chat\/completions|responses|messages)$/.test(url.pathname)) throw new AiError('AI_BASE_URL 应为 API 根地址，不含具体请求路径', false);
  const model = env.AI_MODEL?.trim();
  if (!model || model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) throw new AiError('必须配置有效 AI_MODEL', false);
  const effortValue = env.AI_REASONING_EFFORT?.trim();
  const reasoningEffort = !effortValue || effortValue === 'default' ? undefined : effortValue as ReasoningEffort;
  const capabilities = capabilitiesFor(preset, model, reasoningEffort);
  if (reasoningEffort && !capabilities.reasoningEfforts.includes(reasoningEffort)) throw new AiError('该供应商/模型不支持所选 AI_REASONING_EFFORT；请留空使用默认值', false);
  const thinkingBudget = boundedNumber(env.AI_THINKING_BUDGET, 'AI_THINKING_BUDGET', 0, 4096, undefined, true);
  if (thinkingBudget !== undefined && (preset !== 'gemini' || !['gemini-2.5-flash', 'gemini-2.5-pro'].includes(model) || reasoningEffort)) {
    throw new AiError('AI_THINKING_BUDGET 仅支持 Gemini 2.5 Flash/Pro，不能与推理强度同时设置', false);
  }
  if (thinkingBudget !== undefined && model === 'gemini-2.5-pro' && thinkingBudget < 128) throw new AiError('Gemini 2.5 Pro thinkingBudget 至少为 128，不能关闭思考', false);
  const maxOutputTokens = boundedNumber(env.AI_MAX_OUTPUT_TOKENS, 'AI_MAX_OUTPUT_TOKENS', 1, 4096, 4096, true)!;
  if (thinkingBudget !== undefined && thinkingBudget >= maxOutputTokens) throw new AiError('思考预算必须低于输出 token 上限，为正文保留空间', false);
  const explicitProtocol = env.AI_PROTOCOL?.trim() && env.AI_PROTOCOL !== 'auto' ? env.AI_PROTOCOL as AiProtocol : undefined;
  let documentedProtocol: AiProtocol | undefined;
  try { documentedProtocol = protocolFor(preset, model); }
  catch (error) { if (!explicitProtocol || !['opencode-go','opencode-zen'].includes(preset)) throw error; }
  const protocol = explicitProtocol ?? documentedProtocol!;
  const allowedProtocols: AiProtocol[] = preset === 'custom' || !documentedProtocol ? ['chat-completions', 'responses', 'messages'] : preset === 'openai' ? ['chat-completions', 'responses'] : [documentedProtocol];
  if (!allowedProtocols.includes(protocol)) throw new AiError('所选协议与供应商/模型不兼容', false);
  const temperature = boundedNumber(env.AI_TEMPERATURE, 'AI_TEMPERATURE', 0, protocol === 'messages' ? 1 : 2);
  const topP = boundedNumber(env.AI_TOP_P, 'AI_TOP_P', preset === 'deepseek' ? 0.95 : 0, 1);
  if (temperature !== undefined && !capabilities.temperature) throw new AiError('该供应商/模型或推理模式不支持 AI_TEMPERATURE；请移除此选项', false);
  if (topP !== undefined && !capabilities.topP) throw new AiError('该供应商/模型或推理模式不支持 AI_TOP_P；请移除此选项', false);
  return {
    preset, baseUrl, model, protocol, capabilities, reasoningEffort, thinkingBudget,
    temperature: temperature ?? (capabilities.temperature && preset !== 'gemini' && env.AI_DISABLE_DEFAULT_TEMPERATURE !== 'true' ? 0.2 : undefined), topP,
    maxOutputTokens,
    timeoutMs: boundedNumber(env.AI_TIMEOUT_MS, 'AI_TIMEOUT_MS', 1000, 60000, 60000, true)!,
    maxAttempts: boundedNumber(env.AI_MAX_ATTEMPTS, 'AI_MAX_ATTEMPTS', 1, 3, 3, true)!,
    headers: safeHeaders(env.AI_REQUEST_HEADERS_JSON, preset),
    ...(preset === 'opencode-go' ? { goUserAgent: validGoUserAgent(env.AI_GO_USER_AGENT) } : {}),
  };
}

export function hasConfiguredRealAi(env: Env): boolean {
  if (env.AI_PROVIDER !== 'openai' || !env.AI_API_KEY?.trim()) return false;
  try {
    const config = resolveAiConfig(env);
    const url = new URL(config.baseUrl);
    return url.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export function validGoUserAgent(value?: string): string {
  const result = value?.trim() || 'YatSenOccupationLeading/1.0';
  if (!/^YatSenOccupationLeading\/[A-Za-z0-9._-]{1,32}$/.test(result)) throw new AiError('Go User-Agent 必须使用本应用真实名称 YatSenOccupationLeading/版本号', false);
  return result;
}

export const AI_MODELS_BY_PRESET: Record<ProviderPreset, string[]> = {
  custom: [],
  openai: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5.1', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-6.1-sol'],
  anthropic: ['claude-opus-4-6'],
  gemini: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash', 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
  openrouter: ['openai/gpt-5'],
  'opencode-go': [...GO_CHAT, ...GO_MESSAGES, ...GO_RESPONSES],
  'opencode-zen': [...ZEN_CHAT, ...ZEN_MESSAGES, ...ZEN_RESPONSES],
};
