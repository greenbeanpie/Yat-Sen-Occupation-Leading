import {
  conflict,
  forbidden,
  invalidRequest,
  notFound,
  quoteRejected,
  syncRequired,
  unauthorized,
  unprocessableFile,
  type ApplicationEventRecord,
  type ApplicationRecord,
  type DemoDatabase,
  type DemoRequest,
  type DemoResponse,
  type DemoUser,
  type DocumentRecord,
  type EvidenceRecord,
  type ExperienceRecord,
  type InterviewRecord,
  type JobRecord,
  type MatchRecord,
  type OperationRecord,
  type ParseDraftRecord,
  type PlanRecord,
  type PlanTaskRecord,
  type PortfolioRecord,
  type ProfileRecord,
  type PushSubscriptionRecord,
  type RequirementDraftRecord,
  type RequirementRecord,
  type RewriteRecord,
  type Schema,
  type SkillRecord,
  type SuggestionRecord,
  type TimeEntryRecord,
} from './demo-types';
import {
  appendChange,
  cancelPendingReminders,
  createOperation,
  currentUser,
  DemoStore,
  materializeReminders,
  schedulePendingReminder,
  userById,
  zonedMorningIso,
} from './demo-store';
import {
  canTransition,
  canTransitionTask,
  computeMatchScores,
  evaluateHardConditions,
  RULE_VERSION,
  selectPortfolio,
  verifyQuote,
  type HardRequirement,
  type PortfolioCandidate,
  type SkillEvidence,
} from './demo-rules';
import { buildExampleResumeDraft, isExampleResume } from './demo-seed';
import { isAdministrativeRole } from '../roles';

/**
 * 演示适配器的接口实现：与后端同一套路径、状态码、错误码和数据结构，
 * 由 `handleDemoRequest` 统一分发。契约字段全部复用 `src/api/schema.ts` 的生成类型。
 */

interface RouteContext {
  store: DemoStore;
  db: DemoDatabase;
  request: DemoRequest;
  user: DemoUser;
  params: Record<string, string>;
}

