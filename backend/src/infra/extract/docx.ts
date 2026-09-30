import { unprocessableFile } from "../../shared/errors";
import type { ExtractedPage, ExtractionResult } from "./types";

/**
 * DOCX 段落提取：fflate 解压 + word/document.xml 文本抽取。
 * Spike 结论（backend/docs/spike-extraction.md）：mammoth 在 import 期依赖 Node 内建模块
 * （fs/os/path），无法在 Workers 打包环境运行；按 PLAN.md 2.4 的预案改用纯 JS 的
 * fflate 直接解析 OOXML（均为 Workers 兼容实现）。
 */
export async function extractDocx(data: Uint8Array): Promise<ExtractionResult> {
  const paragraphs = await viaUnzip(data);
  const text = paragraphs
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join("\n");
  if (!text) throw unprocessableFile("DOCX 无可提取文本，请改用手动录入");
  return { pages: [{ page: 1, text }], pageCount: 1, engine: "fflate+docx-xml" };
}

/** 直接解析 OOXML 主体 <w:t> 节点。 */
async function viaUnzip(data: Uint8Array): Promise<string[]> {
  const { unzipSync, strFromU8 } = await import("fflate");
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, { filter: (entry) => {
      if (/vbaProject\.bin$/i.test(entry.name)) throw unprocessableFile("不接受包含宏的文档");
      if (entry.name !== "word/document.xml") return false;
      if (entry.originalSize > 4 * 1024 * 1024) throw unprocessableFile("DOCX 解压正文超过 4MB 上限");
      return true;
    } });
  } catch {
    throw unprocessableFile("无法读取 DOCX（文件可能已损坏）");
  }
  const xmlBytes = files["word/document.xml"];
  if (!xmlBytes) throw unprocessableFile("DOCX 缺少正文（word/document.xml）");
  const xml = strFromU8(xmlBytes);

  const paragraphs: string[] = [];
  const paraRe = /<w:p[ >]([\s\S]*?)<\/w:p>/g;
  const runRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
  for (const para of xml.matchAll(paraRe)) {
    const runs: string[] = [];
    for (const run of (para[1] ?? "").matchAll(runRe)) {
      runs.push(decodeXml(run[1] ?? ""));
    }
    const text = runs.join("");
    if (text.trim().length > 0) paragraphs.push(text);
  }
  return paragraphs;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export type { ExtractedPage, ExtractionResult };
