import type { Env } from "../../env";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionOptions {
  temperature?: number;
  timeoutMs?: number;
  /** Bounded review-only tasks can disable retries and cap response bytes. */
  maxAttempts?: number;
  maxResponseBytes?: number;
  rejectRedirects?: boolean;
}

/** 统一模型适配器（PLAN.md 2.4）：OpenAI 风格 + mock，超时/限流重试由实现负责。 */
export interface AiProvider {
  readonly name: string;
  complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<string>;
}

export class AiError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export function getAiProvider(env: Env): AiProvider {
  switch (env.AI_PROVIDER) {
    case "mock":
      return new MockProvider();
    case "openai":
      if (!env.AI_BASE_URL?.trim()) {
        throw new AiError("AI_PROVIDER=openai 时必须配置 AI_BASE_URL", false);
      }
      return new OpenAiCompatProvider(env);
    default:
      throw new AiError(`不支持的 AI_PROVIDER：${env.AI_PROVIDER}`, false);
  }
}

/**
 * OpenAI 风格 chat/completions 适配器：
 * - 只发送必要文本与结构化上下文，不发送密钥；
 * - 超时、429、5xx 指数退避重试；4xx 其它错误不可重试；
 * - 不假设供应商支持严格结构化输出，响应一律由调用方做 Zod 校验。
 */
export class OpenAiCompatProvider implements AiProvider {
  readonly name: string;
  constructor(private env: Env) {
    this.name = `openai-compat:${env.AI_MODEL || "default"}`;
  }

  async complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<string> {
    if (messages.reduce((size, message) => size + new TextEncoder().encode(message.content).length, 0) > 100_000) {
      throw new AiError("模型输入超过 100KB 上限，请缩小文档或岗位内容", false);
    }
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    let lastError: AiError = new AiError("模型请求失败", false);
    for (let attempt = 0; attempt < (opts?.maxAttempts ?? 3); attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${this.env.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          redirect: opts?.rejectRedirects ? "manual" : "follow",
          headers: {
            "Content-Type": "application/json",
            ...(this.env.AI_API_KEY ? { Authorization: `Bearer ${this.env.AI_API_KEY}` } : {}),
          },
          body: JSON.stringify({
            model: this.env.AI_MODEL,
            messages,
            max_tokens: 4096,
            temperature: opts?.temperature ?? 0.2,
          }),
          signal: controller.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = new AiError(`模型服务暂时不可用（HTTP ${res.status}）`, true);
          await backoff(attempt);
          continue;
        }
        if (!res.ok) {
          throw new AiError(`模型请求被拒绝（HTTP ${res.status}）`, false);
        }
        const body = (opts?.maxResponseBytes ? JSON.parse(await boundedModelResponse(res, opts.maxResponseBytes)) : await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new AiError("模型响应格式错误", false);
        return content;
      } catch (e) {
        if (e instanceof AiError) {
          lastError = e;
          if (!e.retryable) throw e;
        } else if (e instanceof Error && e.name === "AbortError") {
          lastError = new AiError("模型请求超时", true);
          await backoff(attempt);
        } else {
          lastError = new AiError("网络错误", true);
          await backoff(attempt);
        }
      } finally {
        clearTimeout(timer);
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
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes);
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
