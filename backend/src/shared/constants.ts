/** 可版本化默认规则集标识；规则变更时递增（rules-v2...）。 */
export const RULE_VERSION = "rules-v1";

/** 文件限制（PLAN.md 2.4）：单文件 10MB、PDF 30 页。 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 30;

export const SUPPORTED_MIME = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] as const;

/** 同步支持离线编辑的实体（PLAN.md 2.6）。 */
export const SYNC_ENTITIES = [
  "profile",
  "experience",
  "skill",
  "evidence",
  "job",
  "portfolio",
  "task",
  "application",
  "application_event",
  "interview",
  "time_entry",
] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

/** 作业类型（PLAN.md 2.4：解析、解释、计划生成、简历改写）。 */
export const OPERATION_TYPES = ["parse_document", "generate_match", "generate_plan", "rewrite_resume"] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

export const APPLICATION_STATUSES = [
  "preparing",
  "submitted",
  "interviewing",
  "offered",
  "rejected",
  "withdrawn",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const DEMO_USERS = {
  student: "10000000-0000-4000-8000-000000000001",
  student2: "10000000-0000-4000-8000-000000000002",
  admin: "10000000-0000-4000-8000-0000000000ff",
} as const;

/** 默认时区（PLAN.md 2.6），服务端一律按 UTC 调度。 */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";
