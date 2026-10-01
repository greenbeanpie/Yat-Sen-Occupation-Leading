import type { Env } from "../../env";
import { AiError } from './errors';
import { boundedNumber, careerDiagnosticTokenLimit, resolveAiConfig, type AiConfig } from './config';
import { modelUsage, type AiUsage } from './usage';
import { buildAiRequest, completionText } from './request';
import { writeAiDiagnostic, networkDiagnosticCode, type DiagnosticEvent } from './diagnostics';
export { AiError } from './errors';

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionOptions {
  /** Internal synchronous dispatch signal; never receives the request or credentials. */
  onDispatch?: () => void;
  /** Optional final permissions/version guard, awaited immediately before fetch. */
  beforeDispatch?: () => Promise<void>;
  temperature?: number;
  /** Opaque conversation ID, reused across turns/retries; never user data. */
  sessionId?: string;
  timeoutMs?: number;
  /** Bounded review-only tasks can disable retries and cap response bytes. */
  maxAttempts?: number;
  maxResponseBytes?: number;
  rejectRedirects?: boolean;
  /** Internal, explicitly authorized super-admin career test only; never saved config. */
  careerDiagnosticBudget?: { maxOutputTokens: number; timeoutMs: number };
  onUsage?: (usage: AiUsage) => void;
}

/** Text-only provider adapter + mock; callers retain structured-output validation. */
export interface AiProvider {
  readonly name: string;
  readonly supportsTemperature?: boolean;
  complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<string>;
}

export function getAiProvider(env: Env): AiProvider {
  switch (env.AI_PROVIDER) {
    case "mock":
      return new MockProvider();
    case "openai":
      return new OpenAiCompatProvider(env);
    default:
      throw new AiError(`不支持的 AI_PROVIDER：${env.AI_PROVIDER}`, false);
  }
}

/**
 * Backward-compatible class name; dispatches by validated preset protocol.
 * - Only sends task text/context; credentials are confined to auth headers;
 * - 超时、429、5xx 指数退避重试；4xx 其它错误不可重试；
 * - 不假设供应商支持严格结构化输出，响应一律由调用方做 Zod 校验。
 */
export class OpenAiCompatProvider implements AiProvider {
  readonly name: string;
  readonly supportsTemperature: boolean;
  private readonly config: AiConfig;
  private readonly sessionId = crypto.randomUUID();
  constructor(private env: Env) {
    this.config = resolveAiConfig(env);
    this.name = `${this.config.preset === 'custom' ? 'openai-compat' : this.config.preset}:${this.config.model}`;
    this.supportsTemperature = this.config.capabilities.temperature;
  }

