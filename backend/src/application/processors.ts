import type { Env } from "../env";

/**
 * 异步作业处理器（backend_plan.md 7.3）。
 * Workflow 类只是薄壳：业务逻辑在这里，既被 Workflow 步骤调用，也被测试直接调用。
 * 每个处理器遵循统一骨架：读作业 → 核对输入指纹 → 执行 → 落库（幂等）。
 */

export interface ProcessorResult {
  status: "succeeded" | "failed";
  error?: string;
}

export async function runParseDocument(_env: Env, _operationId: string): Promise<ProcessorResult> {
  return { status: "failed", error: "M2 里程碑实现" };
}

export async function runGenerateMatch(_env: Env, _operationId: string): Promise<ProcessorResult> {
  return { status: "failed", error: "M3 里程碑实现" };
}

export async function runGeneratePlan(_env: Env, _operationId: string): Promise<ProcessorResult> {
  return { status: "failed", error: "M4 里程碑实现" };
}

export async function runRewriteResume(_env: Env, _operationId: string): Promise<ProcessorResult> {
  return { status: "failed", error: "M4 里程碑实现" };
}
