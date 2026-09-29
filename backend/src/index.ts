import { createApp } from "./app";
import { ParseDocumentWorkflow, GenerateMatchWorkflow, GeneratePlanWorkflow, RewriteResumeWorkflow } from "./infra/workflows";

const app = createApp();

export default {
  fetch: app.fetch,
  // 定时提醒调度在 M5 里程碑接入（src/application/reminders.ts 的 cronTick）
};

export { app, ParseDocumentWorkflow, GenerateMatchWorkflow, GeneratePlanWorkflow, RewriteResumeWorkflow };
