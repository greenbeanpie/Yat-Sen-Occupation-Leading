import { getConfiguredAiProvider } from '../infra/ai/settings';
import { z } from "zod";
import type { Env } from "../env";
import { logJson } from "../infra/logger";
import { AiError } from "../infra/ai";
import { extractText } from "../infra/extract";
import { fingerprintOf } from "../infra/db/helpers";
import { verifyQuote } from "../domain/quotes";
import { nowIso } from "../shared/datetime";
import type { ProcessorResult } from "./processors";

/** 模型解析响应的自身校验（不假设供应商支持严格结构化输出）。 */
const ModelParseResponse = z.object({
  experiences: z
    .array(
      z.object({
        title: z.string().max(200).default("未命名经历"),
        organization: z.string().max(200).default(""),
        kind: z.enum(["project", "internship", "research", "competition", "other"]).default("other"),
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        description: z.string().max(20000).default(""),
        quote: z.string().max(2000).default(""),
      }),
    )
    .max(20)
    .default([]),
  skills: z
    .array(
      z.object({
        name: z.string().max(100).default(""),
        quote: z.string().max(2000).default(""),
      }),
    )
    .max(30)
    .default([]),
});

/**
 * 文档解析（backend_plan.md 7.3/7.4）：
 * 提取文本 → 保存片段 → 模型提取候选字段 → 结构与引用校验 → 解析草稿。
 * 幂等：作业已成功则直接返回；写回前核对输入指纹，旧输入不覆盖新数据。
 */
