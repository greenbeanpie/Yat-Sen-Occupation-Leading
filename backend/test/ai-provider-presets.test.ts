import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Env } from '../src/env';
import { getAiProvider, OpenAiCompatProvider } from '../src/infra/ai';
import { hasConfiguredRealAi, resolveAiConfig, type AiProtocol } from '../src/infra/ai/config';
import { APPLICATION_USER_AGENT } from '../src/infra/ai/request';

const messages = [{ role: 'system' as const, content: 'Return JSON.' }, { role: 'user' as const, content: 'fixture input' }];
const key = 'synthetic-test-key';
function env(values: Partial<Env> = {}): Env {
  return { AI_PROVIDER: 'openai', AI_BASE_URL: '', AI_MODEL: 'gpt-4.1', AI_API_KEY: key, ...values } as Env;
}
function fixture(protocol: AiProtocol): unknown {
  if (protocol === 'responses') return { status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":true}' }] }] };
  if (protocol === 'messages') return { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: '{"ok":true}' }] };
  if (protocol === 'generate-content') return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'private', thought: true }, { text: '{"ok":true}' }] } }] };
  return { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}', reasoning_content: 'private' } }] };
}
function capture(protocol: AiProtocol) {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(fixture(protocol))));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
function sent(fetch: ReturnType<typeof capture>, at = 0) {
  const [url, options] = fetch.mock.calls[at]!;
  return { url, headers: new Headers(options.headers), body: JSON.parse(options.body), options };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('operator preset persistence and compatibility', () => {
  it('round trips nonsecret env settings while preserving old custom behavior', () => {
    const old = env({ AI_MODEL: 'local-model', AI_BASE_URL: 'http://127.0.0.1:11434/v1/' });
    expect(resolveAiConfig(old)).toMatchObject({ preset: 'custom', protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:11434/v1', temperature: 0.2, maxOutputTokens: 4096, maxAttempts: 3 });
    const values = env({ AI_PROVIDER_PRESET: 'deepseek', AI_MODEL: 'deepseek-flash', AI_REASONING_EFFORT: 'low', AI_TOP_P: '0.95', AI_MAX_OUTPUT_TOKENS: '2048', AI_TIMEOUT_MS: '15000', AI_MAX_ATTEMPTS: '1' });
    const first = resolveAiConfig(values);
    expect(resolveAiConfig(JSON.parse(JSON.stringify(values)))).toEqual(first);
    expect(JSON.stringify(first)).not.toContain(key);
    expect(values.AI_API_KEY).toBe(key);
  });
  it('does not activate a real provider through preset alone or change checked-in production defaults', () => {
    expect(getAiProvider(env({ AI_PROVIDER: 'mock', AI_PROVIDER_PRESET: 'opencode-go', AI_MODEL: 'invalid' })).name).toBe('mock');
    const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    expect(config).toContain('"AI_PROVIDER": "mock"');
    expect(config).toContain('"AI_BASE_URL": ""');
    expect(config).toContain('"AI_MODEL": ""');
  });
  it('checks native provider readiness without network or relaxing HTTPS/key requirements', () => {
    const fetch = capture('messages');
    expect(hasConfiguredRealAi(env({ AI_PROVIDER_PRESET: 'anthropic', AI_MODEL: 'claude-opus-4-6' }))).toBe(true);
    expect(hasConfiguredRealAi(env({ AI_PROVIDER_PRESET: 'anthropic', AI_MODEL: 'claude-opus-4-6', AI_API_KEY: '' }))).toBe(false);
    expect(hasConfiguredRealAi(env({ AI_BASE_URL: 'http://localhost:11434/v1' }))).toBe(false);
    expect(hasConfiguredRealAi(env({ AI_PROVIDER_PRESET: 'openai', AI_MODEL: 'gpt-5', AI_TEMPERATURE: '0.2' }))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('captured provider HTTP contracts', () => {
  it('preserves legacy custom URL/auth/payload with caller temperature and config limits', async () => {
    const fetch = capture('chat-completions');
    await getAiProvider(env({ AI_BASE_URL: 'https://gateway.example/custom/v1/', AI_MODEL: 'private-model', AI_TOP_P: '0.8', AI_MAX_OUTPUT_TOKENS: '1024' })).complete(messages, { temperature: 0 });
    expect(sent(fetch).url).toBe('https://gateway.example/custom/v1/chat/completions');
    expect(sent(fetch).headers.get('authorization')).toBe(`Bearer ${key}`);
    expect(sent(fetch).headers.get('user-agent')).toBeNull();
    expect(sent(fetch).body).toEqual({ model: 'private-model', messages, max_tokens: 1024, temperature: 0, top_p: 0.8 });
    expect(sent(fetch).options.redirect).toBe('manual');
  });
  it('sends OpenAI Responses with nested reasoning and no unsupported sampling', async () => {
    const fetch = capture('responses');
    expect(await getAiProvider(env({ AI_PROVIDER_PRESET: 'openai', AI_MODEL: 'gpt-5', AI_REASONING_EFFORT: 'medium' })).complete(messages)).toBe('{"ok":true}');
    expect(sent(fetch).url).toBe('https://api.openai.com/v1/responses');
    expect(sent(fetch).body).toEqual({ model: 'gpt-5', input: messages, max_output_tokens: 4096, store: false, reasoning: { effort: 'medium' } });
  });
  it('sends supported OpenAI nonreasoning sampling without reasoning key', async () => {
    const fetch = capture('responses');
    await getAiProvider(env({ AI_PROVIDER_PRESET: 'openai', AI_TEMPERATURE: '0.7', AI_TOP_P: '0.8' })).complete(messages);
    expect(sent(fetch).body).toMatchObject({ temperature: 0.7, top_p: 0.8 });
    expect(sent(fetch).body).not.toHaveProperty('reasoning');
  });
  it.each(['none', 'low', 'high', 'max'])('sends DeepSeek effort=%s using its native toggle/effort fields', async (effort) => {
    const fetch = capture('chat-completions');
    await getAiProvider(env({ AI_PROVIDER_PRESET: 'deepseek', AI_MODEL: 'deepseek-flash', AI_REASONING_EFFORT: effort })).complete(messages);
    expect(sent(fetch).url).toBe('https://api.deepseek.com/chat/completions');
    expect(sent(fetch).body).toMatchObject({ max_tokens: 4096 });
    if (effort === 'none') {
      expect(sent(fetch).body.thinking).toEqual({ type: 'disabled' });
      expect(sent(fetch).body).not.toHaveProperty('reasoning_effort');
    } else expect(sent(fetch).body.reasoning_effort).toBe(effort);
    expect(sent(fetch).body).not.toHaveProperty('reasoning');
    if (effort !== 'none') expect(sent(fetch).body).not.toHaveProperty('temperature');
  });
  it('reports an exhausted DeepSeek reasoning/output budget without returning thought text or retrying', async () => {
    const fetch = capture('chat-completions');
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'synthetic private thought' } }], usage: { completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4096 } } })));
    await expect(getAiProvider(env({ AI_PROVIDER_PRESET: 'deepseek', AI_MODEL: 'deepseek-flash' })).complete(messages)).rejects.toThrow('token 上限');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('sends OpenRouter nested reasoning and only validated attribution headers', async () => {
    const fetch = capture('chat-completions');
    await getAiProvider(env({ AI_PROVIDER_PRESET: 'openrouter', AI_MODEL: 'openai/gpt-5', AI_REASONING_EFFORT: 'high', AI_REQUEST_HEADERS_JSON: JSON.stringify({ 'HTTP-Referer': 'https://app.example', 'X-OpenRouter-Title': 'Career Workbench' }) })).complete(messages);
    expect(sent(fetch).url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent(fetch).body).toMatchObject({ reasoning: { effort: 'high' }, provider: { require_parameters: true } });
    expect(sent(fetch).body).not.toHaveProperty('reasoning_effort');
    expect(sent(fetch).headers.get('http-referer')).toBe('https://app.example');
    expect(sent(fetch).headers.get('x-openrouter-title')).toBe('Career Workbench');
  });
  it('serializes Anthropic system/auth/adaptive effort and extracts only text', async () => {
    const fetch = capture('messages');
    expect(await getAiProvider(env({ AI_PROVIDER_PRESET: 'anthropic', AI_MODEL: 'claude-opus-4-6', AI_REASONING_EFFORT: 'high' })).complete(messages)).toBe('{"ok":true}');
    const request = sent(fetch);
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request.headers.get('x-api-key')).toBe(key);
    expect(request.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(request.headers.get('authorization')).toBeNull();
    expect(request.body).toEqual({ model: 'claude-opus-4-6', system: messages[0]!.content, messages: [messages[1]], max_tokens: 4096, thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
  });
  it('serializes Gemini native roles/system/key/effort and removes thought blocks', async () => {
    const fetch = capture('generate-content');
    expect(await getAiProvider(env({ AI_PROVIDER_PRESET: 'gemini', AI_MODEL: 'gemini-3.1-pro-preview', AI_REASONING_EFFORT: 'low' })).complete([...messages, { role: 'assistant', content: 'previous text' }])).toBe('{"ok":true}');
    const request = sent(fetch);
    expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent');
    expect(request.headers.get('x-goog-api-key')).toBe(key);
    expect(request.headers.get('authorization')).toBeNull();
    expect(request.body).toEqual({ contents: [{ role: 'user', parts: [{ text: 'fixture input' }] }, { role: 'model', parts: [{ text: 'previous text' }] }], systemInstruction: { parts: [{ text: 'Return JSON.' }] }, generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'low' } } });
  });
  it('separates Gemini2.5 numeric thinking budget from Gemini3 effort', async () => {
    const fetch = capture('generate-content');
    await getAiProvider(env({ AI_PROVIDER_PRESET: 'gemini', AI_MODEL: 'gemini-2.5-flash', AI_THINKING_BUDGET: '0' })).complete(messages);
    expect(sent(fetch).body.generationConfig).toEqual({ maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } });
  });
});

describe('OpenCode Go dedicated adapter', () => {
  it.each([
    ['glm-5.3', 'chat-completions', 'chat/completions'],
    ['minimax-m3', 'messages', 'messages'],
    ['qwen3.8-max', 'messages', 'messages'],
    ['gpt-6-luna', 'responses', 'responses'],
  ] as const)('routes %s using its exact protocol and honest identity', async (model, protocol, path) => {
    const fetch = capture(protocol);
    const provider = getAiProvider(env({ AI_PROVIDER_PRESET: 'opencode-go', AI_MODEL: model }));
    expect(await provider.complete(messages)).toBe('{"ok":true}');
    const request = sent(fetch);
    expect(request.url).toBe(`https://opencode.ai/zen/go/v1/${path}`);
    expect(request.headers.get('user-agent')).toBe(APPLICATION_USER_AGENT);
    expect(request.headers.get('user-agent')).not.toMatch(/^opencode\//i);
    expect(request.headers.get('x-opencode-session')).toMatch(/^[a-f0-9-]{36}$/);
    expect(request.headers.get(protocol === 'messages' ? 'x-api-key' : 'authorization')).toBe(protocol === 'messages' ? key : `Bearer ${key}`);
    expect(request.body).not.toHaveProperty('temperature');
    expect(request.body).not.toHaveProperty('reasoning');
  });
  it('uses separate Zen routes for MiniMax and Qwen Max', async () => {
    const fetch = capture('chat-completions');
    for (const model of ['minimax-m3', 'qwen3.8-max']) await getAiProvider(env({ AI_PROVIDER_PRESET: 'opencode-zen', AI_MODEL: model })).complete(messages);
    for (const at of [0, 1]) {
      expect(sent(fetch, at).url).toBe('https://opencode.ai/zen/v1/chat/completions');
      expect(sent(fetch, at).headers.get('x-opencode-session')).toBeNull();
    }
  });
  it('keeps the session stable across retries/turns, isolates conversations and accepts explicit opaque continuity', async () => {
    vi.useFakeTimers();
    const fetch = capture('chat-completions');
    fetch.mockImplementationOnce(async () => new Response('', { status: 429 }));
    const config = env({ AI_PROVIDER_PRESET: 'opencode-go', AI_MODEL: 'glm-5.3' });
    const provider = getAiProvider(config);
    const pending = provider.complete(messages);
    await vi.runAllTimersAsync();
    await pending;
    await provider.complete(messages);
    const first = sent(fetch).headers.get('x-opencode-session');
    expect(sent(fetch, 1).headers.get('x-opencode-session')).toBe(first);
    expect(sent(fetch, 2).headers.get('x-opencode-session')).toBe(first);
    await getAiProvider(config).complete(messages);
    expect(sent(fetch, 3).headers.get('x-opencode-session')).not.toBe(first);
    await provider.complete(messages, { sessionId: 'conversation_random_1234' });
    expect(sent(fetch, 4).headers.get('x-opencode-session')).toBe('conversation_random_1234');
  });
  it('allows an unknown Go model with an explicit protocol, omitting unverified controls', async () => {
    const fetch = capture('responses');
    await getAiProvider(env({AI_PROVIDER_PRESET:'opencode-go',AI_MODEL:'new-model-user-verified',AI_PROTOCOL:'responses'})).complete(messages);
    expect(sent(fetch).url).toBe('https://opencode.ai/zen/go/v1/responses');
    expect(sent(fetch).body).not.toHaveProperty('reasoning');
    expect(sent(fetch).body).not.toHaveProperty('temperature');
  });
  it('supports manual OpenAI Chat with the proper completion token field', async () => {
    const fetch = capture('chat-completions');
    await getAiProvider(env({AI_PROVIDER_PRESET:'openai',AI_MODEL:'gpt-5',AI_PROTOCOL:'chat-completions',AI_REASONING_EFFORT:'low'})).complete(messages);
    expect(sent(fetch).body).toMatchObject({max_completion_tokens:4096,reasoning_effort:'low'});
    expect(sent(fetch).body).not.toHaveProperty('max_tokens');
  });
  it('does not retry 403, spoof identity or expose provider errors containing secrets', async () => {
    const fetch = capture('chat-completions');
    fetch.mockImplementationOnce(async () => new Response(`denied ${key}`, { status: 403 }));
    await expect(getAiProvider(env({ AI_PROVIDER_PRESET: 'opencode-go', AI_MODEL: 'glm-5.3' })).complete(messages)).rejects.toThrow('HTTP 403');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('unsupported options and safety bounds reject before network', () => {
  it.each([
    { AI_PROVIDER_PRESET: 'unknown' },
    { AI_PROVIDER_PRESET: 'openai', AI_MODEL: 'gpt-4.1', AI_REASONING_EFFORT: 'high' },
    { AI_PROVIDER_PRESET: 'openai', AI_MODEL: 'gpt-5', AI_TEMPERATURE: '1' },
    { AI_PROVIDER_PRESET: 'openai', AI_MODEL: 'gpt-5', AI_TOP_P: '1' },
    { AI_PROVIDER_PRESET: 'openai', AI_MODEL: 'gpt-5-codex', AI_REASONING_EFFORT: 'medium' },
    { AI_PROVIDER_PRESET: 'openrouter', AI_MODEL: 'openai/o3', AI_REASONING_EFFORT: 'high' },
    { AI_PROVIDER_PRESET: 'opencode-go', AI_MODEL: 'glm-5.3', AI_REASONING_EFFORT: 'high' },
    { AI_PROVIDER_PRESET: 'opencode-go', AI_MODEL: 'unknown-model' },
    { AI_PROVIDER_PRESET: 'opencode-zen', AI_MODEL: 'gemini-3.1-pro-preview' },
    { AI_PROVIDER_PRESET: 'deepseek', AI_MODEL: 'deepseek-flash', AI_TEMPERATURE: '0' },
    { AI_PROVIDER_PRESET: 'deepseek', AI_MODEL: 'deepseek-flash', AI_TOP_P: '0.5' },
    { AI_PROVIDER_PRESET: 'deepseek', AI_MODEL: 'deepseek-flash', AI_REASONING_EFFORT: 'none', AI_TOP_P: '1' },
    { AI_PROVIDER_PRESET: 'anthropic', AI_MODEL: 'claude-opus-5', AI_REASONING_EFFORT: 'high' },
    { AI_PROVIDER_PRESET: 'gemini', AI_MODEL: 'gemini-3.1-pro-preview', AI_REASONING_EFFORT: 'minimal' },
    { AI_PROVIDER_PRESET: 'gemini', AI_MODEL: 'gemini-2.5-pro', AI_THINKING_BUDGET: '0' },
    { AI_PROVIDER_PRESET: 'gemini', AI_MODEL: 'gemini-2.5-flash', AI_THINKING_BUDGET: '4096' },
    { AI_MAX_OUTPUT_TOKENS: '4097' }, { AI_TIMEOUT_MS: '60001' }, { AI_MAX_ATTEMPTS: '4' },
    { AI_TEMPERATURE: 'NaN' }, { AI_TOP_P: '1.1' }, { AI_MAX_ATTEMPTS: '1.5' },
    { AI_BASE_URL: 'https://user:password@provider.example/v1' },
    { AI_BASE_URL: 'https://provider.example/v1?key=secret' },
    { AI_BASE_URL: 'https://provider.example/v1/chat/completions' },
    { AI_BASE_URL: 'https://opencode.ai/zen/go/v1' },
    { AI_PROVIDER_PRESET: 'openai', AI_BASE_URL: 'http://provider.example' },
  ])('rejects invalid config %j', (invalid) => {
    const fetch = capture('chat-completions');
    expect(() => getAiProvider(env({ AI_BASE_URL: 'https://provider.example/v1', ...invalid }))).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { Authorization: 'Bearer secret' }, { Cookie: 'credential' }, { 'User-Agent': 'OpenCode/1.0' },
    { 'x-opencode-session': 'global-shared-session' }, { 'x-api-key': 'secret' },
    { 'X-OpenRouter-Title': 'app\r\nX-Injected: yes' }, { 'X-Title': 123 },
    { 'HTTP-Referer': 'https://app.example/?key=secret' },
    { 'X-Title': 'a', 'x-title': 'b' },
  ])('rejects unsafe nonsecret header object %j', (headers) => {
    expect(() => resolveAiConfig(env({ AI_PROVIDER_PRESET: 'openrouter', AI_MODEL: 'openai/gpt-5', AI_REQUEST_HEADERS_JSON: JSON.stringify(headers) }))).toThrow();
  });
  it('enforces caller options and input bounds, and does not expand operator retry limit', async () => {
    const fetch = capture('responses');
    const provider = getAiProvider(env({ AI_PROVIDER_PRESET: 'openai', AI_MODEL: 'gpt-5', AI_MAX_ATTEMPTS: '1' }));
    await expect(provider.complete(messages, { temperature: 0 })).rejects.toThrow('temperature');
    await expect(provider.complete(messages, { maxAttempts: 99 })).rejects.toThrow('maxAttempts');
    await expect(provider.complete([{ role: 'user', content: 'a'.repeat(100001) }])).rejects.toThrow('100KB');
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockImplementationOnce(async () => new Response('', { status: 500 }));
    await expect(provider.complete(messages, { maxAttempts: 3 })).rejects.toThrow('HTTP 500');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['responses', { status: 'incomplete', output: [] }],
    ['messages', { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial' }] }],
    ['generate-content', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }] }],
    ['chat-completions', { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }],
  ] as const)('rejects truncated %s responses', async (protocol, response) => {
    const fetch = capture(protocol);
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify(response)));
    const values = protocol === 'responses' ? { AI_PROVIDER_PRESET: 'openai' } : protocol === 'messages' ? { AI_PROVIDER_PRESET: 'anthropic' } : protocol === 'generate-content' ? { AI_PROVIDER_PRESET: 'gemini' } : { AI_BASE_URL: 'https://custom.example/v1' };
    await expect(new OpenAiCompatProvider(env(values)).complete(messages)).rejects.toThrow('未完整');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
