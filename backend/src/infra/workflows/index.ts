import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../../env";
import {
  runParseDocument,
  runGenerateMatch,
  runGeneratePlan,
  runRewriteResume,
  runParseJobRequirements,
} from "../../application/processors";

/** Workflow 参数：仅传作业 ID，输入数据都在 D1（async_operations），保证重试幂等。 */
export type OperationParams = { operationId: string };

type AnyStep = WorkflowStep;
type AnyEvent = WorkflowEvent<OperationParams>;

function makeRunner(fn: (env: Env, operationId: string) => Promise<{ status: string; error?: string }>) {
  return async (env: Env, event: AnyEvent, step: AnyStep): Promise<void> => {
    const { operationId } = event.payload;
    const acquired = await step.do("mark-running", async () => {
      const now = new Date().toISOString();
      const result = await env.DB
        .prepare(`UPDATE async_operations SET status = 'running', updated_at = ?1 WHERE id = ?2 AND status = 'queued'`)
        .bind(now, operationId)
        .run();
      return Number(result.meta.changes ?? 0) === 1;
    });
    if (!acquired) return;
    let result: { status: string; error?: string };
    try {
      result = await step.do("process", async () => fn(env, operationId));
    } catch {
      await step.do("record-exhausted-failure", async () => {
        await env.DB.prepare(`UPDATE async_operations SET status = 'failed', error = '作业重试失败，请重新发起', updated_at = ?1 WHERE id = ?2 AND status = 'running'`)
          .bind(new Date().toISOString(), operationId).run();
      });
      return;
    }
    await step.do("finalize", async () => {
      const now = new Date().toISOString();
      if (result.status === "succeeded") {
        await env.DB.prepare(`UPDATE async_operations SET status = 'succeeded', updated_at = ?1 WHERE id = ?2 AND status = 'running'`).bind(now, operationId).run();
      } else {
        await env.DB.prepare(`UPDATE async_operations SET status = 'failed', error = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'running'`)
          .bind(result.error ?? "unknown", now, operationId)
          .run();
      }
    });
  };
}

export class ParseDocumentWorkflow extends WorkflowEntrypoint<Env, OperationParams> {
  async run(event: AnyEvent, step: AnyStep): Promise<void> {
    return makeRunner(runParseDocument)(this.env, event, step);
  }
}

export class ParseJobRequirementsWorkflow extends WorkflowEntrypoint<Env, OperationParams> {
  async run(event: AnyEvent, step: AnyStep): Promise<void> {
    return makeRunner(runParseJobRequirements)(this.env, event, step);
  }
}

export class GenerateMatchWorkflow extends WorkflowEntrypoint<Env, OperationParams> {
  async run(event: AnyEvent, step: AnyStep): Promise<void> {
    return makeRunner(runGenerateMatch)(this.env, event, step);
  }
}

export class GeneratePlanWorkflow extends WorkflowEntrypoint<Env, OperationParams> {
  async run(event: AnyEvent, step: AnyStep): Promise<void> {
    return makeRunner(runGeneratePlan)(this.env, event, step);
  }
}

export class RewriteResumeWorkflow extends WorkflowEntrypoint<Env, OperationParams> {
  async run(event: AnyEvent, step: AnyStep): Promise<void> {
    return makeRunner(runRewriteResume)(this.env, event, step);
  }
}