export async function processParseDocument(env: Env, operationId: string): Promise<ProcessorResult> {
  const op = await env.DB.prepare(`SELECT * FROM async_operations WHERE id = ?1`).bind(operationId).first<Record<string, unknown>>();
  if (!op) return { status: "failed", error: "作业不存在" };
  if (op.status === "succeeded") return { status: "succeeded" };
  if (op.status === "failed") return { status: "failed", error: "作业已失效" };

  const userId = op.user_id as string;
  const input = JSON.parse(op.input_json as string) as { documentId: string };
  const doc = await env.DB.prepare(`SELECT * FROM documents WHERE id = ?1 AND user_id = ?2 AND deleted = 0`)
    .bind(input.documentId, userId)
    .first<Record<string, unknown>>();
  if (!doc) return { status: "failed", error: "文档不存在" };

  // 输入指纹核验：文件被替换/删除后，旧输入的结果不得覆盖新数据
  const fingerprint = await fingerprintOf([doc.id, doc.r2_key, doc.size_bytes, doc.version]);
  if (fingerprint !== op.input_fingerprint) {
    await env.DB.prepare(`UPDATE documents SET status = 'failed', error = ?1, updated_at = ?2 WHERE id = ?3 AND deleted = 0`)
      .bind("文件已变化，请重新发起解析", nowIso(), doc.id as string)
      .run();
    return { status: "failed", error: "输入已过期（文件已变化）" };
  }

  try {
    await env.DB.prepare(`UPDATE documents SET status = 'extracting', updated_at = ?1 WHERE id = ?2 AND deleted = 0`)
      .bind(nowIso(), doc.id as string)
      .run();

    const obj = await env.DOCS.get(doc.r2_key as string);
    if (!obj) return { status: "failed", error: "文件已丢失，请重新上传" };
    const bytes = new Uint8Array(await obj.arrayBuffer());

    const extraction = await extractText(bytes, doc.mime_type as string);

    const segments = extraction.pages
      .map((p, i) => ({ seq: i, page: p.page, text: p.text }))
      .filter((s) => s.text.trim().length > 0);
    if (segments.length > 0) {
      await env.DB.batch(
        segments.map((s) =>
          env.DB
            .prepare(`INSERT INTO document_segments (id, document_id, user_id, seq, page, text) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM documents WHERE id = ?2 AND user_id = ?3 AND deleted = 0)`)
            .bind(crypto.randomUUID(), doc.id, userId, s.seq, s.page, s.text),
        ),
      );
    }

    await env.DB.prepare(`UPDATE documents SET status = 'parsing', page_count = ?1, updated_at = ?2 WHERE id = ?3`)
      .bind(extraction.pageCount, nowIso(), doc.id as string)
      .run();

    // 模型提取候选字段（只发送必要文本，不发送密钥）
    const provider = await getConfiguredAiProvider(env, userId, operationId);
    const raw = await provider.complete([
      {
        role: "system",
        content:
          "你是简历解析引擎。只输出 JSON，不要输出其它文字。experiences[].quote 与 skills[].quote 必须是输入文本中的原句。",
      },
      {
        role: "user",
        content: JSON.stringify({ task: "parse_document", segments: segments.map((s) => ({ page: s.page, text: s.text })) }),
      },
    ]);

    let model: z.infer<typeof ModelParseResponse>;
    try {
      model = ModelParseResponse.parse(JSON.parse(raw));
    } catch {
      logJson("warn", "model_response_invalid", { operationId, provider: provider.name });
      return { status: "failed", error: "模型响应格式错误，请重试" };
    }

    // 引用核验：未命中原文的引用直接拒绝该条目
    const sourceText = segments.map((s) => s.text).join("\n");
    const rejected = { experiences: 0, skills: 0 };
    const experiences = model.experiences.filter((e) => {
      const ok = e.quote ? verifyQuote(sourceText, e.quote).found : false;
      if (!ok) rejected.experiences++;
      return ok;
    });
    const skills = model.skills.filter((s) => {
      const ok = s.name && s.quote && verifyQuote(sourceText, s.quote).found;
      if (!ok) rejected.skills++;
      return ok;
    });

    const current = await env.DB.prepare(`SELECT version FROM documents WHERE id = ?1 AND user_id = ?2 AND deleted = 0`).bind(doc.id, userId).first<{ version: number }>();
    if (!current || current.version !== doc.version) return { status: "failed", error: "文档已删除或已变化" };
    const draftId = crypto.randomUUID();
    const written = await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO parse_drafts (id, user_id, document_id, operation_id, result_json, status, input_fingerprint, created_at, updated_at)
           SELECT ?1, ?2, ?3, ?4, ?5, 'ready', ?6, ?7, ?7
           WHERE EXISTS (SELECT 1 FROM documents WHERE id = ?3 AND user_id = ?2 AND deleted = 0 AND version = ?8)`,
        )
        .bind(
          draftId,
          userId,
          doc.id,
          operationId,
          JSON.stringify({ experiences, skills, rejectedCounts: rejected, engine: extraction.engine }),
          fingerprint,
          nowIso(),
          doc.version,
        ),
      env.DB
        .prepare(`UPDATE async_operations SET status = 'succeeded', result_ref = ?1, updated_at = ?2 WHERE id = ?3 AND EXISTS (SELECT 1 FROM parse_drafts WHERE id = ?1)`)
        .bind(draftId, nowIso(), operationId),
      env.DB.prepare(`UPDATE documents SET status = 'draft_ready', error = NULL, updated_at = ?1 WHERE id = ?2 AND deleted = 0`).bind(nowIso(), doc.id),
    ]);
    if (Number(written[0]?.meta.changes) !== 1) return { status: "failed", error: "文档已删除或已变化" };
    logJson("info", "parse_document_done", { operationId, documentId: doc.id, experiences: experiences.length, skills: skills.length, rejected });
    return { status: "succeeded" };
  } catch (e) {
    const message = e instanceof AiError ? e.message : e instanceof Error ? e.message : "解析失败";
    await env.DB.batch([
      env.DB.prepare(`UPDATE documents SET status = 'failed', error = ?1, updated_at = ?2 WHERE id = ?3`).bind(message, nowIso(), doc.id as string),
    ]);
    logJson("warn", "parse_document_failed", { operationId, message });
    return { status: "failed", error: message };
  }
}
