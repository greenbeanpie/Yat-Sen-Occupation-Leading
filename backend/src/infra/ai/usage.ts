export interface AiUsage { inputTokens: number|null; outputTokens: number|null; reasoningTokens: number|null }
const record = (v: unknown): Record<string,unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
const count = (v: unknown): number|null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 10000000 ? v : null;
/** Numeric whitelist only; never forwards response text, IDs, errors or arbitrary usage keys. */
export function modelUsage(body: unknown, protocol: string): AiUsage {
  const root = record(body), usage = record(protocol === 'generate-content' ? root.usageMetadata : root.usage);
  if (protocol === 'generate-content') return { inputTokens: count(usage.promptTokenCount), outputTokens: count(usage.candidatesTokenCount), reasoningTokens: count(usage.thoughtsTokenCount) };
  return { inputTokens: count(usage.prompt_tokens ?? usage.input_tokens), outputTokens: count(usage.completion_tokens ?? usage.output_tokens),
    reasoningTokens: count(record(usage.completion_tokens_details).reasoning_tokens ?? record(usage.output_tokens_details).reasoning_tokens ?? usage.reasoning_tokens) };
}
