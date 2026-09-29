import { describe, expect, it } from "vitest";
import { getMf, loginAs, request, requestAs, STUDENT, STUDENT2 } from "./helpers";
import { buildMinimalDocx } from "./fixtures/docx";
import { buildMinimalPdf } from "./fixtures/pdf";
import { runParseDocument } from "../src/application/processors";

/** 在 Node 侧直接调用解析处理器（mock 供应商；D1/R2 为 Miniflare 真实绑定）。 */
async function runProcessor(operationId: string): Promise<{ status: string; error?: string }> {
  const { mf } = await getMf();
  const env = {
    DB: await mf.getD1Database("DB"),
    DOCS: await mf.getR2Bucket("DOCS"),
    AI_PROVIDER: "mock",
    AI_BASE_URL: "",
    AI_MODEL: "",
  } as unknown as import("../src/env").Env;
  return runParseDocument(env, operationId);
}

/** 手工构造 multipart/form-data，避免各运行时 FormData 边界差异。 */
function buildMultipart(filename: string, mime: string, bytes: Uint8Array): { body: Uint8Array; contentType: string } {
  const boundary = "----ysoform" + crypto.randomUUID().replaceAll("-", "");
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const headBytes = new TextEncoder().encode(head);
  const tailBytes = new TextEncoder().encode(tail);
  const body = new Uint8Array(headBytes.length + bytes.length + tailBytes.length);
  body.set(headBytes, 0);
  body.set(bytes, headBytes.length);
  body.set(tailBytes, headBytes.length + bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadFile(cookie: string, filename: string, mime: string, bytes: Uint8Array) {
  const { body, contentType } = buildMultipart(filename, mime, bytes);
  const { mf } = await getMf();
  return mf.dispatchFetch(
    "http://yso.test/api/v1/documents",
    { method: "POST", body, headers: { Cookie: cookie, "Content-Type": contentType } } as never,
  ) as unknown as Response;
}

describe("文档上传与解析（含提取 spike）", () => {
  it("DOCX：上传 → 解析 → 草稿 → 确认入库（证据为待确认）", async () => {
    const cookie = await loginAs(STUDENT);
    const docx = buildMinimalDocx([
      "前端开发实习生｜某某科技有限公司",
      "使用 React 与 TypeScript 完成管理后台开发，独立负责图表模块。",
      "技能：JavaScript、React、Git 协作。",
    ]);
    const upload = await uploadFile(cookie, "resume.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx);
    expect(upload.status).toBe(201);
    const doc = await upload.json<{ id: string }>();

    const parse = await requestAs(cookie, `/documents/${doc.id}/parse`, { method: "POST" });
    expect(parse.status).toBe(202);
    const { operationId } = await parse.json<{ operationId: string }>();

    // 直接运行处理器（真实环境由 Workflow 驱动同一函数）
    const result = await runProcessor(operationId);
    expect(result.status).toBe("succeeded");

    const op = await requestAs(cookie, `/operations/${operationId}`);
    expect(op.status).toBe(200);
    const opBody = await op.json<{ status: string }>();
    expect(opBody.status).toBe("succeeded");

    const draft = await requestAs(cookie, `/documents/${doc.id}/draft`);
    expect(draft.status).toBe(200);
    const draftBody = await draft.json<{ result: { experiences: { description: string; quote: string }[]; skills: { name: string; quote: string }[] } }>();
    expect(draftBody.result.experiences.length).toBeGreaterThan(0);
    expect(draftBody.result.skills.map((s) => s.name)).toContain("React");

    const confirm = await requestAs(cookie, `/documents/${doc.id}/confirm`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(confirm.status).toBe(200);

    const bundle = await requestAs(cookie, "/evidence");
    const bundleBody = await bundle.json<{ experiences: unknown[]; links: { status: string }[] }>();
    expect(bundleBody.experiences.length).toBeGreaterThan(0);
    for (const link of bundleBody.links) {
      expect(link.status).toBe("pending");
    }
  });

  it("PDF：文本提取通过（spike）", async () => {
    const cookie = await loginAs(STUDENT);
    const pdf = buildMinimalPdf(["JavaScript and React developer.", "Led a team project with TypeScript."]);
    const upload = await uploadFile(cookie, "resume.pdf", "application/pdf", pdf);
    expect(upload.status).toBe(201);
    const doc = await upload.json<{ id: string }>();
    const parse = await requestAs(cookie, `/documents/${doc.id}/parse`, { method: "POST" });
    const { operationId } = await parse.json<{ operationId: string }>();
    const result = await runProcessor(operationId);
    expect(result.status).toBe("succeeded");
    const draft = await requestAs(cookie, `/documents/${doc.id}/draft`);
    const draftBody = await draft.json<{ result: { engine: string; experiences: unknown[] } }>();
    expect(draftBody.result.engine).toBe("unpdf(pdf.js)");
    expect(draftBody.result.experiences.length).toBeGreaterThan(0);
  });

  it("用户隔离：他人无法读取我的文档与文件内容", async () => {
    const cookieA = await loginAs(STUDENT);
    const cookieB = await loginAs(STUDENT2);
    const docx = buildMinimalDocx(["私人简历内容，不应泄露。"]);
    const upload = await uploadFile(cookieA, "private.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx);
    expect(upload.status).toBe(201);
    const doc = await upload.json<{ id: string }>();

    const forbiddenGet = await requestAs(cookieB, `/documents/${doc.id}`);
    expect(forbiddenGet.status).toBe(404);
    const forbiddenContent = await requestAs(cookieB, `/documents/${doc.id}/content`);
    expect(forbiddenContent.status).toBe(404);

    const ownContent = await requestAs(cookieA, `/documents/${doc.id}/content`);
    expect(ownContent.status).toBe(200);
    const ownBytes = new Uint8Array(await ownContent.arrayBuffer());
    expect(ownBytes).toEqual(docx);
  });

  it("不支持的文件类型被拒绝", async () => {
    const cookie = await loginAs(STUDENT);
    const upload = await uploadFile(cookie, "photo.png", "image/png", new TextEncoder().encode("not an image"));
    expect(upload.status).toBe(422);
  });
});