interface Route {
  method: string;
  path: string;
  /** 需要登录。 */
  auth?: boolean;
  /** 需要管理员。 */
  admin?: boolean;
  handler: (ctx: RouteContext) => DemoResponse;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_MIME = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

export function handleDemoRequest(store: DemoStore, request: DemoRequest): DemoResponse {
  const route = ROUTES.find((candidate) => candidate.method === request.method && matches(candidate.path, request.path));
  if (!route) throw notFound('演示数据源暂不支持该接口');
  const params = extractParams(route.path, request.path);

  // 演示数据全部走读写快照：GET 也需要推进作业状态、生成提醒。
  return store.write((db) => {
    const user = currentUser(db);
    if (route.auth && !user) throw unauthorized();
    if (route.admin && !isAdministrativeRole(user?.role)) throw forbidden('仅管理员可执行该操作');
    return route.handler({ store, db, request, user: user as DemoUser, params });
  });
}

function matches(pattern: string, path: string): boolean {
  return regexpOf(pattern).test(path);
}

function extractParams(pattern: string, path: string): Record<string, string> {
  const names: string[] = [];
  const source = pattern.replace(/:([A-Za-z_]+)/g, (_match, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  const matched = new RegExp(`^${source}$`).exec(path);
  const params: Record<string, string> = {};
  if (!matched) return params;
  names.forEach((name, index) => {
    params[name] = decodeURIComponent(matched[index + 1] ?? '');
  });
  return params;
}

const regexpCache = new Map<string, RegExp>();

function regexpOf(pattern: string): RegExp {
  const cached = regexpCache.get(pattern);
  if (cached) return cached;
  const source = pattern.replace(/:([A-Za-z_]+)/g, '([^/]+)');
  const built = new RegExp(`^${source}$`);
  regexpCache.set(pattern, built);
  return built;
}

// ---------------------------------------------------------------------------
// 会话与画像
// ---------------------------------------------------------------------------

function capabilities() {
  // 演示数据源没有 VAPID 密钥与真实推送通道，站内提醒可用（PLAN.md 2.6）。
  return { push: false, offline: true, demoMode: true };
}

function sessionPayload(db: DemoDatabase): Schema['SessionResponse'] {
  const user = currentUser(db);
  if (!user) {
    return {
      authenticated: false,
      demoUsers: db.users.map(({ id, role, displayName }) => ({ id, role, displayName })),
      capabilities: capabilities(),
    };
  }
  return {
    authenticated: true,
    user: { id: user.id, role: user.role, displayName: user.displayName, timezone: user.timezone, demo: true },
    capabilities: capabilities(),
  };
}

const profileShell = (userId: string): ProfileRecord => ({
  id: '',
  userId,
  version: 0,
  deleted: false,
  createdAt: '',
  updatedAt: '',
  targetRoles: [],
  industries: [],
  graduationYear: null,
  degree: null,
  preferredLocations: [],
  weeklyTimeBudgetHours: null,
});

// ---------------------------------------------------------------------------
// 领域辅助
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireRow<T>(row: T | undefined, message = '资源不存在'): T {
  if (!row) throw notFound(message);
  return row;
}

function stripInternal(payload: Record<string, unknown>): Record<string, unknown> {
  const { baseVersion: _baseVersion, ...rest } = payload;
  return rest;
}

/** 乐观锁更新：baseVersion 不匹配返回 409 + 服务器当前记录。 */
function updateRow<T extends { id: string; version: number; deleted: boolean; updatedAt: string; userId?: string | null }>(
  db: DemoDatabase,
  entity: string,
  row: T,
  payload: Record<string, unknown>,
  baseVersion: number | null | undefined,
  nowIso: string,
): T {
  if (row.deleted) throw conflict('记录已被删除', clone(row));
  if (baseVersion !== undefined && baseVersion !== null && baseVersion !== row.version) {
    throw conflict('记录已被其他修改更新，请先查看服务器版本', clone(row));
  }
  const merged = Object.assign(row, stripInternal(payload), { version: row.version + 1, updatedAt: nowIso }) as T;
  appendChange(db, {
    userId: (merged.userId as string | null) ?? '',
    entity,
    entityId: merged.id,
    version: merged.version,
    changeType: 'upsert',
    record: clone(merged),
    changedAt: nowIso,
  });
  return merged;
}

function tombstone<T extends { id: string; version: number; deleted: boolean; updatedAt: string; userId?: string | null }>(
  db: DemoDatabase,
  entity: string,
  row: T,
  nowIso: string,
): void {
  row.deleted = true;
  row.version += 1;
  row.updatedAt = nowIso;
  appendChange(db, {
    userId: (row.userId as string | null) ?? '',
    entity,
    entityId: row.id,
    version: row.version,
    changeType: 'delete',
    record: { id: row.id, deleted: true },
    changedAt: nowIso,
  });
}

function jobJson(db: DemoDatabase, job: JobRecord): JobRecord {
  const requirements = db.requirements
    .filter((row) => row.jobId === job.id && row.jobVersion === job.jobVersion)
    .map((row) => ({ kind: row.kind, value: row.value, quote: row.quote }));
  return { ...clone(job), requirements };
}

function canEditJob(job: JobRecord, user: DemoUser): boolean {
  if (job.userId === null) return isAdministrativeRole(user.role);
  return job.userId === user.id;
}

function ruleContext(db: DemoDatabase, userId: string) {
  const profileRow = db.profiles.find((row) => row.userId === userId && !row.deleted);
  const experiences = db.experiences
    .filter((row) => row.userId === userId && !row.deleted)
    .map((row) => ({ id: row.id, version: row.version, title: row.title, description: row.description, kind: row.kind }));
  const evidence: SkillEvidence[] = db.evidence
    .filter((row) => row.userId === userId && !row.deleted)
    .flatMap((row) => {
      const skill = db.skills.find((candidate) => candidate.id === row.skillId && !candidate.deleted);
      return skill ? [{ skillName: skill.name, status: row.status }] : [];
    });
  return {
    profile: {
      degree: profileRow?.degree ?? null,
      graduationYear: profileRow?.graduationYear ?? null,
      preferredLocations: profileRow?.preferredLocations ?? [],
      targetRoles: profileRow?.targetRoles ?? [],
      industries: profileRow?.industries ?? [],
    },
    profileVersion: profileRow?.version ?? 0,
    weeklyTimeBudgetHours: profileRow?.weeklyTimeBudgetHours ?? null,
    experiences,
    evidence,
  };
}

/** 与后端 freshness.ts 同形的输入指纹：规则版本 + 画像版本 + 经历版本 + 附加输入。 */
function contextFingerprint(db: DemoDatabase, userId: string, extras: unknown[]): string {
  const ctx = ruleContext(db, userId);
  return JSON.stringify([
    RULE_VERSION,
    ctx.profileVersion,
    ctx.experiences.map((row) => [row.id, row.version]).sort(),
    ...extras,
  ]);
}

function assertFreshInputs(db: DemoDatabase, userId: string, clientProfileVersion?: number | null, clientExperienceVersions?: { id: string; version: number }[] | null): void {
  const ctx = ruleContext(db, userId);
  if (clientProfileVersion != null && clientProfileVersion > ctx.profileVersion) {
    throw syncRequired('画像存在未同步的修改，请先完成同步');
  }
  if (clientExperienceVersions && clientExperienceVersions.length > 0) {
    const server = new Map(ctx.experiences.map((row) => [row.id, row.version]));
    for (const item of clientExperienceVersions) {
      const version = server.get(item.id);
      if (version === undefined || item.version > version) {
        throw syncRequired('经历存在未同步的修改，请先完成同步');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 模拟模型输出（与后端 MockProvider 同形）
// ---------------------------------------------------------------------------

function firstSentence(text: string, minLength = 6): string | null {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length < minLength) return null;
  const matched = /[^。！？.!?]{6,120}[。！？.!?]?/.exec(cleaned);
  return matched ? matched[0].trim() : cleaned.slice(0, 80);
}

const KNOWN_SKILLS = ['JavaScript', 'TypeScript', 'Python', 'React', 'Vue', 'Node.js', 'SQL', 'Java', 'Go', 'Docker', 'Git', '机器学习', '数据分析', '项目管理'];

function mockParseRequirements(jdText: string): Schema['RequirementCandidate'][] {
  const lines = jdText.split(/[\n。；;]+/).map((line) => line.trim()).filter(Boolean);
  const candidates: Schema['RequirementCandidate'][] = [];
  const degreeMap: Record<string, string> = { 专科: 'associate', 本科: 'bachelor', 硕士: 'master', 研究生: 'master', 博士: 'phd' };

  for (const line of lines) {
    const quote = firstSentence(line, 4) ?? line.slice(0, 60);
    if (!candidates.some((item) => item.kind === 'degree')) {
      const degree = /(专科|本科|硕士|研究生|博士)/.exec(line);
      const mapped = degree ? degreeMap[degree[1] as string] : undefined;
      if (mapped) candidates.push({ kind: 'degree', value: mapped, quote });
    }
    const year = /(\d{4})\s*届/.exec(line);
    if (year && !candidates.some((item) => item.kind === 'graduation_year')) {
      candidates.push({ kind: 'graduation_year', value: year[1] as string, quote });
    }
    const location = /(?:工作地点|地点|城市)[:：]\s*([\u4e00-\u9fa5]{2,8})/.exec(line);
    if (location && !candidates.some((item) => item.kind === 'location')) {
      candidates.push({ kind: 'location', value: location[1] as string, quote });
    }
    for (const skill of KNOWN_SKILLS) {
      if (line.includes(skill) && !candidates.some((item) => item.kind === 'skill' && item.value === skill)) {
        candidates.push({ kind: 'skill', value: skill, quote });
      }
    }
  }
  return candidates.slice(0, 15);
}

function mockMatchExplanation(jdText: string, gaps: string[], total: number) {
  const quote = firstSentence(jdText) ?? '';
  return {
    summary: `综合匹配分 ${Math.round(total * 100)} 分（演示数据源的确定性解释，仅供演示）`,
    advantages: quote ? [{ text: '技能与岗位要求存在重叠（演示）', quotes: [{ text: quote, location: 'jd' }] }] : [],
    gaps: gaps.slice(0, 5).map((gap) => ({ text: gap, quotes: [] })),
    prepSuggestions: quote ? [{ text: '优先补齐差距项（演示）', quotes: [{ text: quote, location: 'jd' }] }] : [],
    rejectedQuotes: 0,
  };
}

/** 把解释里命中原文的引用汇总成 MatchSnapshot.quotes（与后端一致，未命中的丢弃）。 */
function quoteRefsFor(jdText: string, quotes: string[]): Schema['QuoteRef'][] {
  const refs: Schema['QuoteRef'][] = [];
  for (const text of quotes) {
    if (!text || !verifyQuote(jdText, text)) continue;
    const start = jdText.indexOf(text);
    refs.push({ text, source: 'jd', location: start >= 0 ? `${start}-${start + text.length}` : '' });
  }
  return refs;
}

function mockPlanTasks() {
  return [
    { title: '核对画像与经历', description: '检查解析与手动录入的内容是否准确', estimateHours: 1 },
    { title: '针对岗位补齐关键证据', description: '为岗位硬条件关联已确认经历', estimateHours: 2 },
    { title: '改写简历要点', description: '按岗位调整简历表述，逐条确认', estimateHours: 2 },
    { title: '准备面试问题清单', description: '围绕岗位要求准备问答', estimateHours: 3 },
  ];
}

function mockRewrite(description: string) {
  const quote = firstSentence(description, 4) ?? '';
  if (!quote) return [];
  return [
    {
      originalQuote: quote,
      suggestion: `${quote.replace(/[。.!！]?$/, '')}，表述更聚焦岗位职责与产出（演示改写，不新增事实）。`,
      rationale: '只调整措辞，不新增未确认的事实或数字（演示）',
    },
  ];
}

// ---------------------------------------------------------------------------
// 路由表
// ---------------------------------------------------------------------------

const ROUTES: Route[] = [
  {
    method: 'GET',
    path: '/session',
    handler: ({ db }) => ({ status: 200, body: sessionPayload(db) }),
  },
  {
    method: 'POST',
    path: '/session',
    handler: ({ db, request }) => {
      const body = (request.body ?? {}) as { userId?: string };
      if (!body.userId || !userById(db, body.userId)) {
        throw notFound('演示身份不存在');
      }
      db.sessionUserId = body.userId;
      return { status: 200, body: sessionPayload(db) };
    },
  },
  {
    method: 'DELETE',
    path: '/session',
    handler: ({ db }) => {
      db.sessionUserId = null;
      return { status: 204 };
    },
  },
  {
    method: 'POST',
    path: '/demo/reset',
    auth: true,
    handler: ({ db, user }) => {
      const deletedRows = resetUserData(db, user.id);
      const body: Schema['DemoResetResponse'] = { reset: true, userId: user.id, deletedRows };
      return { status: 200, body };
    },
  },
  {
    method: 'GET',
    path: '/profile',
    auth: true,
    handler: ({ db, user }) => ({ status: 200, body: clone(db.profiles.find((row) => row.userId === user.id) ?? profileShell(user.id)) }),
  },
  {
    method: 'PUT',
    path: '/profile',
    auth: true,
    handler: ({ store, db, user, request }) => {
      const payload = (request.body ?? {}) as Record<string, unknown>;
      const existing = db.profiles.find((row) => row.userId === user.id);
      if (!existing) {
        const created: ProfileRecord = {
          ...profileShell(user.id),
          ...stripInternal(payload),
          id: store.uuid(),
          version: 1,
          createdAt: store.nowIso(),
          updatedAt: store.nowIso(),
        };
        db.profiles.push(created);
        appendChange(db, {
          userId: user.id,
          entity: 'profile',
          entityId: created.id,
          version: 1,
          changeType: 'upsert',
          record: clone(created),
          changedAt: created.updatedAt,
        });
        return { status: 200, body: clone(created) };
      }
      const baseVersion = payload.baseVersion as number | undefined;
      if (baseVersion !== undefined && baseVersion !== null && baseVersion !== existing.version) {
        throw conflict('画像已被其他修改更新', clone(existing));
      }
      const updated = updateRow(db, 'profile', existing, payload, baseVersion ?? null, store.nowIso());
      return { status: 200, body: clone(updated) };
    },
  },
  {
    method: 'GET',
    path: '/evidence',
    auth: true,
    handler: ({ db, user }) => ({
      status: 200,
      body: {
        experiences: db.experiences.filter((row) => row.userId === user.id && !row.deleted).map(clone),
        skills: db.skills.filter((row) => row.userId === user.id && !row.deleted).map(clone),
        links: db.evidence.filter((row) => row.userId === user.id && !row.deleted).map(clone),
      },
    }),
  },
  {
    method: 'POST',
    path: '/evidence/experiences',
    auth: true,
    handler: ({ store, db, user, request }) => {
      const payload = stripInternal((request.body ?? {}) as Record<string, unknown>);
      if (!payload.title || !payload.description) {
        throw invalidRequest([{ field: !payload.title ? 'title' : 'description', issue: '该字段为必填' }]);
      }
      const now = store.nowIso();
      const created: ExperienceRecord = {
        id: store.uuid(),
        userId: user.id,
        version: 1,
        deleted: false,
        createdAt: now,
        updatedAt: now,
        title: String(payload.title),
        organization: String(payload.organization ?? ''),
        kind: (payload.kind as ExperienceRecord['kind']) ?? 'other',
        startDate: (payload.startDate as string | null) ?? null,
        endDate: (payload.endDate as string | null) ?? null,
        description: String(payload.description),
      };
      db.experiences.push(created);
      appendChange(db, { userId: user.id, entity: 'experience', entityId: created.id, version: 1, changeType: 'upsert', record: clone(created), changedAt: now });
      return { status: 201, body: clone(created) };
    },
  },
  {
    method: 'PUT',
    path: '/evidence/experiences/:id',
    auth: true,
    handler: ({ store, db, user, request, params }) => {
      const row = requireRow(db.experiences.find((item) => item.id === params.id && item.userId === user.id));
      const payload = (request.body ?? {}) as Record<string, unknown>;
      return { status: 200, body: clone(updateRow(db, 'experience', row, payload, payload.baseVersion as number, store.nowIso())) };
    },
  },
  {
    method: 'DELETE',
    path: '/evidence/experiences/:id',
    auth: true,
    handler: ({ store, db, user, params }) => {
      const row = requireRow(db.experiences.find((item) => item.id === params.id && item.userId === user.id));
      tombstone(db, 'experience', row, store.nowIso());
      return { status: 204 };
    },
  },
  {
    method: 'POST',
    path: '/evidence/skills',
    auth: true,
    handler: ({ store, db, user, request }) => {
      const name = String((request.body as { name?: string } | null)?.name ?? '').trim();
      if (!name) throw invalidRequest([{ field: 'name', issue: '该字段为必填' }]);
      const existing = db.skills.find((row) => row.userId === user.id && row.name === name && !row.deleted);
      if (existing) return { status: 201, body: clone(existing) };
      const now = store.nowIso();
      const created: SkillRecord = { id: store.uuid(), userId: user.id, version: 1, deleted: false, createdAt: now, updatedAt: now, name };
      db.skills.push(created);
      appendChange(db, { userId: user.id, entity: 'skill', entityId: created.id, version: 1, changeType: 'upsert', record: clone(created), changedAt: now });
      return { status: 201, body: clone(created) };
    },
  },
  {
    method: 'DELETE',
    path: '/evidence/skills/:id',
    auth: true,
    handler: ({ store, db, user, params }) => {
      const row = requireRow(db.skills.find((item) => item.id === params.id && item.userId === user.id));
      tombstone(db, 'skill', row, store.nowIso());
      return { status: 204 };
    },
  },
  {
    method: 'POST',
    path: '/evidence/links',
    auth: true,
    handler: ({ store, db, user, request }) => {
      const body = (request.body ?? {}) as { skillId?: string; experienceId?: string; quote?: string; status?: EvidenceRecord['status'] };
      if (!body.skillId || !body.experienceId || !body.quote) {
        throw invalidRequest([{ field: '(body)', issue: 'skillId、experienceId 与 quote 均为必填' }]);
      }
      const experience = requireRow(
        db.experiences.find((item) => item.id === body.experienceId && item.userId === user.id && !item.deleted),
        '经历不存在',
      );
      if (!verifyQuote(experience.description, body.quote)) {
        throw quoteRejected('引用未在经历原文中命中，请核对原文');
      }
      const skill = requireRow(db.skills.find((item) => item.id === body.skillId && item.userId === user.id && !item.deleted), '技能不存在');
      const now = store.nowIso();
      const created: EvidenceRecord = {
        id: store.uuid(),
        userId: user.id,
        version: 1,
        deleted: false,
        createdAt: now,
        updatedAt: now,
        skillId: skill.id,
        experienceId: experience.id,
        quote: body.quote,
        status: body.status ?? 'pending',
      };
      db.evidence.push(created);
      appendChange(db, { userId: user.id, entity: 'evidence', entityId: created.id, version: 1, changeType: 'upsert', record: clone(created), changedAt: now });
      return { status: 201, body: clone(created) };
    },
  },
  {
    method: 'PUT',
    path: '/evidence/links/:id',
    auth: true,
    handler: ({ store, db, user, request, params }) => {
      const row = requireRow(db.evidence.find((item) => item.id === params.id && item.userId === user.id));
      const payload = (request.body ?? {}) as Record<string, unknown>;
      return { status: 200, body: clone(updateRow(db, 'evidence', row, payload, payload.baseVersion as number, store.nowIso())) };
    },
  },
  {
    method: 'DELETE',
    path: '/evidence/links/:id',
    auth: true,
    handler: ({ store, db, user, params }) => {
      const row = requireRow(db.evidence.find((item) => item.id === params.id && item.userId === user.id));
      tombstone(db, 'evidence', row, store.nowIso());
      return { status: 204 };
    },
  },
  ...documentRoutes(),
  ...jobRoutes(),
  ...matchingRoutes(),
  ...planningRoutes(),
  ...trackingRoutes(),
  ...notificationRoutes(),
  ...syncRoutes(),
];

// ---------------------------------------------------------------------------
// 文档与解析
// ---------------------------------------------------------------------------

function documentRoutes(): Route[] {
  return [
    {
      method: 'POST',
      path: '/documents',
      auth: true,
      handler: ({ store, db, user, request }) => {
        const file = request.formData?.get('file');
        if (!(file instanceof File)) throw unprocessableFile('缺少文件字段 file');
        if (!SUPPORTED_MIME.includes(file.type)) throw unprocessableFile('仅支持 PDF 与 DOCX 文件');
        if (file.size > MAX_FILE_BYTES) throw unprocessableFile('文件超过 10MB 上限');
        const now = store.nowIso();
        const created: DocumentRecord = {
          id: store.uuid(),
          userId: user.id,
          version: 1,
          deleted: false,
          createdAt: now,
          updatedAt: now,
          filename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          pageCount: null,
          status: 'uploaded',
          error: null,
        };
        db.documents.push(created);
        appendChange(db, { userId: user.id, entity: 'document', entityId: created.id, version: 1, changeType: 'upsert', record: clone(created), changedAt: now });
        return { status: 201, body: clone(created) };
      },
    },
    {
      method: 'GET',
      path: '/documents',
      auth: true,
      handler: ({ db, user }) => ({
        status: 200,
        body: { items: db.documents.filter((row) => row.userId === user.id && !row.deleted).map(clone) },
      }),
    },
    {
      method: 'GET',
      path: '/documents/:id',
      auth: true,
      handler: ({ db, user, params }) => ({
        status: 200,
        body: clone(requireRow(db.documents.find((row) => row.id === params.id && row.userId === user.id))),
      }),
    },
    {
      method: 'DELETE',
      path: '/documents/:id',
      auth: true,
      handler: ({ store, db, user, params }) => {
        const row = requireRow(db.documents.find((item) => item.id === params.id && item.userId === user.id && !item.deleted));
        tombstone(db, 'document', row, store.nowIso());
        return { status: 204 };
      },
    },
    {
      method: 'POST',
      path: '/documents/:id/parse',
      auth: true,
      handler: ({ store, db, user, params }) => {
        const row = requireRow(db.documents.find((item) => item.id === params.id && item.userId === user.id && !item.deleted));
        const operation = createOperation(db, {
          id: store.uuid(),
          userId: user.id,
          type: 'parse_document',
          payload: { documentId: row.id, fingerprint: contextFingerprint(db, user.id, [row.id, row.filename, row.sizeBytes, row.version]) },
          createdAt: store.nowIso(),
        });
        return { status: 202, body: { operationId: operation.id } };
      },
    },
    {
      method: 'GET',
      path: '/documents/:id/draft',
      auth: true,
      handler: ({ db, user, params }) => {
        const draft = db.parseDrafts
          .filter((row) => row.documentId === params.id && row.userId === user.id && row.status === 'ready')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (!draft) throw notFound('尚无就绪解析草稿');
        return {
          status: 200,
          body: { id: draft.id, documentId: draft.documentId, operationId: draft.operationId, status: draft.status, result: clone(draft.result), createdAt: draft.createdAt },
        };
      },
    },
    {
      method: 'POST',
      path: '/documents/:id/confirm',
      auth: true,
      handler: ({ store, db, user, params }) => {
        const document = requireRow(db.documents.find((item) => item.id === params.id && item.userId === user.id && !item.deleted));
        const draft = db.parseDrafts
          .filter((row) => row.documentId === document.id && row.userId === user.id && row.status === 'ready')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const ready = requireRow(draft, '尚无就绪解析草稿');
        const now = store.nowIso();
        const experienceIds: string[] = [];
        const skillIds: string[] = [];
        for (const item of ready.result.experiences) {
          const created: ExperienceRecord = {
            id: store.uuid(),
            userId: user.id,
            version: 1,
            deleted: false,
            createdAt: now,
            updatedAt: now,
            title: item.title,
            organization: item.organization,
            kind: item.kind,
            startDate: item.startDate ?? null,
            endDate: item.endDate ?? null,
            description: item.description,
          };
          db.experiences.push(created);
          experienceIds.push(created.id);
          appendChange(db, { userId: user.id, entity: 'experience', entityId: created.id, version: 1, changeType: 'upsert', record: clone(created), changedAt: now });
        }
        for (const item of ready.result.skills) {
          let skill = db.skills.find((row) => row.userId === user.id && row.name === item.name && !row.deleted);
          if (!skill) {
            skill = { id: store.uuid(), userId: user.id, version: 1, deleted: false, createdAt: now, updatedAt: now, name: item.name };
            db.skills.push(skill);
            appendChange(db, { userId: user.id, entity: 'skill', entityId: skill.id, version: 1, changeType: 'upsert', record: clone(skill), changedAt: now });
          }
          skillIds.push(skill.id);
          const target = ready.result.experiences.findIndex((experience) => verifyQuote(experience.description, item.quote));
          if (target < 0) continue;
          const link: EvidenceRecord = {
            id: store.uuid(),
            userId: user.id,
            version: 1,
            deleted: false,
            createdAt: now,
            updatedAt: now,
            skillId: skill.id,
            experienceId: experienceIds[target] as string,
            quote: item.quote,
            status: 'pending',
          };
          db.evidence.push(link);
          appendChange(db, { userId: user.id, entity: 'evidence', entityId: link.id, version: 1, changeType: 'upsert', record: clone(link), changedAt: now });
        }
        ready.status = 'confirmed';
        ready.updatedAt = now;
        document.status = 'confirmed';
        document.error = null;
        document.updatedAt = now;
        return { status: 200, body: { experienceIds, skillIds } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 岗位
// ---------------------------------------------------------------------------

function jobRoutes(): Route[] {
  return [
    {
      method: 'GET',
      path: '/jobs',
      auth: true,
      handler: ({ db, user, request }) => {
        const scope = request.query.get('scope') ?? 'public';
        const keyword = (request.query.get('q') ?? '').trim().toLowerCase();
        const degree = request.query.get('degree');
        const location = request.query.get('location');
        const rows = db.jobs.filter((job) => {
          if (job.deleted) return false;
          if (scope === 'mine') {
            if (job.userId !== user.id) return false;
          } else if (isAdministrativeRole(user.role)) {
            if (job.userId !== null) return false;
          } else if (job.userId !== null || job.status !== 'published') {
            return false;
          }
          if (keyword && !`${job.title} ${job.jdText}`.toLowerCase().includes(keyword)) return false;
          if (degree && job.degreeRequirement !== degree) return false;
          if (location && !(job.location ?? '').includes(location)) return false;
          return true;
        });
        return { status: 200, body: { items: rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((job) => jobJson(db, job)) } };
      },
    },
    {
      method: 'POST',
      path: '/jobs',
      auth: true,
      handler: ({ store, db, user, request }) => {
        const payload = (request.body ?? {}) as Record<string, unknown>;
        if (!payload.title) throw invalidRequest([{ field: 'title', issue: '该字段为必填' }]);
        const created = createJobRecord(store, db, { ownerId: user.id, actorId: user.id, payload, status: 'draft' });
        return { status: 201, body: jobJson(db, created) };
      },
    },
    {
      method: 'GET',
      path: '/jobs/:id',
      auth: true,
      handler: ({ db, user, params }) => {
        const job = requireRow(db.jobs.find((row) => row.id === params.id && !row.deleted));
        const visible =
          (job.userId !== null && job.userId === user.id) ||
          (job.userId === null && (job.status === 'published' || isAdministrativeRole(user.role)));
        if (!visible) throw notFound();
        return { status: 200, body: jobJson(db, job) };
      },
    },
    {
      method: 'PUT',
      path: '/jobs/:id',
      auth: true,
      handler: ({ store, db, user, request, params }) => {
        const job = requireRow(db.jobs.find((row) => row.id === params.id && !row.deleted));
        if (!canEditJob(job, user)) throw forbidden('只能修改自己的私人岗位');
        const payload = (request.body ?? {}) as Record<string, unknown>;
        const baseVersion = payload.baseVersion as number;
        if (baseVersion !== job.version) throw conflict('岗位已被其他修改更新', jobJson(db, job));
        const jdChanged = payload.jdText !== undefined && payload.jdText !== job.jdText;
        if (jdChanged) {
          job.jobVersion += 1;
          db.requirements = db.requirements.filter((row) => row.jobId !== job.id);
          db.requirementDrafts = db.requirementDrafts.filter((row) => row.jobId !== job.id);
        }
        updateRow(db, 'job', job, payload, baseVersion, store.nowIso());
        return { status: 200, body: jobJson(db, job) };
      },
    },
    {
      method: 'DELETE',
      path: '/jobs/:id',
      auth: true,
      handler: ({ store, db, user, params }) => {
        const job = requireRow(db.jobs.find((row) => row.id === params.id && !row.deleted));
        if (!canEditJob(job, user)) throw forbidden('只能删除自己的私人岗位');
        tombstone(db, 'job', job, store.nowIso());
        return { status: 204 };
      },
    },
    {
      method: 'POST',
      path: '/jobs/:id/parse-requirements',
      auth: true,
      handler: ({ store, db, user, params }) => {
        const job = requireRow(db.jobs.find((row) => row.id === params.id && !row.deleted));
        if (!canEditJob(job, user)) throw forbidden('只能解析自己的岗位');
        const operation = createOperation(db, {
          id: store.uuid(),
          userId: user.id,
          type: 'parse_job_requirements',
          payload: { jobId: job.id, fingerprint: contextFingerprint(db, user.id, [job.id, job.jobVersion, job.jdText]) },
          createdAt: store.nowIso(),
        });
        return { status: 202, body: { operationId: operation.id } };
      },
    },
    {
      method: 'GET',
      path: '/jobs/:id/requirements-draft',
      auth: true,
      handler: ({ db, user, params }) => {
        const job = requireRow(db.jobs.find((row) => row.id === params.id && !row.deleted));
        if (!canEditJob(job, user)) throw forbidden('无权查看该岗位');
        const draft = db.requirementDrafts
          .filter((row) => row.jobId === job.id && row.status === 'ready')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (!draft) throw notFound('尚无就绪的要求解析草稿');
        return { status: 200, body: { jobId: draft.jobId, operationId: draft.operationId, status: draft.status, candidates: clone(draft.candidates) } };
      },
    },
    {
      method: 'POST',
      path: '/jobs/:id/requirements/confirm',
      auth: true,
      handler: ({ store, db, user, params }) => {
        const job = requireRow(db.jobs.find((row) => row.id === params.id && !row.deleted));
        if (!canEditJob(job, user)) throw forbidden('无权修改该岗位');
        const draft = db.requirementDrafts
          .filter((row) => row.jobId === job.id && row.status === 'ready')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const ready = requireRow(draft, '尚无就绪的要求解析草稿');
        const now = store.nowIso();
        db.requirements = db.requirements.filter((row) => !(row.jobId === job.id && row.jobVersion === job.jobVersion));
        for (const candidate of ready.candidates) {
          const row: RequirementRecord = {
            id: store.uuid(),
            jobId: job.id,
            jobVersion: job.jobVersion,
            kind: candidate.kind,
            value: candidate.value,
            quote: candidate.quote ?? null,
          };
          db.requirements.push(row);
        }
        const degree = ready.candidates.find((item) => item.kind === 'degree')?.value ?? job.degreeRequirement;
        const location = ready.candidates.find((item) => item.kind === 'location')?.value ?? job.location;
        const year = ready.candidates.find((item) => item.kind === 'graduation_year')?.value;
        job.degreeRequirement = degree ?? null;
        job.location = location ?? null;
        job.graduationYearFrom = year ? Number(year) : job.graduationYearFrom;
        job.graduationYearTo = year ? Number(year) : job.graduationYearTo;
        job.updatedAt = now;
        ready.status = 'confirmed';
        return { status: 200, body: { count: ready.candidates.length } };
      },
    },
    {
      method: 'GET',
      path: '/admin/jobs',
      auth: true,
      admin: true,
      handler: ({ db }) => ({
        status: 200,
        body: { items: db.jobs.filter((job) => job.userId === null && !job.deleted).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((job) => jobJson(db, job)) },
      }),
    },
    {
      method: 'POST',
      path: '/admin/jobs',
      auth: true,
      admin: true,
      handler: ({ store, db, request }) => {
        const payload = (request.body ?? {}) as Record<string, unknown>;
        if (!payload.title) throw invalidRequest([{ field: 'title', issue: '该字段为必填' }]);
        const created = createJobRecord(store, db, { ownerId: null, actorId: null, payload, status: 'draft' });
        return { status: 201, body: jobJson(db, created) };
      },
    },
    {
      method: 'PUT',
      path: '/admin/jobs/:id',
      auth: true,
      admin: true,
      handler: ({ store, db, request, params }) => {
        const job = requireRow(db.jobs.find((row) => row.id === params.id && row.userId === null && !row.deleted));
        const payload = (request.body ?? {}) as Record<string, unknown>;
        const baseVersion = payload.baseVersion as number;
        if (baseVersion !== job.version) throw conflict('岗位已被其他修改更新', jobJson(db, job));
        const jdChanged = payload.jdText !== undefined && payload.jdText !== job.jdText;
        if (jdChanged) {
          job.jobVersion += 1;
          db.requirements = db.requirements.filter((row) => row.jobId !== job.id);
          db.requirementDrafts = db.requirementDrafts.filter((row) => row.jobId !== job.id);
        }
        updateRow(db, 'job', job, payload, baseVersion, store.nowIso());
        return { status: 200, body: jobJson(db, job) };
      },
    },
    {
      method: 'POST',
      path: '/admin/jobs/:id/publish',
      auth: true,
      admin: true,
      handler: ({ store, db, request, params }) => {
        const job = requireRow(db.jobs.find((row) => row.id === params.id && row.userId === null && !row.deleted));
        const action = (request.body as { action?: string } | null)?.action;
        if (action !== 'publish' && action !== 'unpublish' && action !== 'archive') {
          throw invalidRequest([{ field: 'action', issue: 'action 必须是 publish、unpublish 或 archive' }]);
        }
        job.status = action === 'publish' ? 'published' : action === 'archive' ? 'archived' : 'draft';
        job.updatedAt = store.nowIso();
        return { status: 200, body: jobJson(db, job) };
      },
    },
  ];
}

function createJobRecord(
  store: DemoStore,
  db: DemoDatabase,
  input: { ownerId: string | null; actorId: string | null; payload: Record<string, unknown>; status: JobRecord['status'] },
): JobRecord {
  const { ownerId, actorId, payload, status } = input;
  const now = store.nowIso();
  const created: JobRecord = {
    id: store.uuid(),
    userId: ownerId,
    scope: ownerId === null ? 'public' : 'private',
    version: 1,
    deleted: false,
    createdAt: now,
    updatedAt: now,
    title: String(payload.title ?? ''),
    company: String(payload.company ?? ''),
    location: (payload.location as string | null) ?? null,
    degreeRequirement: (payload.degreeRequirement as string | null) ?? null,
    graduationYearFrom: (payload.graduationYearFrom as number | null) ?? null,
    graduationYearTo: (payload.graduationYearTo as number | null) ?? null,
    sourceUrl: (payload.sourceUrl as string | null) ?? null,
    deadlineDate: (payload.deadlineDate as string | null) ?? null,
    status,
    jdText: String(payload.jdText ?? ''),
    jobVersion: 1,
    requirements: [],
  };
  db.jobs.push(created);
  appendChange(db, {
    userId: actorId ?? '',
    entity: 'job',
    entityId: created.id,
    version: 1,
    changeType: 'upsert',
    record: clone(created),
    changedAt: now,
  });
  return created;
}

// ---------------------------------------------------------------------------
// 匹配与组合
// ---------------------------------------------------------------------------

function matchingRoutes(): Route[] {
  return [
    {
      method: 'POST',
      path: '/matches',
      auth: true,
      handler: ({ store, db, user, request }) => {
        const body = (request.body ?? {}) as { jobId?: string; clientProfileVersion?: number | null; clientExperienceVersions?: { id: string; version: number }[] };
        if (!body.jobId) throw invalidRequest([{ field: 'jobId', issue: '该字段为必填' }]);
        assertFreshInputs(db, user.id, body.clientProfileVersion, body.clientExperienceVersions);
        const job = requireRow(db.jobs.find((row) => row.id === body.jobId && !row.deleted), '岗位不存在');
        const operation = createOperation(db, {
          id: store.uuid(),
          userId: user.id,
          type: 'generate_match',
          payload: { jobId: job.id, fingerprint: contextFingerprint(db, user.id, [job.id, job.jobVersion]) },
          createdAt: store.nowIso(),
        });
        return { status: 202, body: { operationId: operation.id } };
      },
    },
    {
      method: 'GET',
      path: '/matches',
      auth: true,
      handler: ({ db, user, request }) => {
        const jobId = request.query.get('jobId') ?? '';
        const items = db.matches
          .filter((row) => row.userId === user.id && row.jobId === jobId && row.status !== 'failed')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 20)
          .map((row) => matchJson(db, user.id, row));
        return { status: 200, body: { items } };
      },
    },
    {
      method: 'GET',
      path: '/matches/:id',
      auth: true,
      handler: ({ db, user, params }) => {
        const row = requireRow(db.matches.find((item) => item.id === params.id && item.userId === user.id));
        return { status: 200, body: matchJson(db, user.id, row) };
      },
    },
    {
      method: 'POST',
      path: '/portfolios',
      auth: true,
      handler: ({ store, db, user, request }) => {
        const body = (request.body ?? {}) as { timeBudgetHours?: number; pinnedJobIds?: string[]; removedJobIds?: string[]; asOfDate?: string | null };
        const created = computePortfolio(store, db, user.id, body.timeBudgetHours ?? 8, body.pinnedJobIds ?? [], body.removedJobIds ?? [], body.asOfDate ?? null);
        return { status: 201, body: created };
      },
    },
    {
      method: 'GET',
      path: '/portfolios',
      auth: true,
      handler: ({ db, user }) => ({
        status: 200,
        body: { items: db.portfolios.filter((row) => row.userId === user.id && !row.deleted).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone) },
      }),
    },
    {
      method: 'GET',
      path: '/portfolios/:id',
      auth: true,
      handler: ({ db, user, params }) => ({
        status: 200,
        body: clone(requireRow(db.portfolios.find((row) => row.id === params.id && row.userId === user.id && !row.deleted))),
      }),
    },
    {
      method: 'PUT',
      path: '/portfolios/:id',
      auth: true,
      handler: ({ store, db, user, request, params }) => {
        const existing = requireRow(db.portfolios.find((row) => row.id === params.id && row.userId === user.id && !row.deleted));
        const body = (request.body ?? {}) as { timeBudgetHours?: number; pinnedJobIds?: string[]; removedJobIds?: string[]; asOfDate?: string | null };
        const updated = computePortfolio(
          store,
          db,
          user.id,
          body.timeBudgetHours ?? existing.timeBudgetHours,
          body.pinnedJobIds ?? [],
          body.removedJobIds ?? [],
          body.asOfDate ?? null,
          existing,
        );
        return { status: 200, body: updated };
      },
    },
  ];
}

function matchJson(db: DemoDatabase, userId: string, row: MatchRecord): Schema['MatchSnapshot'] {
  const job = db.jobs.find((item) => item.id === row.jobId);
  const current = contextFingerprint(db, userId, [row.jobId, job?.jobVersion ?? 0]);
  return { ...clone(row), status: current === row.inputFingerprint ? row.status : 'stale' };
}

function computePortfolio(
  store: DemoStore,
  db: DemoDatabase,
  userId: string,
  budgetHours: number,
  pinnedJobIds: string[],
  removedJobIds: string[],
  asOfDate: string | null,
  existing?: PortfolioRecord,
): PortfolioRecord {
  const latestByJob = new Map<string, MatchRecord>();
  for (const row of db.matches.filter((item) => item.userId === userId && item.status === 'ready')) {
    const current = latestByJob.get(row.jobId);
    if (!current || current.createdAt < row.createdAt) latestByJob.set(row.jobId, row);
  }

  const candidates: PortfolioCandidate[] = [...latestByJob.values()].map((row) => {
    const job = db.jobs.find((item) => item.id === row.jobId);
    const prepHours = db.tasks
      .filter((task) => task.userId === userId && task.jobId === row.jobId && !task.deleted && task.estimateHours != null)
      .reduce((sum, task) => sum + (task.estimateHours ?? 0), 0);
    return {
      jobId: row.jobId,
      title: job?.title ?? '',
      score: row.scores.total,
      hardBlocked: row.hardConditions.some((condition) => condition.status !== 'met'),
      prepHours: prepHours > 0 ? prepHours : null,
      deadline: (job?.deadlineDate as string | null) ?? null,
    };
  });

  const selection = selectPortfolio(
    candidates,
    budgetHours,
    pinnedJobIds,
    removedJobIds,
    ruleContext(db, userId).weeklyTimeBudgetHours,
    asOfDate ?? store.today(),
  );
  const now = store.nowIso();
  if (existing) {
    existing.timeBudgetHours = budgetHours;
    existing.items = selection.items;
    existing.notes = selection.notes;
    existing.version += 1;
    existing.updatedAt = now;
    appendChange(db, { userId, entity: 'portfolio', entityId: existing.id, version: existing.version, changeType: 'upsert', record: clone(existing), changedAt: now });
    return clone(existing);
  }
  const created: PortfolioRecord = {
    id: store.uuid(),
    userId,
    version: 1,
    deleted: false,
    createdAt: now,
    updatedAt: now,
    timeBudgetHours: budgetHours,
    items: selection.items,
    notes: selection.notes,
  };
  db.portfolios.push(created);
  appendChange(db, { userId, entity: 'portfolio', entityId: created.id, version: 1, changeType: 'upsert', record: clone(created), changedAt: now });
  return clone(created);
}

// ---------------------------------------------------------------------------
// 计划、任务与改写
// ---------------------------------------------------------------------------

function planningRoutes(): Route[] {
  return [
    {
      method: 'POST',
      path: '/plans',
      auth: true,
      handler: ({ store, db, user, request }) => {
        const body = (request.body ?? {}) as { portfolioId?: string; clientProfileVersion?: number | null; clientExperienceVersions?: { id: string; version: number }[] };
        if (!body.portfolioId) throw invalidRequest([{ field: 'portfolioId', issue: '该字段为必填' }]);
        assertFreshInputs(db, user.id, body.clientProfileVersion, body.clientExperienceVersions);
        const portfolio = requireRow(db.portfolios.find((row) => row.id === body.portfolioId && row.userId === user.id && !row.deleted), '组合不存在');
        const operation = createOperation(db, {
          id: store.uuid(),
          userId: user.id,
          type: 'generate_plan',
          payload: { portfolioId: portfolio.id, fingerprint: contextFingerprint(db, user.id, [portfolio.id, portfolio.version]) },
          createdAt: store.nowIso(),
        });
        return { status: 202, body: { operationId: operation.id } };
      },
    },
    {
      method: 'GET',
      path: '/plans',
      auth: true,
      handler: ({ db, user }) => ({
        status: 200,
        body: { items: db.plans.filter((row) => row.userId === user.id && !row.deleted).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone) },
      }),
    },
    {
      method: 'GET',
      path: '/plans/:id',
      auth: true,
      handler: ({ db, user, params }) => {
        const plan = requireRow(db.plans.find((row) => row.id === params.id && row.userId === user.id && !row.deleted));
        const tasks = db.tasks
          .filter((row) => row.planId === plan.id && row.userId === user.id && !row.deleted)
          .sort((a, b) => (a.scheduledDate ?? '').localeCompare(b.scheduledDate ?? '') || a.createdAt.localeCompare(b.createdAt));
        return { status: 200, body: { plan: clone(plan), tasks: tasks.map(clone) } };
      },
    },
    {
      method: 'POST',
      path: '/plans/:id/confirm',
      auth: true,
      handler: ({ store, db, user, params }) => {
        const plan = requireRow(db.plans.find((row) => row.id === params.id && row.userId === user.id && !row.deleted));
        if (plan.status !== 'draft') throw invalidRequest([{ field: 'id', issue: '计划不是草稿状态' }]);
        const current = contextFingerprint(db, user.id, [plan.portfolioId ?? '', plan.version]);
        if (current !== plan.inputFingerprint) {
          throw conflict('计划生成后画像或经历已变化，请重新生成', clone(plan));
        }
        const now = store.nowIso();
        plan.status = 'confirmed';
        plan.version += 1;
        plan.updatedAt = now;
        appendChange(db, { userId: user.id, entity: 'plan', entityId: plan.id, version: plan.version, changeType: 'upsert', record: clone(plan), changedAt: now });
        // 与后端一致：确认新计划时，其它已确认计划标记为 superseded（PLAN.md 2.5）。
        for (const other of db.plans) {
          if (other.userId !== user.id || other.id === plan.id || other.deleted || other.status !== 'confirmed') continue;
          other.status = 'superseded';
          other.version += 1;
          other.updatedAt = now;
          appendChange(db, { userId: user.id, entity: 'plan', entityId: other.id, version: other.version, changeType: 'upsert', record: clone(other), changedAt: now });
        }
        for (const task of db.tasks.filter((row) => row.planId === plan.id && row.userId === user.id && !row.deleted)) {
          if (task.status !== 'pending' && task.status !== 'in_progress') continue;
          if (!task.scheduledDate) continue;
          schedulePendingReminder(db, {
            userId: user.id,
            entity: 'task',
            entityId: task.id,
            kind: 'task_due_9am',
            fireAt: zonedMorningIso(task.scheduledDate, user.timezone, 9),
            title: `今日任务：${task.title}`,
            body: `计划日期 ${task.scheduledDate}`,
            dedupeKey: `task-due:${task.id}:${task.scheduledDate}`,
          });
        }
        return { status: 200, body: clone(plan) };
      },
    },
    {
      method: 'PATCH',
      path: '/tasks/:id',
      auth: true,
      handler: ({ store, db, user, request, params }) => {
        const task = requireRow(db.tasks.find((row) => row.id === params.id && row.userId === user.id && !row.deleted));
        const payload = (request.body ?? {}) as Record<string, unknown>;
        const baseVersion = payload.baseVersion as number;
        const plan = db.plans.find((row) => row.id === task.planId);
        const nextStatus = payload.status as string | undefined;
        if (nextStatus && !canTransitionTask(task.status, nextStatus)) {
          throw invalidRequest([{ field: 'status', issue: `任务不能从 ${task.status} 变为 ${nextStatus}` }]);
        }
        const suggestionId = plan ? maybeCreateAdjustment(db, user.id, plan, task, payload, baseVersion, store) : null;
        const updated = updateRow(db, 'task', task, payload, baseVersion, store.nowIso());
        if (plan?.status === 'confirmed') {
          if (updated.status === 'done' || updated.status === 'cancelled') cancelPendingReminders(db, user.id, 'task', updated.id);
          else if (payload.scheduledDate !== undefined && updated.scheduledDate) {
            schedulePendingReminder(db, {
              userId: user.id,
              entity: 'task',
              entityId: updated.id,
              kind: 'task_due_9am',
              fireAt: zonedMorningIso(updated.scheduledDate, user.timezone, 9),
              title: `今日任务：${updated.title}`,
              body: `计划日期 ${updated.scheduledDate}`,
              dedupeKey: `task-due:${updated.id}:${updated.scheduledDate}`,
            });
          }
        }
        return { status: 200, body: { task: clone(updated), suggestionId } };
      },
    },
    {
      method: 'GET',
      path: '/plans/:id/suggestions',
      auth: true,
      handler: ({ db, user, params }) => ({
        status: 200,
        body: {
          items: db.suggestions
            .filter((row) => row.planId === params.id && row.userId === user.id && !row.deleted)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map(clone),
        },
      }),
    },
    {
      method: 'POST',
      path: '/suggestions/:id/resolve',
      auth: true,
      handler: ({ store, db, user, request, params }) => {
        const suggestion = requireRow(db.suggestions.find((row) => row.id === params.id && row.userId === user.id && !row.deleted));
        if (suggestion.status !== 'pending') throw invalidRequest([{ field: 'id', issue: '建议已处理' }]);
        const action = (request.body as { action?: string } | null)?.action;
        if (action !== 'accept' && action !== 'reject') throw invalidRequest([{ field: 'action', issue: 'action 必须是 accept 或 reject' }]);
        if (action === 'accept') {
          const proposal = suggestion.proposal as { taskId?: string; taskBaseVersion?: number; setScheduledDate?: string | null; setEstimateHours?: number | null };
          if (proposal.taskId) {
            const task = db.tasks.find((row) => row.id === proposal.taskId && row.userId === user.id);
            if (task) {
              const payload: Record<string, unknown> = {};
              if (proposal.setScheduledDate !== undefined) payload.scheduledDate = proposal.setScheduledDate;
              if (proposal.setEstimateHours !== undefined) payload.estimateHours = proposal.setEstimateHours;
              updateRow(db, 'task', task, payload, proposal.taskBaseVersion ?? null, store.nowIso());
            }
          }
        }
        suggestion.status = action === 'accept' ? 'accepted' : 'rejected';
        suggestion.updatedAt = store.nowIso();
        return { status: 200, body: clone(suggestion) };
      },
    },
    {
      method: 'POST',
      path: '/rewrites',
      auth: true,
      handler: ({ store, db, user, request }) => {
        const body = (request.body ?? {}) as { experienceId?: string };
        if (!body.experienceId) throw invalidRequest([{ field: 'experienceId', issue: '该字段为必填' }]);
        const experience = requireRow(db.experiences.find((row) => row.id === body.experienceId && row.userId === user.id && !row.deleted), '经历不存在');
        const operation = createOperation(db, {
          id: store.uuid(),
          userId: user.id,
          type: 'rewrite_resume',
          payload: { experienceId: experience.id, fingerprint: contextFingerprint(db, user.id, [experience.id, experience.version]) },
          createdAt: store.nowIso(),
        });
        return { status: 202, body: { operationId: operation.id } };
      },
    },
    {
      method: 'GET',
      path: '/rewrites/:id',
      auth: true,
      handler: ({ db, user, params }) => ({
        status: 200,
        body: clone(requireRow(db.rewrites.find((row) => row.id === params.id && row.userId === user.id && !row.deleted))),
      }),
    },
    {
      method: 'POST',
      path: '/rewrites/:id/items/:itemId/resolve',
      auth: true,
      handler: ({ store, db, user, request, params }) => {
        const rewrite = requireRow(db.rewrites.find((row) => row.id === params.id && row.userId === user.id && !row.deleted));
        const item = requireRow(rewrite.items.find((row) => row.id === params.itemId), '改写条目不存在');
        if (item.status !== 'pending') throw invalidRequest([{ field: 'itemId', issue: '条目已处理' }]);
        const action = (request.body as { action?: string } | null)?.action;
        if (action !== 'accept' && action !== 'reject') throw invalidRequest([{ field: 'action', issue: 'action 必须是 accept 或 reject' }]);
        item.status = action === 'accept' ? 'accepted' : 'rejected';
        if (action === 'accept') {
          const experience = requireRow(db.experiences.find((row) => row.id === rewrite.experienceId && row.userId === user.id && !row.deleted), '经历不存在');
          if (!experience.description.includes(item.originalQuote)) {
            throw conflict('经历原文已变化，无法安全应用改写', clone(experience));
          }
          experience.description = experience.description.replace(item.originalQuote, item.suggestion);
          experience.version += 1;
          experience.updatedAt = store.nowIso();
          appendChange(db, {
            userId: user.id,
            entity: 'experience',
            entityId: experience.id,
            version: experience.version,
            changeType: 'upsert',
            record: clone(experience),
            changedAt: experience.updatedAt,
          });
        }
        rewrite.updatedAt = store.nowIso();
        return { status: 200, body: clone(rewrite) };
      },
    },
  ];
}

function maybeCreateAdjustment(
  db: DemoDatabase,
  userId: string,
  plan: PlanRecord,
  task: PlanTaskRecord,
  payload: Record<string, unknown>,
  baseVersion: number,
  store: DemoStore,
): string | null {
  if (plan.status !== 'confirmed') return null;
  let trigger: SuggestionRecord['trigger'] | null = null;
  let summary = '';
  let proposal: Record<string, unknown> = {};

  const previousDate = task.scheduledDate ?? null;
  const nextDate = payload.scheduledDate as string | undefined | null;
  if (nextDate !== undefined && previousDate && nextDate && nextDate > previousDate) {
    trigger = 'task_delay';
    summary = `任务「${task.title}」由 ${previousDate} 延期至 ${nextDate}，建议顺延后续依赖任务`;
    proposal = { taskId: task.id, taskBaseVersion: baseVersion + 1, setScheduledDate: nextDate };
  } else if (payload.status === 'done' && task.estimateHours != null && payload.actualHours != null) {
    const actual = Number(payload.actualHours);
    const estimate = Number(task.estimateHours);
    if (actual > estimate * 1.5) {
      trigger = 'task_overrun';
      summary = `任务「${task.title}」实际用时 ${actual} 小时，超出预估 ${estimate} 小时的 50%，建议下调同类任务预估`;
      proposal = { taskId: task.id, taskBaseVersion: baseVersion + 1, setEstimateHours: Math.ceil(estimate * 1.5) };
    }
  }
  if (!trigger) return null;

  const now = store.nowIso();
  const created: SuggestionRecord = {
    id: store.uuid(),
    userId,
    version: 1,
    deleted: false,
    createdAt: now,
    updatedAt: now,
    planId: plan.id,
    trigger,
    summary,
    proposal,
    status: 'pending',
  };
  db.suggestions.push(created);
  return created.id;
}

// ---------------------------------------------------------------------------
// 投递、面试与工时
// ---------------------------------------------------------------------------

function trackingRoutes(): Route[] {
  return [
    {
      method: 'GET',
      path: '/applications/stats',
      auth: true,
      handler: ({ db, user, request }) => {
        const from = request.query.get('from') ?? '';
        const to = request.query.get('to') ?? '';
        const interviewed = new Set(
          db.applicationEvents
            .filter(
              (row) =>
                row.userId === user.id &&
                !row.deleted &&
                row.type === 'status_change' &&
                row.toStatus === 'interviewing' &&
                row.occurredAt >= `${from}T00:00:00.000Z` &&
                row.occurredAt <= `${to}T23:59:59.999Z`,
            )
            .map((row) => row.applicationId),
        );
        const totalHours =
          db.timeEntries
            .filter((row) => row.userId === user.id && !row.deleted && (row.spentOn ?? '') >= from && (row.spentOn ?? '') <= to)
            .reduce((sum, row) => sum + row.minutes, 0) / 60;
        return {
          status: 200,
          body: {
            from,
            to,
            interviewedCount: interviewed.size,
            totalHours,
            efficiency: totalHours > 0 ? (interviewed.size / totalHours) * 10 : null,
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/applications',
      auth: true,
      handler: ({ store, db, user, request }) => {
        const payload = stripInternal((request.body ?? {}) as Record<string, unknown>);
        if (!payload.jobTitle) throw invalidRequest([{ field: 'jobTitle', issue: '该字段为必填' }]);
        const now = store.nowIso();
        const status = (payload.status as string) ?? 'preparing';
        const created: ApplicationRecord = {
          id: store.uuid(),
          userId: user.id,
          version: 1,
          deleted: false,
          createdAt: now,
          updatedAt: now,
          jobId: (payload.jobId as string | null) ?? null,
          jobTitle: String(payload.jobTitle),
          company: String(payload.company ?? ''),
          status: status as ApplicationRecord['status'],
          notes: String(payload.notes ?? ''),
        };
        db.applications.push(created);
        appendChange(db, { userId: user.id, entity: 'application', entityId: created.id, version: 1, changeType: 'upsert', record: clone(created), changedAt: now });
        const event: ApplicationEventRecord = {
          id: store.uuid(),
          userId: user.id,
          version: 1,
          deleted: false,
          createdAt: now,
          updatedAt: now,
          applicationId: created.id,
          type: 'status_change',
          fromStatus: '',
          toStatus: status,
          note: '创建投递记录',
          occurredAt: now,
        };
        db.applicationEvents.push(event);
        return { status: 201, body: clone(created) };
      },
    },
    {
      method: 'GET',
      path: '/applications',
      auth: true,
      handler: ({ db, user }) => ({
        status: 200,
        body: { items: db.applications.filter((row) => row.userId === user.id && !row.deleted).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone) },
      }),
    },
    {
      method: 'GET',
      path: '/applications/:id',
      auth: true,
      handler: ({ db, user, params }) => ({
        status: 200,
        body: clone(requireRow(db.applications.find((row) => row.id === params.id && row.userId === user.id && !row.deleted))),
      }),
    },
    {
      method: 'PATCH',
      path: '/applications/:id',
      auth: true,
      handler: ({ store, db, user, request, params }) => {
        const application = requireRow(db.applications.find((row) => row.id === params.id && row.userId === user.id && !row.deleted));
        const payload = (request.body ?? {}) as Record<string, unknown>;
        const nextStatus = payload.status as string | undefined;
        if (nextStatus && !canTransition(application.status, nextStatus)) {
          throw invalidRequest([{ field: 'status', issue: `投递不能从 ${application.status} 变为 ${nextStatus}` }]);
        }
        const previousStatus = application.status;
        const updated = updateRow(db, 'application', application, payload, payload.baseVersion as number, store.nowIso());
        if (nextStatus && nextStatus !== previousStatus) {
          const now = store.nowIso();
          db.applicationEvents.push({
            id: store.uuid(),
            userId: user.id,
            version: 1,
            deleted: false,
            createdAt: now,
            updatedAt: now,
            applicationId: updated.id,
            type: 'status_change',
            fromStatus: previousStatus,
            toStatus: nextStatus,
            note: '',
            occurredAt: now,
          });
        }
        return { status: 200, body: clone(updated) };
      },
    },
    {
      method: 'DELETE',
      path: '/applications/:id',
      auth: true,
      handler: ({ store, db, user, params }) => {
        const row = requireRow(db.applications.find((item) => item.id === params.id && item.userId === user.id && !item.deleted));
        tombstone(db, 'application', row, store.nowIso());
        return { status: 204 };
      },
    },
    {
      method: 'GET',
      path: '/applications/:id/events',
      auth: true,
      handler: ({ db, user, params }) => ({
        status: 200,
        body: {
          items: db.applicationEvents
            .filter((row) => row.applicationId === params.id && row.userId === user.id && !row.deleted)
            .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
            .map(clone),
        },
      }),
    },
    {
      method: 'POST',
      path: '/applications/:id/events',
      auth: true,
      handler: ({ store, db, user, request, params }) => {
        const application = requireRow(db.applications.find((row) => row.id === params.id && row.userId === user.id && !row.deleted));
        const payload = (request.body ?? {}) as { type?: string; toStatus?: string; note?: string; occurredAt?: string };
        if (!payload.type) throw invalidRequest([{ field: 'type', issue: '该字段为必填' }]);
        const previousStatus = application.status;
        if (payload.type === 'status_change') {
          if (!payload.toStatus) throw invalidRequest([{ field: 'toStatus', issue: '状态变化事件必须提供 toStatus' }]);
          if (!canTransition(previousStatus, payload.toStatus)) {
            throw invalidRequest([{ field: 'toStatus', issue: `投递不能从 ${previousStatus} 变为 ${payload.toStatus}` }]);
          }
          updateRow(db, 'application', application, { status: payload.toStatus }, application.version, store.nowIso());
        }
        const now = store.nowIso();
        const created: ApplicationEventRecord = {
          id: store.uuid(),
          userId: user.id,
          version: 1,
          deleted: false,
          createdAt: now,
          updatedAt: now,
          applicationId: application.id,
          type: payload.type,
          fromStatus: payload.type === 'status_change' ? previousStatus : '',
          toStatus: payload.toStatus ?? '',
          note: payload.note ?? '',
          occurredAt: payload.occurredAt ?? now,
        };
        db.applicationEvents.push(created);
        return { status: 201, body: clone(created) };
      },
    },
    {
      method: 'POST',
      path: '/applications/:id/interviews',
      auth: true,
      handler: ({ store, db, user, request, params }) => {
        const application = requireRow(db.applications.find((row) => row.id === params.id && row.userId === user.id && !row.deleted));
        const payload = (request.body ?? {}) as { stage?: string; scheduledAt?: string; locationOrLink?: string };
        if (!payload.scheduledAt) throw invalidRequest([{ field: 'scheduledAt', issue: '该字段为必填' }]);
        const now = store.nowIso();
        const created: InterviewRecord = {
          id: store.uuid(),
          userId: user.id,
          version: 1,
          deleted: false,
          createdAt: now,
          updatedAt: now,
          applicationId: application.id,
          stage: payload.stage ?? '面试',
          scheduledAt: payload.scheduledAt,
          locationOrLink: payload.locationOrLink ?? '',
          result: 'pending',
          feedback: '',
        };
        db.interviews.push(created);
        schedulePendingReminder(db, {
          userId: user.id,
          entity: 'interview',
          entityId: created.id,
          kind: 'interview_1h_before',
          fireAt: new Date(new Date(created.scheduledAt).getTime() - 3_600_000).toISOString(),
          title: `面试提醒：${created.stage}`,
          body: '一小时后开始',
          dedupeKey: `interview-1h:${created.id}`,
        });
        return { status: 201, body: clone(created) };
      },
    },
    {
      method: 'GET',
      path: '/applications/:id/interviews',
      auth: true,
      handler: ({ db, user, params }) => ({
        status: 200,
        body: {
          items: db.interviews
            .filter((row) => row.applicationId === params.id && row.userId === user.id && !row.deleted)
            .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
            .map(clone),
        },
      }),
    },
    {
      method: 'PATCH',
      path: '/interviews/:id',
      auth: true,
      handler: ({ store, db, user, request, params }) => {
        const interview = requireRow(db.interviews.find((row) => row.id === params.id && row.userId === user.id && !row.deleted));
        const payload = (request.body ?? {}) as Record<string, unknown>;
        const updated = updateRow(db, 'interview', interview, payload, payload.baseVersion as number, store.nowIso());
        if (payload.scheduledAt !== undefined) {
          schedulePendingReminder(db, {
            userId: user.id,
            entity: 'interview',
            entityId: updated.id,
            kind: 'interview_1h_before',
            fireAt: new Date(new Date(updated.scheduledAt).getTime() - 3_600_000).toISOString(),
            title: `面试提醒：${updated.stage}`,
            body: '一小时后开始',
            dedupeKey: `interview-1h:${updated.id}`,
          });
        }
        return { status: 200, body: clone(updated) };
      },
    },
    {
      method: 'POST',
      path: '/time-entries',
      auth: true,
      handler: ({ store, db, user, request }) => {
        const payload = stripInternal((request.body ?? {}) as Record<string, unknown>);
        if (payload.minutes == null || !payload.spentOn) {
          throw invalidRequest([{ field: payload.minutes == null ? 'minutes' : 'spentOn', issue: '该字段为必填' }]);
        }
        const now = store.nowIso();
        const created: TimeEntryRecord = {
          id: store.uuid(),
          userId: user.id,
          version: 1,
          deleted: false,
          createdAt: now,
          updatedAt: now,
          applicationId: (payload.applicationId as string | null) ?? null,
          taskId: (payload.taskId as string | null) ?? null,
          minutes: Number(payload.minutes),
          spentOn: String(payload.spentOn),
          note: String(payload.note ?? ''),
        };
        db.timeEntries.push(created);
        appendChange(db, { userId: user.id, entity: 'time_entry', entityId: created.id, version: 1, changeType: 'upsert', record: clone(created), changedAt: now });
        return { status: 201, body: clone(created) };
      },
    },
    {
      method: 'GET',
      path: '/time-entries',
      auth: true,
      handler: ({ db, user, request }) => {
        const from = request.query.get('from') ?? '';
        const to = request.query.get('to') ?? '';
        return {
          status: 200,
          body: {
            items: db.timeEntries
              .filter((row) => row.userId === user.id && !row.deleted && (row.spentOn ?? '') >= from && (row.spentOn ?? '') <= to)
              .sort((a, b) => (a.spentOn ?? '').localeCompare(b.spentOn ?? ''))
              .map(clone),
          },
        };
      },
    },
    {
      method: 'DELETE',
      path: '/time-entries/:id',
      auth: true,
      handler: ({ store, db, user, params }) => {
        const row = requireRow(db.timeEntries.find((item) => item.id === params.id && item.userId === user.id && !item.deleted));
        tombstone(db, 'time_entry', row, store.nowIso());
        return { status: 204 };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 提醒、订阅与作业
// ---------------------------------------------------------------------------

function notificationRoutes(): Route[] {
  return [
    {
      method: 'GET',
      path: '/notifications',
      auth: true,
      handler: ({ store, db, user }) => {
        const reminders = materializeReminders(db, user.id, store.now());
        const items = reminders
          .filter((row) => row.status === 'sent')
          .sort((a, b) => (b.fireAt ?? '').localeCompare(a.fireAt ?? ''))
          .slice(0, 100)
          .map((row) => ({
            id: row.id,
            kind: row.kind,
            title: row.title,
            body: row.body,
            entity: row.entity,
            entityId: row.entityId,
            fireAt: row.fireAt,
            sentAt: row.sentAt,
            readAt: row.readAt,
          }));
        return { status: 200, body: { items, unreadCount: items.filter((row) => !row.readAt).length } };
      },
    },
    {
      method: 'POST',
      path: '/notifications/:id/read',
      auth: true,
      handler: ({ store, db, user, params }) => {
        const row = requireRow(db.reminders.find((item) => item.id === params.id && item.userId === user.id));
        row.readAt = store.nowIso();
        return { status: 200, body: { id: row.id, readAt: row.readAt } };
      },
    },
    {
      method: 'GET',
      path: '/notifications/settings',
      auth: true,
      handler: ({ store, user }) => ({
        status: 200,
        body: { timezone: user.timezone, notifyTaskDue: user.notifyTaskDue, notifyInterview: user.notifyInterview, updatedAt: store.nowIso() },
      }),
    },
    {
      method: 'PUT',
      path: '/notifications/settings',
      auth: true,
      handler: ({ store, db, user, request }) => {
        const body = (request.body ?? {}) as { timezone?: string; notifyTaskDue?: boolean; notifyInterview?: boolean };
        if (!body.timezone && body.notifyTaskDue === undefined && body.notifyInterview === undefined) {
          throw invalidRequest([{ field: '(body)', issue: '至少提供一项设置' }]);
        }
        const row = userById(db, user.id) as DemoUser;
        if (body.timezone) row.timezone = body.timezone;
        if (body.notifyTaskDue !== undefined) row.notifyTaskDue = body.notifyTaskDue;
        if (body.notifyInterview !== undefined) row.notifyInterview = body.notifyInterview;
        return {
          status: 200,
          body: { timezone: row.timezone, notifyTaskDue: row.notifyTaskDue, notifyInterview: row.notifyInterview, updatedAt: store.nowIso() },
        };
      },
    },
    {
      method: 'GET',
      path: '/push-subscriptions/vapid-public-key',
      auth: true,
      handler: () => ({ status: 200, body: { publicKey: '' } }),
    },
    {
      method: 'POST',
      path: '/push-subscriptions',
      auth: true,
      handler: ({ store, db, user, request }) => {
        const body = (request.body ?? {}) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
        if (!body.endpoint || !body.keys?.p256dh || !body.keys.auth) {
          throw invalidRequest([{ field: 'endpoint', issue: 'endpoint 与 keys 均为必填' }]);
        }
        const existing = db.pushSubscriptions.find((row) => row.userId === user.id && row.endpoint === body.endpoint);
        if (existing) {
          existing.keys = { p256dh: body.keys.p256dh, auth: body.keys.auth };
          existing.status = 'active';
          existing.deleted = false;
          return { status: 201, body: clone(existing) };
        }
        const created: PushSubscriptionRecord = {
          id: store.uuid(),
          userId: user.id,
          endpoint: body.endpoint,
          keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
          status: 'active',
          createdAt: store.nowIso(),
          updatedAt: store.nowIso(),
          deleted: false,
        };
        db.pushSubscriptions.push(created);
        return { status: 201, body: { id: created.id, endpoint: created.endpoint, status: created.status, createdAt: created.createdAt } };
      },
    },
    {
      method: 'DELETE',
      path: '/push-subscriptions/:id',
      auth: true,
      handler: ({ store, db, user, params }) => {
        const row = requireRow(db.pushSubscriptions.find((item) => item.id === params.id && item.userId === user.id));
        row.status = 'expired';
        row.deleted = true;
        row.updatedAt = store.nowIso();
        return { status: 204 };
      },
    },
    {
      method: 'GET',
      path: '/operations/:id',
      auth: true,
      handler: ({ store, db, user, params }) => {
        const operation = requireRow(db.operations.find((item) => item.id === params.id && item.userId === user.id));
        advanceOperation(store, db, user, operation);
        return {
          status: 200,
          body: {
            id: operation.id,
            type: operation.type,
            status: operation.status,
            error: operation.error ?? null,
            resultRef: operation.resultRef ?? null,
            createdAt: operation.createdAt,
          },
        };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 离线同步协议
// ---------------------------------------------------------------------------

type SyncEntityName =
  | 'profile'
  | 'experience'
  | 'skill'
  | 'evidence'
  | 'job'
  | 'portfolio'
  | 'task'
  | 'application'
  | 'application_event'
  | 'interview'
  | 'time_entry';

interface SyncOp {
  opId: string;
  entity: SyncEntityName;
  entityId?: string | null;
  baseVersion?: number | null;
  action: 'upsert' | 'delete';
  payload?: Record<string, unknown>;
}

const SYNC_REQUIRED: Record<SyncEntityName, string[]> = {
  profile: [],
  experience: ['title', 'description'],
  skill: ['name'],
  evidence: ['skillId', 'experienceId', 'quote'],
  job: ['title'],
  portfolio: ['timeBudgetHours'],
  task: ['title'],
  application: ['jobTitle'],
  application_event: ['applicationId', 'type'],
  interview: ['applicationId', 'scheduledAt'],
  time_entry: ['minutes', 'spentOn'],
};

function syncRows(db: DemoDatabase, entity: SyncEntityName, userId: string): Array<Record<string, unknown>> {
  switch (entity) {
    case 'profile':
      return db.profiles as unknown as Array<Record<string, unknown>>;
    case 'experience':
      return db.experiences as unknown as Array<Record<string, unknown>>;
    case 'skill':
      return db.skills as unknown as Array<Record<string, unknown>>;
    case 'evidence':
      return db.evidence as unknown as Array<Record<string, unknown>>;
    case 'job':
      return db.jobs.filter((row) => row.userId === userId) as unknown as Array<Record<string, unknown>>;
    case 'portfolio':
      return db.portfolios as unknown as Array<Record<string, unknown>>;
    case 'task':
      return db.tasks as unknown as Array<Record<string, unknown>>;
    case 'application':
      return db.applications as unknown as Array<Record<string, unknown>>;
    case 'application_event':
      return db.applicationEvents as unknown as Array<Record<string, unknown>>;
    case 'interview':
      return db.interviews as unknown as Array<Record<string, unknown>>;
    case 'time_entry':
      return db.timeEntries as unknown as Array<Record<string, unknown>>;
  }
}

function syncRoutes(): Route[] {
  return [
    {
      method: 'POST',
      path: '/sync/operations',
      auth: true,
      handler: ({ store, db, user, request }) => {
        const body = (request.body ?? {}) as { operations?: SyncOp[] };
        const operations = body.operations ?? [];
        const results: Schema['SyncResult'][] = operations.map((op) => applySyncOperation(store, db, user.id, op));
        return { status: 200, body: { results } };
      },
    },
    {
      method: 'GET',
      path: '/sync/changes',
      auth: true,
      handler: ({ db, user, request }) => {
        const since = Number(request.query.get('since') ?? 0);
        const limit = Number(request.query.get('limit') ?? 100);
        const rows = db.changes
          .filter((row) => row.userId === user.id && row.seq > since)
          .sort((a, b) => a.seq - b.seq);
        const page = rows.slice(0, limit);
        return {
          status: 200,
          body: {
            cursor: page.length > 0 ? (page[page.length - 1]?.seq ?? since) : since,
            hasMore: rows.length > limit,
            changes: page.map((row) => ({
              seq: row.seq,
              entity: row.entity,
              entityId: row.entityId,
              version: row.version,
              changeType: row.changeType,
              record: row.record,
              changedAt: row.changedAt,
            })),
          },
        };
      },
    },
  ];
}

function applySyncOperation(store: DemoStore, db: DemoDatabase, userId: string, op: SyncOp): Schema['SyncResult'] {
  const existing = db.syncReceipts.find((row) => row.userId === userId && row.opId === op.opId);
  if (existing) return { ...existing.result, status: 'duplicate' };

  const persist = (result: Schema['SyncResult']): Schema['SyncResult'] => {
    db.syncReceipts.push({ userId, opId: op.opId, result: clone(result) });
    return result;
  };

  if (!(op.entity in SYNC_REQUIRED)) return persist({ opId: op.opId, status: 'rejected', error: '未知实体类型' });
  const rows = syncRows(db, op.entity, userId);
  const row = op.entityId ? rows.find((item) => item.id === op.entityId) : undefined;

  if (op.action === 'delete') {
    if (!op.entityId) return persist({ opId: op.opId, status: 'rejected', error: 'delete 操作需要 entityId' });
    if (op.baseVersion == null) return persist({ opId: op.opId, status: 'rejected', error: '删除操作必须提供 baseVersion' });
    if (!row) {
      return persist(
        op.baseVersion === 0
          ? { opId: op.opId, status: 'applied', version: 0, record: { id: op.entityId, deleted: true } }
          : { opId: op.opId, status: 'conflict', record: { id: op.entityId, deleted: true }, error: '实体不存在或已被删除' },
      );
    }
    const serverVersion = Number(row.version);
    if (op.baseVersion !== serverVersion) return persist({ opId: op.opId, status: 'conflict', version: serverVersion, record: clone(row), error: '版本冲突' });
    if (row.deleted === true) return persist({ opId: op.opId, status: 'applied', version: serverVersion, record: clone(row) });
    tombstone(db, op.entity, row as never, store.nowIso());
    return persist({ opId: op.opId, status: 'applied', version: serverVersion + 1, record: { id: op.entityId, version: serverVersion + 1, deleted: true } });
  }

  if (!op.entityId) return persist({ opId: op.opId, status: 'rejected', error: 'upsert 操作需要 entityId（离线新建由客户端生成 UUID）' });
  const payload = op.payload ?? {};
  const missing = SYNC_REQUIRED[op.entity].filter((field) => payload[field] === undefined || payload[field] === null || payload[field] === '');
  if (missing.length > 0) {
    return persist({
      opId: op.opId,
      status: 'rejected',
      error: '参数校验失败',
      details: missing.map((field) => ({ field, issue: '该字段为必填' })),
    });
  }
  if (op.baseVersion == null) return persist({ opId: op.opId, status: 'rejected', error: '更新操作必须提供 baseVersion' });

  if (!row) {
    if (op.baseVersion !== 0) {
      return persist({ opId: op.opId, status: 'conflict', record: { id: op.entityId, deleted: true }, error: '实体不存在或已被删除' });
    }
    const created = createViaSync(db, userId, op.entity, op.entityId, payload, store.nowIso());
    if (!created) return persist({ opId: op.opId, status: 'rejected', error: `演示数据源不支持离线创建 ${op.entity}` });
    return persist({ opId: op.opId, status: 'applied', version: 1, record: clone(created) });
  }

  if (row.deleted === true) {
    return persist({ opId: op.opId, status: 'conflict', version: Number(row.version), record: clone(row), error: '实体已在远端删除' });
  }
  const serverVersion = Number(row.version);
  if (op.baseVersion !== serverVersion) {
    return persist({ opId: op.opId, status: 'conflict', version: serverVersion, record: clone(row), error: '版本冲突' });
  }
  const updated = updateRow(db, op.entity, row as never, payload, serverVersion, store.nowIso()) as unknown as Record<string, unknown>;
  return persist({ opId: op.opId, status: 'applied', version: Number(updated.version), record: clone(updated) });
}

/** 离线新建：客户端带上 UUID 与 baseVersion=0。 */
function createViaSync(db: DemoDatabase, userId: string, entity: SyncEntityName, id: string, payload: Record<string, unknown>, now: string): Record<string, unknown> | null {
  const base = { id, userId, version: 1, deleted: false, createdAt: now, updatedAt: now };
  const created = (row: Record<string, unknown>): Record<string, unknown> => {
    appendChange(db, { userId, entity, entityId: id, version: 1, changeType: 'upsert', record: clone(row), changedAt: now });
    return row;
  };
  switch (entity) {
    case 'profile': {
      const row: ProfileRecord = { ...profileShell(userId), ...(payload as object), ...base } as ProfileRecord;
      db.profiles.push(row);
      return created(row as unknown as Record<string, unknown>);
    }
    case 'experience': {
      const row: ExperienceRecord = {
        ...base,
        title: String(payload.title ?? ''),
        organization: String(payload.organization ?? ''),
        kind: (payload.kind as ExperienceRecord['kind']) ?? 'other',
        startDate: (payload.startDate as string | null) ?? null,
        endDate: (payload.endDate as string | null) ?? null,
        description: String(payload.description ?? ''),
      };
      db.experiences.push(row);
      return created(row as unknown as Record<string, unknown>);
    }
    case 'skill': {
      const row: SkillRecord = { ...base, name: String(payload.name ?? '') };
      db.skills.push(row);
      return created(row as unknown as Record<string, unknown>);
    }
    case 'evidence': {
      const row: EvidenceRecord = {
        ...base,
        skillId: String(payload.skillId ?? ''),
        experienceId: String(payload.experienceId ?? ''),
        quote: String(payload.quote ?? ''),
        status: (payload.status as EvidenceRecord['status']) ?? 'pending',
      };
      db.evidence.push(row);
      return created(row as unknown as Record<string, unknown>);
    }
    case 'job': {
      const row: JobRecord = {
        ...base,
        userId,
        scope: 'private',
        title: String(payload.title ?? ''),
        company: String(payload.company ?? ''),
        location: (payload.location as string | null) ?? null,
        degreeRequirement: (payload.degreeRequirement as string | null) ?? null,
        graduationYearFrom: (payload.graduationYearFrom as number | null) ?? null,
        graduationYearTo: (payload.graduationYearTo as number | null) ?? null,
        sourceUrl: (payload.sourceUrl as string | null) ?? null,
        deadlineDate: (payload.deadlineDate as string | null) ?? null,
        status: 'draft',
        jdText: String(payload.jdText ?? ''),
        jobVersion: 1,
        requirements: [],
      };
      db.jobs.push(row);
      return created(row as unknown as Record<string, unknown>);
    }
    case 'portfolio': {
      const row: PortfolioRecord = {
        ...base,
        timeBudgetHours: Number(payload.timeBudgetHours ?? 0),
        items: [],
        notes: {},
      };
      db.portfolios.push(row);
      return created(row as unknown as Record<string, unknown>);
    }
    case 'task': {
      const row: PlanTaskRecord = {
        ...base,
        planId: String(payload.planId ?? ''),
        title: String(payload.title ?? ''),
        description: String(payload.description ?? ''),
        jobId: (payload.jobId as string | null) ?? null,
        evidenceId: (payload.evidenceId as string | null) ?? null,
        gap: (payload.gap as string | null) ?? null,
        estimateHours: (payload.estimateHours as number | null) ?? null,
        actualHours: (payload.actualHours as number | null) ?? null,
        scheduledDate: (payload.scheduledDate as string | null) ?? null,
        status: (payload.status as PlanTaskRecord['status']) ?? 'pending',
        deps: Array.isArray(payload.deps) ? (payload.deps as string[]) : [],
      };
      db.tasks.push(row);
      return created(row as unknown as Record<string, unknown>);
    }
    case 'application': {
      const row: ApplicationRecord = {
        ...base,
        jobId: (payload.jobId as string | null) ?? null,
        jobTitle: String(payload.jobTitle ?? ''),
        company: String(payload.company ?? ''),
        status: (payload.status as ApplicationRecord['status']) ?? 'preparing',
        notes: String(payload.notes ?? ''),
      };
      db.applications.push(row);
      return created(row as unknown as Record<string, unknown>);
    }
    case 'application_event': {
      const row: ApplicationEventRecord = {
        ...base,
        applicationId: String(payload.applicationId ?? ''),
        type: String(payload.type ?? 'note'),
        fromStatus: (payload.fromStatus as string | null) ?? null,
        toStatus: (payload.toStatus as string | null) ?? null,
        note: (payload.note as string | null) ?? null,
        occurredAt: String(payload.occurredAt ?? now),
      };
      db.applicationEvents.push(row);
      return created(row as unknown as Record<string, unknown>);
    }
    case 'interview': {
      const row: InterviewRecord = {
        ...base,
        applicationId: String(payload.applicationId ?? ''),
        stage: String(payload.stage ?? '面试'),
        scheduledAt: String(payload.scheduledAt ?? now),
        locationOrLink: String(payload.locationOrLink ?? ''),
        result: (payload.result as InterviewRecord['result']) ?? 'pending',
        feedback: String(payload.feedback ?? ''),
      };
      db.interviews.push(row);
      return created(row as unknown as Record<string, unknown>);
    }
    case 'time_entry': {
      const row: TimeEntryRecord = {
        ...base,
        applicationId: (payload.applicationId as string | null) ?? null,
        taskId: (payload.taskId as string | null) ?? null,
        minutes: Number(payload.minutes ?? 0),
        spentOn: String(payload.spentOn ?? now.slice(0, 10)),
        note: String(payload.note ?? ''),
      };
      db.timeEntries.push(row);
      return created(row as unknown as Record<string, unknown>);
    }
  }
}

// ---------------------------------------------------------------------------
// 异步作业执行
// ---------------------------------------------------------------------------

/**
 * 重置当前演示身份的业务数据（与后端 POST /demo/reset 一致）：
 * 清空画像、经历、技能、证据、自建岗位、投递、计划、提醒与同步记录，返回删除行数；
 * 公共岗位库（userId 为空）和其他演示身份不受影响。
 */
function resetUserData(db: DemoDatabase, userId: string): number {
  const keepOthers = <T extends { userId?: string | null }>(rows: T[]): T[] => rows.filter((row) => row.userId !== userId);
  const removed = <T extends { userId?: string | null }>(rows: T[]): number => rows.filter((row) => row.userId === userId).length;

  let deletedRows = removed(db.profiles) + removed(db.experiences) + removed(db.skills) + removed(db.evidence);
  db.profiles = keepOthers(db.profiles);
  db.experiences = keepOthers(db.experiences);
  db.skills = keepOthers(db.skills);
  db.evidence = keepOthers(db.evidence);

  const removedJobIds = new Set(db.jobs.filter((job) => job.userId === userId).map((job) => job.id));
  deletedRows += removed(db.jobs) + db.requirements.filter((row) => removedJobIds.has(row.jobId)).length
    + db.requirementDrafts.filter((row) => removedJobIds.has(row.jobId)).length;
  db.jobs = db.jobs.filter((job) => job.userId !== userId);
  db.requirements = db.requirements.filter((row) => !removedJobIds.has(row.jobId));
  db.requirementDrafts = db.requirementDrafts.filter((row) => !removedJobIds.has(row.jobId));

  deletedRows += removed(db.documents) + removed(db.parseDrafts) + removed(db.matches) + removed(db.portfolios);
  deletedRows += removed(db.plans) + removed(db.tasks) + removed(db.suggestions) + removed(db.rewrites);
  deletedRows += removed(db.applications) + removed(db.applicationEvents) + removed(db.interviews) + removed(db.timeEntries);
  deletedRows += removed(db.operations) + removed(db.reminders) + removed(db.pushSubscriptions);
  deletedRows += removed(db.changes) + removed(db.syncReceipts);

  db.documents = keepOthers(db.documents);
  db.parseDrafts = keepOthers(db.parseDrafts);
  db.matches = keepOthers(db.matches);
  db.portfolios = keepOthers(db.portfolios);
  db.plans = keepOthers(db.plans);
  db.tasks = keepOthers(db.tasks);
  db.suggestions = keepOthers(db.suggestions);
  db.rewrites = keepOthers(db.rewrites);
  db.applications = keepOthers(db.applications);
  db.applicationEvents = keepOthers(db.applicationEvents);
  db.interviews = keepOthers(db.interviews);
  db.timeEntries = keepOthers(db.timeEntries);
  db.operations = keepOthers(db.operations);
  db.reminders = keepOthers(db.reminders);
  db.pushSubscriptions = keepOthers(db.pushSubscriptions);
  db.changes = keepOthers(db.changes);
  db.syncReceipts = keepOthers(db.syncReceipts);
  return deletedRows;
}

function advanceOperation(store: DemoStore, db: DemoDatabase, user: DemoUser, operation: OperationRecord): void {
  if (operation.status === 'succeeded' || operation.status === 'failed') return;
  operation.polls += 1;
  if (operation.polls === 1) {
    operation.status = 'running';
    return;
  }
  try {
    operation.resultRef = runOperation(store, db, user, operation);
    operation.status = 'succeeded';
    operation.error = null;
  } catch (error) {
    operation.status = 'failed';
    operation.error = error instanceof Error ? error.message : '作业执行失败';
  }
}

function runOperation(store: DemoStore, db: DemoDatabase, user: DemoUser, operation: OperationRecord): string | null {
  switch (operation.type) {
    case 'parse_document':
      return runParseDocument(store, db, user, operation);
    case 'parse_job_requirements':
      return runParseRequirements(store, db, operation);
    case 'generate_match':
      return runGenerateMatch(store, db, user, operation);
    case 'generate_plan':
      return runGeneratePlan(store, db, user, operation);
    case 'rewrite_resume':
      return runRewrite(store, db, user, operation);
  }
}

function runParseDocument(store: DemoStore, db: DemoDatabase, user: DemoUser, operation: OperationRecord): string | null {
  const document = requireRow(db.documents.find((row) => row.id === operation.input.documentId && row.userId === user.id), '文档不存在');
  const fingerprint = contextFingerprint(db, user.id, [document.id, document.filename, document.sizeBytes, document.version]);
  if (fingerprint !== operation.input.fingerprint) {
    document.status = 'failed';
    document.error = '文件已变化，请重新发起解析';
    throw new Error('输入已过期（文件已变化）');
  }
  if (!isExampleResume(document.filename)) {
    // PLAN.md 4：固定解析结果只能用于配套示例文件，其它文件必须明确报错。
    document.status = 'failed';
    document.error = '无法提取文本（演示数据源不解析任意文件）';
    throw new Error('演示数据源只解析配套示例简历（示例简历-林晓.pdf）；扫描件或加密文件请手动录入经历。');
  }
  const now = store.nowIso();
  const draft: ParseDraftRecord = {
    id: store.uuid(),
    userId: user.id,
    documentId: document.id,
    operationId: operation.id,
    status: 'ready',
    result: buildExampleResumeDraft(),
    createdAt: now,
    updatedAt: now,
  };
  db.parseDrafts.push(draft);
  document.pageCount = 1;
  document.status = 'draft_ready';
  document.error = null;
  document.updatedAt = now;
  return draft.id;
}

function runParseRequirements(store: DemoStore, db: DemoDatabase, operation: OperationRecord): string | null {
  const job = requireRow(db.jobs.find((row) => row.id === operation.input.jobId), '岗位不存在');
  const fingerprint = contextFingerprint(db, operation.userId, [job.id, job.jobVersion, job.jdText]);
  if (fingerprint !== operation.input.fingerprint) {
    throw new Error('输入已过期（JD 已更新），请重新解析');
  }
  if (!job.jdText.trim()) throw new Error('岗位缺少 JD 原文，无法解析');
  const draft: RequirementDraftRecord = {
    jobId: job.id,
    operationId: operation.id,
    status: 'ready',
    candidates: mockParseRequirements(job.jdText),
    createdAt: store.nowIso(),
  };
  db.requirementDrafts = db.requirementDrafts.filter((row) => row.jobId !== job.id);
  db.requirementDrafts.push(draft);
  return null;
}

function runGenerateMatch(store: DemoStore, db: DemoDatabase, user: DemoUser, operation: OperationRecord): string {
  const job = requireRow(db.jobs.find((row) => row.id === operation.input.jobId && !row.deleted), '岗位不存在或未发布');
  const fingerprint = contextFingerprint(db, user.id, [job.id, job.jobVersion]);
  if (fingerprint !== operation.input.fingerprint) {
    throw new Error('输入已过期（画像或岗位已变化），请重新发起分析');
  }
  const ctx = ruleContext(db, user.id);
  const requirements: HardRequirement[] = db.requirements
    .filter((row) => row.jobId === job.id && row.jobVersion === job.jobVersion)
    .map((row) => ({ kind: row.kind, value: row.value, quote: row.quote }));
  const hardConditions = evaluateHardConditions(requirements, ctx.profile, ctx.evidence);
  const scores = computeMatchScores(requirements, ctx.evidence, ctx.profile, {
    title: job.title,
    company: job.company,
    location: job.location ?? null,
  });
  const gaps = hardConditions.filter((row) => row.status !== 'met').map((row) => `${row.kind}: ${row.requirement}${row.note ? `（${row.note}）` : ''}`);
  const explanation = mockMatchExplanation(job.jdText, gaps, scores.total);
  const quotes = quoteRefsFor(job.jdText, [
    ...explanation.advantages.flatMap((item) => item.quotes.map((quote) => quote.text)),
    ...explanation.prepSuggestions.flatMap((item) => item.quotes.map((quote) => quote.text)),
  ]);
  const now = store.nowIso();
  const snapshot: MatchRecord = {
    id: store.uuid(),
    userId: user.id,
    jobId: job.id,
    operationId: operation.id,
    ruleVersion: RULE_VERSION,
    inputVersions: { profileVersion: ctx.profileVersion, experiences: ctx.experiences.map((row) => ({ id: row.id, version: row.version })) },
    inputFingerprint: fingerprint,
    hardConditions,
    scores,
    gaps,
    explanation,
    quotes,
    status: 'ready',
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  db.matches.push(snapshot);
  return snapshot.id;
}

function runGeneratePlan(store: DemoStore, db: DemoDatabase, user: DemoUser, operation: OperationRecord): string {
  const portfolio = requireRow(db.portfolios.find((row) => row.id === operation.input.portfolioId && row.userId === user.id && !row.deleted), '组合不存在');
  const fingerprint = contextFingerprint(db, user.id, [portfolio.id, portfolio.version]);
  if (fingerprint !== operation.input.fingerprint) {
    throw new Error('输入已过期（画像或经历已变化），请重新生成计划');
  }
  const selected = portfolio.items.filter((item) => item.selected);
  if (selected.length === 0) throw new Error('组合中没有已选岗位，无法生成计划');

  const ctx = ruleContext(db, user.id);
  const weekly = ctx.weeklyTimeBudgetHours ?? 8;
  const dailyHours = Math.max(weekly / 7, 0.5);
  const today = new Date(`${store.today()}T00:00:00.000Z`);
  const now = store.nowIso();
  const plan: PlanRecord = {
    id: store.uuid(),
    userId: user.id,
    version: 1,
    deleted: false,
    createdAt: now,
    updatedAt: now,
    portfolioId: portfolio.id,
    status: 'draft',
    ruleVersion: RULE_VERSION,
    inputFingerprint: fingerprint,
  };
  db.plans.push(plan);

  let cursorHours = 0;
  const previousTaskByJob = new Map<string, string>();
  for (const [index, template] of mockPlanTasks().entries()) {
    const jobId = selected[index % selected.length]?.jobId ?? selected[0]!.jobId;
    const dayOffset = Math.min(Math.floor(cursorHours / dailyHours), 13);
    cursorHours += template.estimateHours;
    const scheduledDate = new Date(today.getTime() + dayOffset * 86_400_000).toISOString().slice(0, 10);
    const match = db.matches.find((row) => row.jobId === jobId && row.userId === user.id);
    const gap = match?.gaps[index % Math.max(match.gaps.length, 1)];
    const deps = previousTaskByJob.get(jobId) ? [previousTaskByJob.get(jobId) as string] : [];
    const task: PlanTaskRecord = {
      id: store.uuid(),
      userId: user.id,
      version: 1,
      deleted: false,
      createdAt: now,
      updatedAt: now,
      planId: plan.id,
      title: template.title,
      description: template.description,
      jobId,
      evidenceId: null,
      gap: gap ?? null,
      estimateHours: template.estimateHours,
      actualHours: null,
      scheduledDate,
      status: 'pending',
      deps,
    };
    previousTaskByJob.set(jobId, task.id);
    db.tasks.push(task);
  }
  return plan.id;
}

function runRewrite(store: DemoStore, db: DemoDatabase, user: DemoUser, operation: OperationRecord): string {
  const experience = requireRow(db.experiences.find((row) => row.id === operation.input.experienceId && row.userId === user.id && !row.deleted), '经历不存在');
  const fingerprint = contextFingerprint(db, user.id, [experience.id, experience.version]);
  if (fingerprint !== operation.input.fingerprint) throw new Error('输入已过期（经历已变化），请重新发起改写');
  const now = store.nowIso();
  const items = mockRewrite(experience.description).map((item, index) => ({
    id: `item-${index + 1}`,
    originalQuote: item.originalQuote,
    suggestion: item.suggestion,
    rationale: item.rationale,
    quoteVerified: verifyQuote(experience.description, item.originalQuote),
    status: 'pending' as const,
  }));
  const rewrite: RewriteRecord = {
    id: store.uuid(),
    userId: user.id,
    version: 1,
    deleted: false,
    createdAt: now,
    updatedAt: now,
    experienceId: experience.id,
    operationId: operation.id,
    items,
    status: 'ready',
    error: null,
  };
  db.rewrites.push(rewrite);
  return rewrite.id;
}
