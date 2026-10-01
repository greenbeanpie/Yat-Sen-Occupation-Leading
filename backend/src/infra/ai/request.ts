import type { ChatMessage, CompletionOptions } from './index';
import type { AiConfig } from './config';
import { boundedNumber } from './config';
import { AiError } from './errors';

export const APPLICATION_USER_AGENT = 'YatSenOccupationLeading/1.0';

/** Protocol selection is validated before constructing any authenticated request. */
export function buildAiRequest(config: AiConfig, messages: ChatMessage[], apiKey: string | undefined, sessionId: string, opts?: CompletionOptions): { url: string; headers: Record<string, string>; body: string } {
  const temperature = boundedNumber(opts?.temperature, 'temperature', 0, 2, config.temperature);
  if (temperature !== undefined && !config.capabilities.temperature) throw new AiError('该模型不支持 temperature', false);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...config.headers };
  if (config.protocol === 'messages') {
    headers['anthropic-version'] = '2023-06-01';
    if (apiKey) headers['x-api-key'] = apiKey;
  } else if (config.protocol === 'generate-content') {
    if (apiKey) headers['x-goog-api-key'] = apiKey;
  } else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (config.preset === 'opencode-go') {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(sessionId)) throw new AiError('模型 sessionId 必须为不含个人信息的 8–128 位随机标识', false);
    headers['User-Agent'] = config.goUserAgent ?? APPLICATION_USER_AGENT;
    headers['x-opencode-session'] = sessionId;
  }
  const common: Record<string, unknown> = { model: config.model };
  if (temperature !== undefined) common.temperature = temperature;
  if (config.topP !== undefined) common.top_p = config.topP;
  let body: Record<string, unknown>;
  let path: string;
  switch (config.protocol) {
    case 'responses':
      path = 'responses';
      body = { ...common, input: messages, max_output_tokens: config.maxOutputTokens, store: false };
      if (config.reasoningEffort) body.reasoning = { effort: config.reasoningEffort };
      break;
    case 'messages': {
      path = 'messages';
      const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
      body = { ...common, messages: messages.filter(message => message.role !== 'system'), max_tokens: config.maxOutputTokens };
      if (system) body.system = system;
      if (config.reasoningEffort) {
        body.thinking = { type: 'adaptive' };
        body.output_config = { effort: config.reasoningEffort };
      }
      break;
    }
    case 'generate-content': {
      path = `models/${encodeURIComponent(config.model)}:generateContent`;
      const generationConfig: Record<string, unknown> = { maxOutputTokens: config.maxOutputTokens };
      if (temperature !== undefined) generationConfig.temperature = temperature;
      if (config.topP !== undefined) generationConfig.topP = config.topP;
      if (config.reasoningEffort) generationConfig.thinkingConfig = { thinkingLevel: config.reasoningEffort };
      if (config.thinkingBudget !== undefined) generationConfig.thinkingConfig = { thinkingBudget: config.thinkingBudget };
      const system = messages.filter(message => message.role === 'system').map(message => ({ text: message.content }));
      body = {
        contents: messages.filter(message => message.role !== 'system').map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })),
        generationConfig,
        ...(system.length ? { systemInstruction: { parts: system } } : {}),
      };
      break;
    }
    case 'chat-completions':
      path = 'chat/completions';
      body = { ...common, messages, [config.preset === 'openai' ? 'max_completion_tokens' : 'max_tokens']: config.maxOutputTokens };
      if (config.reasoningEffort) {
        // DeepSeek Chat uses a thinking toggle to disable reasoning, not effort=none.
        if (config.preset === 'deepseek' && config.reasoningEffort === 'none') body.thinking = { type: 'disabled' };
        else if (config.preset === 'openrouter') body.reasoning = { effort: config.reasoningEffort };
        else body.reasoning_effort = config.reasoningEffort;
      }
      if (config.preset === 'openrouter') body.provider = { require_parameters: true };
      break;
  }
  return { url: `${config.baseUrl}/${path}`, headers, body: JSON.stringify(body) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Never return reasoning, tools, incomplete or refused output as a completion. */
export function completionText(config: AiConfig, value: unknown): string {
  const body = record(value);
  if (!body || body.error) throw new AiError('模型响应格式错误', false);
  let content: unknown;
  if (config.protocol === 'chat-completions') {
    const first = record(Array.isArray(body.choices) ? body.choices[0] : undefined);
    if (first?.finish_reason === 'length') throw new AiError('模型未完整完成文本输出：达到 token 上限；思考 token 也占输出预算，请调整输出上限或思考强度', false);
    if (first?.finish_reason && first.finish_reason !== 'stop') throw new AiError('模型未完整完成文本输出', false);
    const message = record(first?.message);
    if (message?.refusal || message?.tool_calls || message?.function_call) throw new AiError('模型未返回可用文本', false);
    content = message?.content;
  } else if (config.protocol === 'messages') {
    if (!['end_turn', 'stop_sequence'].includes(String(body.stop_reason))) throw new AiError('模型未完整完成文本输出', false);
    const blocks = Array.isArray(body.content) ? body.content.map(record) : [];
    if (blocks.some(block => block?.type === 'tool_use' || block?.type === 'server_tool_use' || block?.type === 'refusal')) throw new AiError('模型未返回可用文本', false);
    content = blocks.filter(block => block?.type === 'text').map(block => block?.text).filter(text => typeof text === 'string').join('');
  } else if (config.protocol === 'generate-content') {
    if (record(body.promptFeedback)?.blockReason) throw new AiError('模型拒绝输出', false);
    const first = record(Array.isArray(body.candidates) ? body.candidates[0] : undefined);
    if (first?.finishReason !== 'STOP') throw new AiError('模型未完整完成文本输出', false);
    const message = record(first.content);
    const parts = Array.isArray(message?.parts) ? message.parts.map(record) : [];
    if (parts.some(part => part?.functionCall)) throw new AiError('模型未返回可用文本', false);
    content = parts.filter(part => part?.thought !== true && typeof part?.text === 'string').map(part => part?.text).join('');
  } else {
    if (body.status !== 'completed') throw new AiError('模型未完整完成文本输出', false);
    const outputs = Array.isArray(body.output) ? body.output.map(record) : [];
    if (outputs.some(item => !['message', 'reasoning'].includes(String(item?.type)) || (item?.type === 'message' && item.status && item.status !== 'completed'))) throw new AiError('模型未完整完成文本输出', false);
    const blocks = outputs.filter(item => item?.type === 'message' && item.role === 'assistant').flatMap(item => Array.isArray(item?.content) ? item.content.map(record) : []);
    if (blocks.some(block => block?.type === 'refusal')) throw new AiError('模型拒绝输出', false);
    content = blocks.filter(block => block?.type === 'output_text').map(block => block?.text).filter(text => typeof text === 'string').join('');
  }
  if (typeof content !== 'string' || !content.trim()) throw new AiError('模型响应未包含可用文本', false);
  return content;
}
