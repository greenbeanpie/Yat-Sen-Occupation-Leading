import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AcceptedResponseSchema,
  ConfirmParseSchema,
  DocumentSchema,
  ErrorBodySchema,
  OperationSchema,
  ParseDraftSchema,
  UuidSchema,
} from "../shared/schemas";
import { requireAuth } from "../middleware/auth";
import { notFound, unprocessableFile } from "../shared/errors";
import { MAX_FILE_BYTES, MAX_PDF_PAGES } from "../shared/constants";
import { isSupportedMime } from "../infra/extract";
import { startOperation } from "../application/operations";
import { rowToJson } from "../application/entity-writer";
import { createEntity } from "../application/entity-writer";
import { verifyQuote } from "../domain/quotes";
import { nowIso } from "../shared/datetime";
import type { AppEnv } from "../env";

type App = OpenAPIHono<AppEnv>;

const idParam = { name: "id", in: "params" as const, required: true, schema: UuidSchema };

const DOCUMENT_CFG = {
  entity: "job" as never,
  table: "documents",
  fields: {
    filename: {},
    mimeType: {},
    sizeBytes: {},
    pageCount: { nullable: true },
    status: {},
    error: { nullable: true },
  },
};

const upload = createRoute({
  method: "post",
  path: "/documents",
  tags: ["documents"],
  middleware: [requireAuth] as const,
  request: {
    body: {
      content: { "multipart/form-data": { schema: z.object({ file: z.instanceof(File).openapi({ type: "string", format: "binary" }) }) } },
      required: true,
    },
  },
  responses: {
    201: { content: { "application/json": { schema: DocumentSchema } }, description: "已上传（尚未解析）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    422: { content: { "application/json": { schema: ErrorBodySchema } }, description: "文件类型或大小不符合要求" },
  },
});

const listDocuments = createRoute({
  method: "get",
  path: "/documents",
  tags: ["documents"],
  middleware: [requireAuth] as const,
  responses: {
    200: { content: { "application/json": { schema: z.object({ items: z.array(DocumentSchema) }) } }, description: "文档列表" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const getDocument = createRoute({
  method: "get",
  path: "/documents/{id}",
  tags: ["documents"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: DocumentSchema } }, description: "文档详情" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

const getContent = createRoute({
  method: "get",
  path: "/documents/{id}/content",
  tags: ["documents"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { description: "文件内容（受控访问，仅本人）", content: { "application/octet-stream": { schema: z.string() } } },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

const startParse = createRoute({
  method: "post",
  path: "/documents/{id}/parse",
  tags: ["documents"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    202: { content: { "application/json": { schema: AcceptedResponseSchema } }, description: "解析作业已排队" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

const getDraft = createRoute({
  method: "get",
  path: "/documents/{id}/draft",
  tags: ["documents"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: ParseDraftSchema } }, description: "解析草稿（须确认后入库）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "尚无就绪草稿" },
  },
});

const confirmDraft = createRoute({
  method: "post",
  path: "/documents/{id}/confirm",
  tags: ["documents"],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: UuidSchema }),
    body: { content: { "application/json": { schema: ConfirmParseSchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ experienceIds: z.array(z.string()), skillIds: z.array(z.string()) }) } }, description: "草稿已确认并写入画像（证据为待确认）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "草稿不可确认（未就绪或已确认）" },
  },
});

const deleteDocument = createRoute({
  method: "delete",
  path: "/documents/{id}",
  tags: ["documents"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    204: { description: "已删除（墓碑；原始文件保留在私有桶中）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

export function registerDocumentRoutes(app: App): void {
  app.openapi(upload, async (c) => {
    const userId = c.get("user").id;
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw unprocessableFile("缺少文件字段 file");
    if (!isSupportedMime(file.type)) throw unprocessableFile("仅支持 PDF 与 DOCX 文件");
    if (file.size > MAX_FILE_BYTES) throw unprocessableFile("文件超过 10MB 上限");

    const id = crypto.randomUUID();
    const r2Key = `docs/${userId}/${id}/${file.name}`;
    await c.env.DOCS.put(r2Key, file.stream(), { httpMetadata: { contentType: file.type } });
    const now = nowIso();
    const record = {
      id,
      userId,
      version: 1,
      deleted: false,
      createdAt: now,
      updatedAt: now,
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      pageCount: null,
      status: "uploaded",
      error: null,
    };
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO documents (id, user_id, filename, mime_type, size_bytes, r2_key, status, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'uploaded', ?7, ?7)`,
        )
        .bind(id, userId, file.name, file.type, file.size, r2Key, now),
    ]);
    return c.json(record as never, 201 as const);
  });

  app.openapi(listDocuments, async (c) => {
    const userId = c.get("user").id;
    const rows = await c.env.DB.prepare(`SELECT * FROM documents WHERE user_id = ?1 AND deleted = 0 ORDER BY created_at DESC`)
      .bind(userId)
      .all<Record<string, unknown>>();
    return c.json({ items: rows.results.map((r) => rowToJson(DOCUMENT_CFG, r)) }, 200 as const) as never;
  });

  app.openapi(getDocument, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM documents WHERE id = ?1 AND user_id = ?2`).bind(id, userId).first<Record<string, unknown>>();
    if (!row) throw notFound();
    return c.json(rowToJson(DOCUMENT_CFG, row) as never, 200 as const);
  });

  app.openapi(getContent, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM documents WHERE id = ?1 AND user_id = ?2 AND deleted = 0`)
      .bind(id, userId)
      .first<Record<string, unknown>>();
    if (!row) throw notFound();
    const obj = await c.env.DOCS.get(row.r2_key as string);
    if (!obj) throw notFound("文件已丢失");
    return c.body(obj.body as never, 200 as never, {
      "Content-Type": (row.mime_type as string) || "application/octet-stream",
      "Content-Disposition": `attachment; filename="document"`,
    });
  });

  app.openapi(startParse, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM documents WHERE id = ?1 AND user_id = ?2 AND deleted = 0`)
      .bind(id, userId)
      .first<Record<string, unknown>>();
    if (!row) throw notFound();
    const operationId = await startOperation(c.env, userId, "parse_document", { documentId: id }, [row.id, row.r2_key, row.size_bytes, row.version]);
    return c.json({ operationId }, 202 as const) as never;
  });

  app.openapi(getDraft, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const row = await c.env.DB
      .prepare(`SELECT * FROM parse_drafts WHERE document_id = ?1 AND user_id = ?2 AND status = 'ready' ORDER BY created_at DESC LIMIT 1`)
      .bind(id, userId)
      .first<Record<string, unknown>>();
    if (!row) throw notFound("尚无就绪解析草稿");
    return c.json(
      {
        id: row.id,
        documentId: row.document_id,
        operationId: row.operation_id,
        status: row.status,
        result: JSON.parse(row.result_json as string),
        createdAt: row.created_at,
      },
      200 as const,
    ) as never;
  });

  app.openapi(confirmDraft, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const draft = await c.env.DB
      .prepare(`SELECT * FROM parse_drafts WHERE document_id = ?1 AND user_id = ?2 AND status = 'ready' ORDER BY created_at DESC LIMIT 1`)
      .bind(id, userId)
      .first<Record<string, unknown>>();
    if (!draft) throw notFound("尚无就绪解析草稿");
    const result = JSON.parse(draft.result_json as string) as {
      experiences: { title: string; organization: string; kind: string; description: string; quote: string }[];
      skills: { name: string; quote: string }[];
    };

    const now = nowIso();
    const experienceIds: string[] = [];
    const skillIds: string[] = [];
    const stmts: D1PreparedStatement[] = [];
    for (const e of result.experiences) {
      const eid = crypto.randomUUID();
      experienceIds.push(eid);
      stmts.push(
        c.env.DB
          .prepare(
            `INSERT INTO experiences (id, user_id, title, organization, kind, description, source_document_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
          )
          .bind(eid, userId, e.title, e.organization, e.kind, e.description, id, now),
      );
    }
    for (const s of result.skills) {
      const existing = await c.env.DB.prepare(`SELECT id FROM skills WHERE user_id = ?1 AND name = ?2 AND deleted = 0`)
        .bind(userId, s.name)
        .first<{ id: string }>();
      let sid = existing?.id;
      if (!sid) {
        sid = crypto.randomUUID();
        skillIds.push(sid);
        stmts.push(c.env.DB.prepare(`INSERT INTO skills (id, user_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)`).bind(sid, userId, s.name, now));
      } else {
        skillIds.push(sid);
      }
      // 关联到描述中含该引用的经历；引用必须命中经历原文
      for (const [i, e] of result.experiences.entries()) {
        if (e.description.includes(s.quote) || verifyQuote(e.description, s.quote).found) {
          stmts.push(
            c.env.DB
              .prepare(
                `INSERT INTO experience_skills (id, user_id, skill_id, experience_id, quote, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6)`,
              )
              .bind(crypto.randomUUID(), userId, sid, experienceIds[i], s.quote, now),
          );
          break;
        }
      }
    }
    stmts.push(c.env.DB.prepare(`UPDATE parse_drafts SET status = 'confirmed', updated_at = ?1 WHERE id = ?2`).bind(now, draft.id as string));
    stmts.push(c.env.DB.prepare(`UPDATE documents SET status = 'confirmed', updated_at = ?1 WHERE id = ?2`).bind(now, id));
    await c.env.DB.batch(stmts);
    return c.json({ experienceIds, skillIds }, 200 as const) as never;
  });

  app.openapi(deleteDocument, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM documents WHERE id = ?1 AND user_id = ?2 AND deleted = 0`)
      .bind(id, userId)
      .first<Record<string, unknown>>();
    if (!row) throw notFound();
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE documents SET deleted = 1, updated_at = ?1 WHERE id = ?2`).bind(nowIso(), id),
    ]);
    return c.body(null, 204 as const);
  });
}

export { DOCUMENT_CFG };
