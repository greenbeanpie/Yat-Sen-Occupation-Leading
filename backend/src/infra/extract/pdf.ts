import { MAX_PDF_PAGES } from "../../shared/constants";
import { unprocessableFile } from "../../shared/errors";
import type { ExtractedPage, ExtractionResult } from "./types";

/**
 * PDF 文本提取：unpdf（官方推荐的 PDF.js serverless 发行版，内部即 pdfjs-dist）。
 * PLAN.md 2.4：仅支持有文本层的 PDF，页数上限 30；扫描件/加密文件无文本时明确报错，不做 OCR。
 */
export async function extractPdf(data: Uint8Array): Promise<ExtractionResult> {
  const { extractText } = await import("unpdf");
  let result: { totalPages: number; text: string[] };
  try {
    result = await extractText(data as unknown as ArrayBuffer, { mergePages: false });
  } catch {
    throw unprocessableFile("无法读取 PDF（文件可能已损坏或加密）");
  }
  if (result.totalPages > MAX_PDF_PAGES) {
    throw unprocessableFile(`PDF 超过 ${MAX_PDF_PAGES} 页上限（当前 ${result.totalPages} 页）`);
  }
  const pages: ExtractedPage[] = result.text.map((t, i) => ({ page: i + 1, text: t }));
  if (pages.every((p) => p.text.trim().length === 0)) {
    throw unprocessableFile("PDF 无文本层（可能是扫描件），请改用手动录入");
  }
  return { pages, pageCount: result.totalPages, engine: "unpdf(pdf.js)" };
}