  async complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<string> {
    if (messages.reduce((size, message) => size + new TextEncoder().encode(message.content).length, 0) > 100_000) {
      throw new AiError("模型输入超过 100KB 上限，请缩小文档或岗位内容", false);
    }
    let config = this.config;
    if (opts?.careerDiagnosticBudget) {
      const cap = careerDiagnosticTokenLimit(config);
      if (!cap) throw new AiError('当前模型未验证公告临时测试预算，未发出请求',false);
      config = { ...config, maxOutputTokens: boundedNumber(opts.careerDiagnosticBudget.maxOutputTokens,'careerTestMaxOutputTokens',1,cap,undefined,true)!,
        timeoutMs: boundedNumber(opts.careerDiagnosticBudget.timeoutMs,'careerTestTimeoutMs',1,120000,undefined,true)! };
    }
    const timeoutMs = Math.min(config.timeoutMs, boundedNumber(opts?.timeoutMs, 'timeoutMs', 1, opts?.careerDiagnosticBudget?120000:60000, config.timeoutMs, true)!);
    const maxAttempts = Math.min(this.config.maxAttempts, boundedNumber(opts?.maxAttempts, 'maxAttempts', 1, 3, this.config.maxAttempts, true)!);
    const maxResponseBytes = boundedNumber(opts?.maxResponseBytes, 'maxResponseBytes', 1, 1_000_000, 1_000_000, true)!;
    const request = buildAiRequest(config, messages, this.env.AI_API_KEY, opts?.sessionId ?? this.sessionId, opts);
    const traceId = opts?.sessionId ?? this.sessionId;
    const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(traceId) ? traceId : crypto.randomUUID();
    const started = Date.now();
    let usage: AiUsage|undefined;
    const trace = (stage: DiagnosticEvent['stage'], code: DiagnosticEvent['code'], attempt = 0, httpStatus?: number) => writeAiDiagnostic(this.env,{requestId,stage,code,attempt,httpStatus,provider:config.preset,model:config.model,protocol:config.protocol,timeoutMs,maxOutputTokens:config.maxOutputTokens,elapsedMs:Date.now()-started,...(usage?{usage}:{})});
    await trace('config_validated','ok');
    let lastError: AiError = new AiError("模型请求失败", false);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await trace('dispatch','ok',attempt+1);
      try { await opts?.beforeDispatch?.(); }
      catch(error) { await trace('end','invalid_configuration',attempt+1); throw error; }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let outcome: DiagnosticEvent['code'] = 'internal_error';
      let httpStatus: number|undefined;
      try {
        opts?.onDispatch?.();
        const res = await fetch(request.url, {
          method: "POST",
          // Never forward credentials/attribution through a redirect.
          redirect: "manual",
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        });
        httpStatus = res.status;
        await trace('response',res.ok?'ok':res.status>=300&&res.status<400?'redirect_rejected':'provider_http',attempt+1,res.status);
        if (res.status === 429 || res.status >= 500) {
          outcome = 'provider_http';
          lastError = new AiError(`模型服务暂时不可用（HTTP ${res.status}）`, true);
          await res.body?.cancel();
          if (attempt + 1 < maxAttempts) await backoff(attempt);
          continue;
        }
        if (!res.ok) {
          outcome = 'provider_http';
          await res.body?.cancel();
          throw new AiError(`模型请求被拒绝（HTTP ${res.status}）`, false);
        }
        const responseText = await boundedModelResponse(res, maxResponseBytes);
        let body: unknown;
        try { body = JSON.parse(responseText); }
        catch { await trace('parse','invalid_response',attempt+1,httpStatus); throw new AiError('模型响应不是有效 JSON', false); }
        let text: string;
        usage = modelUsage(body,config.protocol);
        try { opts?.onUsage?.(usage); } catch { /* Numeric observability callback never changes the model outcome. */ }
        try { text = completionText(this.config, body); }
        catch(error) { await trace('parse',error instanceof AiError&&error.message.includes('token 上限')?'output_limit':'invalid_response',attempt+1,httpStatus);throw error; }
        outcome = 'ok';
        await trace('parse','ok',attempt+1,httpStatus);
        return text;
      } catch (e) {
        if (e instanceof AiError) {
          outcome = httpStatus && httpStatus>=300&&httpStatus<400 ? 'redirect_rejected' : httpStatus && httpStatus>=400 ? 'provider_http' : e.message.includes('token 上限') ? 'output_limit' : 'invalid_response';
          lastError = e;
          if (!e.retryable) throw e;
        } else if (controller.signal.aborted || (e instanceof Error && ["AbortError", "TimeoutError"].includes(e.name))) {
          outcome = 'timeout';
          lastError = new AiError(`模型请求超时（${timeoutMs / 1000} 秒）`, true);
          if (attempt + 1 < maxAttempts) await backoff(attempt);
        } else {
          outcome = networkDiagnosticCode(e);
          lastError = new AiError("网络错误", true);
          if (attempt + 1 < maxAttempts) await backoff(attempt);
        }
      } finally {
        clearTimeout(timer);
        await trace('end',outcome,attempt+1,httpStatus);
      }
    }
    throw lastError;
  }
}

async function boundedModelResponse(res: Response, limit: number): Promise<string> {
  const reader=res.body?.getReader(); if(!reader)throw new AiError("模型响应为空",false);
  let size=0;const chunks:Uint8Array[]=[];
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw new AiError("模型响应过大",false);chunks.push(value);}}
  finally {await reader.cancel();}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  try { return new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes); }
  catch { throw new AiError('模型响应不是有效 UTF-8', false); }
}

