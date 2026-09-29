import { SUPPORTED_MIME } from "../../shared/constants";
import { unprocessableFile } from "../../shared/errors";
import { extractPdf } from "./pdf";
import { extractDocx } from "./docx";
import type { ExtractionResult } from "./types";

export type { ExtractionResult } from "./types";

export function isSupportedMime(mime: string): boolean {
  return (SUPPORTED_MIME as readonly string[]).includes(mime);
}

/** 按文件类型分发的文本提取入口。 */
export async function extractText(data: Uint8Array, mimeType: string): Promise<ExtractionResult> {
  if (mimeType === "application/pdf") return extractPdf(data);
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return extractDocx(data);
  throw unprocessableFile("不支持的文件类型，仅支持 PDF 与 DOCX");
}
