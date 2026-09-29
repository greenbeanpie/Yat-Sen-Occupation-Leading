import type { components } from '../api/schema';

/**
 * 演示数据适配器（PLAN.md 4：统一数据访问接口的演示适配器）。
 *
 * 本目录只实现“数据来源”这一层：对外暴露与 `fetch` 同形的传输函数，
 * 由 `src/api/client.ts` 在 `VITE_DATA_SOURCE=demo` 时选用；页面、ApiError、
 * pollOperation 与 HTTP 适配器共用同一份代码路径。
 */

export type Schema = components['schemas'];
export type Uuid = string;

/** 与 `fetch` 同形的传输函数；HTTP 适配器为 `fetch`，演示适配器为本文件的工厂产物。 */
export type DemoTransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface DemoFailure {
  status: number;
  code: string;
  message: string;
  /** true 时让 fetch 直接抛 TypeError，用于演示离线队列（而不是返回 5xx）。 */
  offline?: boolean;
}

export interface DemoTransportOptions {
  /** 每个请求的基础延迟（毫秒），默认 120；设为 0 可在测试中去掉等待。 */
  latencyMs?: number;
  /** 在基础延迟上叠加的随机抖动上限（毫秒），默认 80。 */
  latencyJitterMs?: number;
  /** 是否把演示数据写入 localStorage（默认 true）；false 时仅存在于内存。 */
  persist?: boolean;
  /** localStorage 键名，默认 `yso.workbench.demo.v1`。 */
  storageKey?: string;
  /** 可注入的时钟，便于测试。 */
  now?: () => Date;
  /** 启动后先失败的请求数（模拟网络/服务端故障）。 */
  failNextRequests?: number;
  /** 配合 failNextRequests 使用的失败响应。 */
  failure?: DemoFailure;
}

/** 演示控制开关：给演示与测试手动触发失败、延迟与重置。 */
export interface DemoControls {
  /** 让接下来的 count 个请求失败（默认 1 个，503 + `network_unavailable`）。 */
  failNextRequests(count?: number, failure?: Partial<DemoFailure>): void;
  /** 调整后续请求的模拟延迟。 */
  setLatency(latencyMs: number, jitterMs?: number): void;
  /** 清空演示数据并恢复到初始虚构数据。 */
  reset(): void;
  /** 当前演示会话身份（未登录为 null）。 */
  currentUser(): string | null;
}

export type DemoUser = Schema['DemoUser'] & {
  timezone: string;
  notifyTaskDue: boolean;
  notifyInterview: boolean;
};

/**
 * 记录类型：契约字段 + 后端实际返回的可空性。
 * OpenAPI 生成类型把部分列写成非空可选字段，而后端在这些列上会返回 null，
 * 演示适配器必须与真实响应一致，因此这里显式覆盖。
 */
export type ProfileRecord = Schema['Profile'];
export type ExperienceRecord = Omit<Schema['Experience'], 'startDate' | 'endDate'> & {
  startDate: string | null;
  endDate: string | null;
};
export type SkillRecord = Schema['Skill'];
export type EvidenceRecord = Schema['Evidence'];
export type JobRecord = Omit<Schema['Job'], 'userId' | 'deadlineDate'> & {
  userId: string | null;
  deadlineDate: string | null;
};
export type PortfolioRecord = Schema['Portfolio'];
export type PlanRecord = Omit<Schema['Plan'], 'portfolioId'> & {
  portfolioId: string | null;
  inputFingerprint: string;
};
export type PlanTaskRecord = Omit<
  Schema['PlanTask'],
  'jobId' | 'evidenceId' | 'scheduledDate' | 'estimateHours' | 'actualHours'
> & {
  jobId: string | null;
  evidenceId: string | null;
  scheduledDate: string | null;
  estimateHours: number | null;
  actualHours: number | null;
};
export type SuggestionRecord = Schema['AdjustmentSuggestion'];
export type RewriteRecord = Omit<Schema['Rewrite'], 'operationId'> & { operationId: string | null };
export type ApplicationRecord = Omit<Schema['Application'], 'jobId'> & { jobId: string | null };
export type ApplicationEventRecord = Omit<Schema['ApplicationEvent'], 'fromStatus' | 'toStatus' | 'note'> & {
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
};
export type InterviewRecord = Omit<Schema['Interview'], 'locationOrLink' | 'feedback'> & {
  locationOrLink: string | null;
  feedback: string | null;
};
export type TimeEntryRecord = Omit<Schema['TimeEntry'], 'applicationId' | 'taskId' | 'note'> & {
  applicationId: string | null;
  taskId: string | null;
  note: string | null;
};
export type DocumentRecord = Schema['Document'];

