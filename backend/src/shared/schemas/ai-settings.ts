import { z } from '@hono/zod-openapi';
export const AiPresetSchema = z.enum(['custom','openai','anthropic','gemini','deepseek','openrouter','opencode-zen','opencode-go']);
export const AiProtocolSchema = z.enum(['auto','chat-completions','responses','messages','generate-content']);
export const AiSettingsConfigSchema = z.object({
  mode: z.enum(['environment','mock','real']),
  providerPreset: AiPresetSchema,
  protocol: AiProtocolSchema,
  baseUrl: z.string().trim().max(500),
  model: z.string().trim().max(200),
  reasoningEffort: z.enum(['default','none','minimal','low','medium','high','xhigh','max']),
  thinkingBudget: z.number().int().min(0).max(4096).nullable(),
  temperature: z.number().min(0).max(2).nullable(),
  topP: z.number().min(0).max(1).nullable(),
  maxOutputTokens: z.number().int().min(1).max(4096),
  timeoutMs: z.number().int().min(1000).max(60000),
  maxAttempts: z.number().int().min(1).max(3),
  requestHeaders: z.record(z.string().max(64), z.string().max(200)),
  goUserAgent: z.string().max(80),
}).strict().openapi('AiSettingsConfig');
export type AiSettingsConfig = z.infer<typeof AiSettingsConfigSchema>;
export const AiSettingsWriteSchema = z.object({
  baseVersion: z.number().int().min(0), config: AiSettingsConfigSchema,
  apiKey: z.string().min(8).max(4096).regex(/^[\x21-\x7e]+$/).optional(),
  clearApiKey: z.boolean().optional(),
}).strict().openapi('AiSettingsWrite');
export const AiSettingsResponseSchema = z.object({
  version: z.number().int(), config: AiSettingsConfigSchema,
  credentialStatus: z.enum(['environment','not-required','missing','stored','unreadable']),
  updatedAt: z.string().nullable(),
  encryptionAvailable: z.boolean(),
  allowedHosts: z.array(z.string()),
  presets: z.array(z.object({ id: AiPresetSchema, label: z.string(), baseUrl: z.string(), models: z.array(z.object({ id: z.string(), protocol: AiProtocolSchema, temperature: z.boolean(), topP: z.boolean(), samplingWithNoneOnly: z.boolean(), reasoningEfforts: z.array(z.string()) })) })),
}).openapi('AiSettingsResponse');
export const AiSettingsTestRequestSchema = z.object({
  baseVersion: z.number().int().min(0), requestId: z.string().uuid(),
}).strict().openapi('AiSettingsTestRequest');
export const AiSettingsTestResponseSchema = z.object({
  requestId: z.string().uuid(),
  version: z.number().int().min(0), status: z.enum(['passed','failed','not_run']),
  realRequestAttempted: z.boolean(), provider: z.string().nullable(), model: z.string().nullable(), protocol: AiProtocolSchema.nullable(),
  limits: z.object({ maxRequests: z.literal(1), timeoutMs: z.number().int().min(0).max(90000), maxOutputTokens: z.number().int().min(0).max(4096), maxResponseBytes: z.literal(8192) }),
  checks: z.array(z.object({ name: z.enum(['connection','basic_response']), passed: z.boolean(), detail: z.string().max(500) })),
  error: z.object({ code: z.string(), message: z.string().max(500) }).nullable(),
}).openapi('AiSettingsTestResponse');
export type AiSettingsTestResponse = z.infer<typeof AiSettingsTestResponseSchema>;