async function backoff(attempt: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
}

/**
 * Mock 供应商：确定性构造、引用必然命中原文的解析/改写结果。
 * 用于开发、测试与无密钥联调；演示站必须能标识其为模拟结果（capabilities.demoMode）。
 */
export class MockProvider implements AiProvider {
  readonly name = "mock";

  async complete(messages: ChatMessage[]): Promise<string> {
    const payload = extractPayload(messages);
    switch (payload?.task) {
      case "parse_document":
        return mockParseDocument(payload as unknown as ParseTaskPayload);
      case "parse_job_requirements":
        return mockParseRequirements(payload as unknown as RequirementsTaskPayload);
      case "generate_match":
        return mockGenerateMatch(payload as unknown as MatchTaskPayload);
      case "generate_plan":
        return mockGeneratePlan(payload);
      case "rewrite_resume":
        return mockRewrite(payload as unknown as RewritePayload);
      default:
        throw new AiError("mock: 未知任务类型", false);
    }
  }
}

function extractPayload(messages: ChatMessage[]): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    try {
      const parsed = JSON.parse(m.content) as Record<string, unknown>;
      if (parsed && typeof parsed.task === "string") return parsed;
    } catch {
      /* 非载荷消息，跳过 */
    }
  }
  return null;
}

/** 从输入文本中挑出可用作引用的句子（保证引用核验可通过）。 */
function firstSentence(text: string, minLen = 6): string | null {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length < minLen) return null;
  const match = cleaned.match(/[^。！？.!?]{6,120}[。！？.!?]?/);
  return match ? match[0].trim() : cleaned.slice(0, 80);
}

interface ParseTaskPayload {
  task: string;
  segments: { page: number | null; text: string }[];
}

function mockParseDocument(payload: ParseTaskPayload): string {
  const texts = (payload.segments ?? []).map((s) => s.text);
  const fullText = texts.join("\n");
  const lines = fullText.split("\n").map((l) => l.trim()).filter(Boolean);
  const experiences: unknown[] = [];
  const skills: string[] = [];
  const knownSkills = ["JavaScript", "TypeScript", "Python", "React", "SQL", "机器学习", "数据分析", "项目管理", "Java", "Go", "Docker", "Git"];
  for (const line of lines) {
    for (const skill of knownSkills) {
      if (line.includes(skill) && !skills.includes(skill) && skills.length < 8) skills.push(skill);
    }
  }
  for (let i = 0; i + 1 < lines.length && experiences.length < 3; i += 2) {
    const nextLine = lines[i + 1] ?? lines[i] ?? "";
    const quote = firstSentence(nextLine);
    if (!quote) continue;
    experiences.push({
      title: (lines[i] ?? "").slice(0, 60),
      organization: "",
      kind: i === 0 ? "internship" : "project",
      startDate: null,
      endDate: null,
      description: nextLine,
      quote,
    });
  }
  if (experiences.length === 0 && lines.length > 0) {
    const firstLine = lines[0] ?? "";
    const quote = firstSentence(firstLine);
    if (quote) {
      experiences.push({
        title: firstLine.slice(0, 60),
        organization: "",
        kind: "project",
        startDate: null,
        endDate: null,
        description: firstLine,
        quote,
      });
    }
  }
  return JSON.stringify({
    experiences,
    skills: skills.map((name) => {
      const line = lines.find((l) => l.includes(name)) ?? fullText ?? "";
      return { name, quote: firstSentence(line) ?? name };
    }),
  });
}

interface RequirementsTaskPayload {
  task: string;
  jdText: string;
}