export interface RequirementRecord {
  id: string;
  jobId: string;
  jobVersion: number;
  kind: string;
  value: string;
  quote: string | null;
}

export interface RequirementDraftRecord {
  jobId: string;
  operationId: string;
  status: 'ready' | 'confirmed' | 'rejected';
  candidates: Schema['RequirementCandidate'][];
  createdAt: string;
}

export interface ParseDraftRecord {
  id: string;
  userId: string;
  documentId: string;
  operationId: string;
  status: 'ready' | 'confirmed' | 'rejected';
  result: ParseDraftResult;
  createdAt: string;
  updatedAt: string;
}

export interface ParseDraftExperience {
  title: string;
  organization: string;
  kind: ExperienceRecord['kind'];
  startDate?: string | null;
  endDate?: string | null;
  description: string;
  quote: string;
}

export interface ParseDraftSkill {
  name: string;
  quote: string;
}

export interface ParseDraftResult {
  experiences: ParseDraftExperience[];
  skills: ParseDraftSkill[];
  rejectedCounts: { experiences: number; skills: number };
  engine: string;
}

export interface MatchRecord extends Omit<Schema['MatchSnapshot'], 'inputVersions'> {
  userId: string;
  inputFingerprint: string;
  inputVersions: { profileVersion: number; experiences: { id: string; version: number }[] };
}

export type OperationRecord = Omit<Schema['Operation'], 'resultRef' | 'error'> & {
  userId: string;
  input: Record<string, unknown>;
  polls: number;
  resultRef: string | null;
  error: string | null;
};

export type ReminderRecord = Omit<Schema['Notification'], 'sentAt' | 'readAt'> & {
  userId: string;
  status: 'pending' | 'sent' | 'cancelled' | 'failed';
  dedupeKey: string;
  sentAt: string | null;
  readAt: string | null;
};

export type PushSubscriptionRecord = Schema['PushSubscription'] & {
  userId: string;
  keys: { p256dh: string; auth: string };
  updatedAt: string;
  deleted: boolean;
};

export interface ChangeRecord {
  seq: number;
  userId: string;
  entity: string;
  entityId: string;
  version: number;
  changeType: 'upsert' | 'delete';
  record: unknown;
  changedAt: string;
}

export interface SyncReceiptRecord {
  userId: string;
  opId: string;
  result: Schema['SyncResult'];
}

/** 演示适配器的全部状态；写入 localStorage 时整体序列化。 */
export interface DemoDatabase {
  schema: 1;
  seededAt: string;
  sessionUserId: string | null;
  users: DemoUser[];
  profiles: ProfileRecord[];
  experiences: ExperienceRecord[];
  skills: SkillRecord[];
  evidence: EvidenceRecord[];
  jobs: JobRecord[];
  requirements: RequirementRecord[];
  requirementDrafts: RequirementDraftRecord[];
  documents: DocumentRecord[];
  parseDrafts: ParseDraftRecord[];
  matches: MatchRecord[];
  portfolios: PortfolioRecord[];
  plans: PlanRecord[];
  tasks: PlanTaskRecord[];
  suggestions: SuggestionRecord[];
  rewrites: RewriteRecord[];
  applications: ApplicationRecord[];
  applicationEvents: ApplicationEventRecord[];
  interviews: InterviewRecord[];
  timeEntries: TimeEntryRecord[];
  operations: OperationRecord[];
  reminders: ReminderRecord[];
  pushSubscriptions: PushSubscriptionRecord[];
  changes: ChangeRecord[];
  syncReceipts: SyncReceiptRecord[];
  sequence: number;
}

export interface DemoRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  formData: FormData | null;
  userId: string | null;
}

export interface DemoResponse {
  status: number;
  body?: unknown;
}

/** 演示适配器内部抛出的、与后端统一错误包络一致的错误。 */
export class DemoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { field: string; issue: string }[],
    readonly server?: unknown,
  ) {
    super(message);
    this.name = 'DemoApiError';
  }
}

export const unauthorized = () => new DemoApiError(401, 'unauthorized', '未登录或会话已过期');
export const forbidden = (message = '没有执行该操作的权限') => new DemoApiError(403, 'forbidden', message);
export const notFound = (message = '资源不存在') => new DemoApiError(404, 'not_found', message);
export const invalidRequest = (details: { field: string; issue: string }[], message = '请求参数有误') =>
  new DemoApiError(422, 'invalid_request', message, details);
export const conflict = (message: string, server: unknown) => new DemoApiError(409, 'version_conflict', message, undefined, server);
export const syncRequired = (message: string) => new DemoApiError(409, 'sync_required', message);
export const unprocessableFile = (message: string) => new DemoApiError(422, 'unprocessable_file', message);
export const quoteRejected = (message: string) => new DemoApiError(422, 'quote_rejected', message);
