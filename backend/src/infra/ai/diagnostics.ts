import { z } from '@hono/zod-openapi';
import type { Env } from '../../env';
import { AI_MODELS_BY_PRESET, type AiProtocol, type ProviderPreset } from './config';

export const DiagnosticStage = z.enum(['config_validated','dispatch','response','parse','end']);
export const DiagnosticCode = z.enum(['ok','mock_mode','timeout','network_error','output_limit','provider_http','invalid_response','invalid_configuration','internal_error']);
export const DiagnosticEventSchema = z.object({
  requestId: z.string().uuid(), time: z.string().max(30), stage: DiagnosticStage, code: DiagnosticCode,
  provider: z.enum(['custom','openai','anthropic','gemini','deepseek','openrouter','opencode-zen','opencode-go','mock','unknown']),
  model: z.string().max(80), protocol: z.enum(['chat-completions','responses','messages','generate-content','none']),
  elapsedMs: z.number().int().min(0).max(600000), attempt: z.number().int().min(0).max(3),
  httpStatus: z.number().int().min(100).max(599).nullable(), timeoutMs: z.number().int().min(0).max(90000), maxOutputTokens: z.number().int().min(0).max(4096),
}).strict().openapi('AiDiagnosticEvent');
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;
export interface DiagnosticInput {
  requestId: string; stage: DiagnosticEvent['stage']; code: DiagnosticEvent['code']; provider?: ProviderPreset|'mock';
  model?: string; protocol?: AiProtocol; elapsedMs?: number; attempt?: number; httpStatus?: number;
  timeoutMs?: number; maxOutputTokens?: number;
}
const bounded = (value: number|undefined, max: number) => Number.isFinite(value) ? Math.max(0,Math.min(max,Math.floor(value!))) : 0;
/** No text/header/URL/error passthrough. Unknown user-selected model identifiers are not logged. */
export async function writeAiDiagnostic(env: Env, input: DiagnosticInput): Promise<boolean> {
  try {
    const preset = input.provider && Object.hasOwn(AI_MODELS_BY_PRESET,input.provider) ? input.provider as ProviderPreset : null;
    const model = preset && input.model && AI_MODELS_BY_PRESET[preset].includes(input.model) ? input.model.slice(0,80) : input.model ? '(unlisted)' : '';
    const event = DiagnosticEventSchema.parse({
      requestId: z.string().uuid().safeParse(input.requestId).success ? input.requestId : crypto.randomUUID(),
      time: new Date().toISOString(), stage: input.stage, code: input.code, provider: input.provider ?? 'unknown', model,
      protocol: input.protocol ?? 'none', elapsedMs: bounded(input.elapsedMs,600000), attempt: bounded(input.attempt,3),
      httpStatus: input.httpStatus && input.httpStatus>=100 && input.httpStatus<=599 ? Math.floor(input.httpStatus) : null,
      timeoutMs: bounded(input.timeoutMs,90000), maxOutputTokens: bounded(input.maxOutputTokens,4096),
    });
    const payload = JSON.stringify(event), bytes = new TextEncoder().encode(payload).length;
    // D1 batch is one transaction: concurrent writers cannot expose an untrimmed committed tail.
    await env.DB.batch([
      env.DB.prepare('INSERT INTO ai_diagnostics(created_at,event_json,bytes) VALUES(?1,?2,?3)').bind(event.time,payload,bytes),
      env.DB.prepare(`DELETE FROM ai_diagnostics WHERE seq IN (
        SELECT seq FROM (SELECT seq,ROW_NUMBER() OVER(ORDER BY seq DESC) AS n,
        SUM(bytes) OVER(ORDER BY seq DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS retained_bytes FROM ai_diagnostics)
        WHERE n>1000 OR retained_bytes>1000000)`),
    ]);
    return true;
  } catch { return false; } // Logging failure never replaces the provider/business outcome.
}
export const AiDiagnosticsResponseSchema = z.object({
  items: z.array(z.object({ seq: z.number().int(), event: DiagnosticEventSchema })), nextBeforeSeq: z.number().int().nullable(),
  retainedCount: z.number().int(), retainedBytes: z.number().int(), maxEntries: z.literal(1000), maxBytes: z.literal(1000000),
}).openapi('AiDiagnosticsResponse');
export async function readAiDiagnostics(env: Env, beforeSeq: number|undefined, limit: number) {
  const rows = await env.DB.prepare('SELECT seq,event_json FROM ai_diagnostics WHERE (?1 IS NULL OR seq<?1) ORDER BY seq DESC LIMIT ?2').bind(beforeSeq??null,limit+1).all<{seq:number;event_json:string}>();
  const page = rows.results.slice(0,limit);
  const items = page.flatMap(row=>{try{const parsed=DiagnosticEventSchema.safeParse(JSON.parse(row.event_json));return parsed.success?[{seq:row.seq,event:parsed.data}]:[];}catch{return [];}});
  const stats = await env.DB.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM ai_diagnostics').first<{n:number;bytes:number}>();
  return { items, nextBeforeSeq: rows.results.length>limit ? page.at(-1)?.seq??null : null, retainedCount: stats?.n??0, retainedBytes: stats?.bytes??0, maxEntries: 1000 as const, maxBytes: 1000000 as const };
}
