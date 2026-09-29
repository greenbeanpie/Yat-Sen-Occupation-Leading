import type { Env } from "../env";
import { processParseDocument } from "./parse-document";
import { processGenerateMatch } from "./generate-match";
import { processParseJobRequirements } from "./parse-job-requirements";

/**
 * 异步作业处理器（backend_plan.md 7.3）。
 * Workflow 类只是薄壳：业务逻辑在这里，既被 Workflow 步骤调用，也被测试直接调用。
 * 每个处理器遵循统一骨架：读作业 → 核对输入指纹 → 执行 → 落库（幂等）。
 */

export interface ProcessorResult {
  status: "succeeded" | "failed";
  error?: string;
}

export function runParseDocument(env: Env, operationId: string): Promise<ProcessorResult> {
  return processParseDocument(env, operationId);
}

export function runGenerateMatch(env: Env, operationId: string): Promise<ProcessorResult> {
  return processGenerateMatch(env, operationId);
}

export function runParseJobRequirements(env: Env, operationId: string): Promise<ProcessorResult> {
  return processParseJobRequirements(env, operationId);
}

export function runGeneratePlan(_env: Env, _operationId: string): Promise<ProcessorResult> {
  return Promise.resolve({ status: "failed", error: "M4 里程碑实现" });
}

export function runRewriteResume(_env: Env, _operationId: string): Promise<ProcessorResult> {
  return Promise.resolve({ status: "failed", error: "M4 里程碑实现" });
}
