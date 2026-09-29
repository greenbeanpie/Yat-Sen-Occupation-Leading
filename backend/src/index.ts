import { createApp } from "./app";
import { cronTick } from "./application/reminders";
import {
  ParseDocumentWorkflow,
  ParseJobRequirementsWorkflow,
  GenerateMatchWorkflow,
  GeneratePlanWorkflow,
  RewriteResumeWorkflow,
} from "./infra/workflows";
import type { Env } from "./env";

const app = createApp();

export default {
  fetch: app.fetch,
  /** Cron 每 15 分钟：扫描到期提醒并发送（PLAN.md 2.6）。 */
  scheduled: (_event: unknown, env: Env): Promise<unknown> => cronTick(env),
};

export {
  app,
  ParseDocumentWorkflow,
  ParseJobRequirementsWorkflow,
  GenerateMatchWorkflow,
  GeneratePlanWorkflow,
  RewriteResumeWorkflow,
};