/** 从 JD 原文提取硬条件候选；quote 一律取自原文，保证引用核验可通过。 */
function mockParseRequirements(payload: RequirementsTaskPayload): string {
  const jd = payload.jdText ?? "";
  const lines = jd.split(/[\n。；;]+/).map((l) => l.trim()).filter(Boolean);
  const candidates: { kind: string; value: string; quote: string }[] = [];

  const degreeRe = /(专科|本科|硕士|研究生|博士)/;
  const degreeMap: Record<string, string> = { 专科: "associate", 本科: "bachelor", 硕士: "master", 研究生: "master", 博士: "phd" };
  const yearRe = /(\d{4})\s*届/;
  const knownSkills = ["JavaScript", "TypeScript", "Python", "React", "Vue", "Node.js", "SQL", "Java", "Go", "Docker", "Git"];

  for (const line of lines) {
    const quote = firstSentence(line, 4) ?? line.slice(0, 60);
    if (candidates.some((c) => c.kind === "degree") === false) {
      const d = line.match(degreeRe);
      if (d && degreeMap[d[1] as string]) {
        candidates.push({ kind: "degree", value: degreeMap[d[1] as string]!, quote });
      }
    }
    const y = line.match(yearRe);
    if (y && !candidates.some((c) => c.kind === "graduation_year")) {
      candidates.push({ kind: "graduation_year", value: y[1] as string, quote });
    }
    for (const skill of knownSkills) {
      if (line.includes(skill) && !candidates.some((c) => c.kind === "skill" && c.value === skill)) {
        candidates.push({ kind: "skill", value: skill, quote });
      }
    }
  }
  return JSON.stringify({ requirements: candidates.slice(0, 15) });
}

interface MatchTaskPayload {
  task: string;
  jdText: string;
  requirements: { kind: string; value: string }[];
  scores: { total: number };
  gaps: string[];
}

function mockGenerateMatch(payload: MatchTaskPayload): string {
  const jd = payload.jdText ?? "";
  const quote = firstSentence(jd) ?? "";
  return JSON.stringify({
    summary: `综合匹配分 ${Math.round((payload.scores?.total ?? 0) * 100)} 分（模拟解释，仅供演示）`,
    advantages: quote ? [{ text: "技能与岗位要求存在重叠（模拟）", quotes: [quote] }] : [],
    gaps: (payload.gaps ?? []).slice(0, 5).map((g) => ({ text: g, quotes: [] })),
    prepSuggestions: quote ? [{ text: "优先补齐差距项（模拟）", quotes: [quote] }] : [],
  });
}

interface PlanTaskPayload {
  jobs?: { jobId?: string; title?: string; gaps?: string[] }[];
  evidence?: { evidenceId?: string; skill?: string; experience?: string }[];
}

/** 计划任务带岗位、差距、证据与依赖，便于在没有密钥时也能验证 PLAN.md 2.5 的字段。 */
function mockGeneratePlan(payload: unknown): string {
  const input = (payload ?? {}) as PlanTaskPayload;
  const job = input.jobs?.[0];
  const gap = job?.gaps?.[0];
  const evidence = input.evidence?.[0];
  return JSON.stringify({
    tasks: [
      {
        title: "核对画像与经历",
        description: "检查解析与手动录入的内容是否准确",
        estimateHours: 1,
        jobId: job?.jobId,
        dependsOn: [],
      },
      {
        title: "针对岗位补齐关键证据",
        description: "为岗位硬条件关联已确认经历",
        estimateHours: 2,
        jobId: job?.jobId,
        gap,
        evidenceId: evidence?.evidenceId,
        dependsOn: [0],
      },
      {
        title: "改写简历要点",
        description: "按岗位调整简历表述，逐条确认",
        estimateHours: 2,
        jobId: job?.jobId,
        dependsOn: [1],
      },
      {
        title: "准备面试问题清单",
        description: "围绕岗位要求准备问答",
        estimateHours: 3,
        jobId: job?.jobId,
        dependsOn: [2],
      },
    ],
  });
}

interface RewritePayload {
  task: string;
  description: string;
}

function mockRewrite(payload: RewritePayload): string {
  const desc = payload.description ?? "";
  const quote = firstSentence(desc, 4) ?? "";
  const suggestion = quote
    ? `${quote.replace(/[。.!！]?$/, "")}，表述更聚焦岗位职责与产出（模拟改写，不新增事实）。`
    : "（原文过短，无可改写内容）";
  return JSON.stringify({
    items: quote ? [{ originalQuote: quote, suggestion, rationale: "只调整措辞，不新增未确认的事实或数字（模拟）" }] : [],
  });
}
