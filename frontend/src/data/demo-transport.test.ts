import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoTransport, type DemoTransportHandle } from './demo-transport';
import { DEMO_USER_IDS, EXAMPLE_RESUME_FILENAME } from './demo-seed';
import type { DemoTransportOptions, Schema } from './demo-types';
import type { ApiError } from '../api/client';

const NOW = new Date('2026-09-29T02:00:00.000Z');

function makeTransport(options: DemoTransportOptions = {}): DemoTransportHandle {
  return createDemoTransport({
    persist: false,
    latencyMs: 0,
    latencyJitterMs: 0,
    now: () => new Date(NOW),
    ...options,
  });
}

interface ApiResponse<T> {
  status: number;
  payload: T;
}

async function call<T = unknown>(
  transport: DemoTransportHandle,
  method: string,
  path: string,
  body?: unknown,
  init: RequestInit = {},
): Promise<ApiResponse<T>> {
  const request: RequestInit = { method, ...init };
  if (body instanceof FormData) {
    request.body = body;
  } else if (body !== undefined) {
    request.body = JSON.stringify(body);
    request.headers = { 'content-type': 'application/json' };
  }
  const response = await transport(`/api/v1${path}`, request);
  const text = await response.text();
  return { status: response.status, payload: (text ? JSON.parse(text) : undefined) as T };
}

async function ok<T = unknown>(
  transport: DemoTransportHandle,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const { status, payload } = await call<T>(transport, method, path, body);
  expect(status, `${method} ${path} 应成功，实际 ${status}: ${JSON.stringify(payload)}`).toBeLessThan(400);
  return payload;
}

async function fail<T = Schema['ErrorBody']>(
  transport: DemoTransportHandle,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const response = await call<T>(transport, method, path, body);
  expect(response.status, `${method} ${path} 应失败`).toBeGreaterThanOrEqual(400);
  return response;
}

async function login(transport: DemoTransportHandle, userId: string = DEMO_USER_IDS.student): Promise<Schema['SessionResponse']> {
  return ok<Schema['SessionResponse']>(transport, 'POST', '/session', { userId });
}

/** 演示作业：第一次轮询进入 running，第二次执行完成。 */
async function runOperation(transport: DemoTransportHandle, operationId: string): Promise<Schema['Operation']> {
  await ok(transport, 'GET', `/operations/${operationId}`);
  return ok<Schema['Operation']>(transport, 'GET', `/operations/${operationId}`);
}

function resumeFile(filename: string, type = 'application/pdf'): FormData {
  const form = new FormData();
  form.append('file', new File(['%PDF-1.4 demo'], filename, { type }));
  return form;
}

async function confirmRequirements(transport: DemoTransportHandle, jobId: string): Promise<void> {
  const accepted = await ok<Schema['AcceptedResponse']>(transport, 'POST', `/jobs/${jobId}/parse-requirements`);
  await runOperation(transport, accepted.operationId);
  await ok(transport, 'POST', `/jobs/${jobId}/requirements/confirm`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('演示数据源 · 会话与 HTTP 适配器兼容', () => {
  it('未登录时返回演示身份列表与能力标记', async () => {
    const transport = makeTransport();
    const session = await ok<Schema['SessionResponse']>(transport, 'GET', '/session');
    expect(session.authenticated).toBe(false);
    expect(session.demoUsers?.map((user) => user.role)).toEqual(['student', 'student', 'admin']);
    // 演示数据源没有 VAPID 密钥：推送不可用，站内提醒与离线可用。
    expect(session.capabilities).toEqual({ push: false, offline: true, demoMode: true });
  });

  it('演示身份可登录与退出，未知身份返回 404', async () => {
    const transport = makeTransport();
    const session = await login(transport);
    expect(session.authenticated).toBe(true);
    expect(session.user?.displayName).toContain('林晓');
    expect((await fail(transport, 'POST', '/session', { userId: '00000000-0000-4000-8000-0000000000ff' })).status).toBe(404);
    await ok(transport, 'DELETE', '/session');
    expect((await ok<Schema['SessionResponse']>(transport, 'GET', '/session')).authenticated).toBe(false);
  });

  it('可直接被 src/api/client.ts 使用，并把 409 还原成 ApiError + server 记录', async () => {
    const transport = makeTransport();
    vi.stubGlobal('fetch', transport);
    const { api } = await import('../api/client');

    const anonymous = await api<Schema['SessionResponse']>('/session');
    expect(anonymous.authenticated).toBe(false);

    const session = await api<Schema['SessionResponse']>('/session', {
      method: 'POST',
      body: JSON.stringify({ userId: DEMO_USER_IDS.student }),
    });
    expect(session.user?.id).toBe(DEMO_USER_IDS.student);

    await expect(
      api('/profile', { method: 'PUT', body: JSON.stringify({ targetRoles: ['产品运营实习生'], baseVersion: 0 }) }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'version_conflict',
      serverRecord: { version: 1 },
    } satisfies Partial<ApiError>);

    const updated = await api<Schema['Profile']>('/profile', {
      method: 'PUT',
      body: JSON.stringify({ targetRoles: ['数据分析实习生'], baseVersion: 1 }),
    });
    expect(updated.version).toBe(2);
    expect(updated.targetRoles).toEqual(['数据分析实习生']);
  });
});

describe('演示数据源 · 画像、证据与文档解析', () => {
  it('画像空壳 → 首次保存 → 版本冲突携带服务端记录', async () => {
    const transport = makeTransport();
    // student2 没有预置画像，用来验证空壳画像与首次创建。
    await login(transport, DEMO_USER_IDS.student2);
    const shell = await ok<Schema['Profile']>(transport, 'GET', '/profile');
    expect(shell).toMatchObject({ id: '', version: 0, targetRoles: [] });

    const saved = await ok<Schema['Profile']>(transport, 'PUT', '/profile', {
      targetRoles: ['数据分析实习生'],
      industries: ['互联网'],
      graduationYear: 2027,
      degree: 'bachelor',
      preferredLocations: ['广州'],
      weeklyTimeBudgetHours: 8,
      baseVersion: 0,
    });
    expect(saved.version).toBe(1);

    const conflict = await fail(transport, 'PUT', '/profile', { targetRoles: ['算法实习生'], baseVersion: 0 });
    expect(conflict.status).toBe(409);
    expect(conflict.payload.error.code).toBe('version_conflict');
    expect(conflict.payload.error.server).toMatchObject({ version: 1, targetRoles: ['数据分析实习生'] });
  });

  it('技能证据必须命中经历原文，未命中返回 quote_rejected', async () => {
    const transport = makeTransport();
    await login(transport);
    const evidence = await ok<Schema['EvidenceBundle']>(transport, 'GET', '/evidence');
    const experience = evidence.experiences[0]!;
    const skill = evidence.skills[0]!;

    const rejected = await fail(transport, 'POST', '/evidence/links', {
      skillId: skill.id,
      experienceId: experience.id,
      quote: '这段文字不在经历原文里',
    });
    expect(rejected.status).toBe(422);
    expect(rejected.payload.error.code).toBe('quote_rejected');

    const created = await ok<Schema['Evidence']>(transport, 'POST', '/evidence/links', {
      skillId: skill.id,
      experienceId: experience.id,
      quote: '使用 Python 清洗 12 万行订单数据',
    });
    expect(created.status).toBe('pending');

    const confirmed = await ok<Schema['Evidence']>(transport, 'PUT', `/evidence/links/${created.id}`, {
      status: 'confirmed',
      baseVersion: created.version,
    });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.version).toBe(2);
  });

  it('只解析配套示例文件：其它文件明确失败，示例文件产出引用可核验的草稿', async () => {
    const transport = makeTransport();
    await login(transport);

    const unsupported = await fail(transport, 'POST', '/documents', resumeFile('简历.pdf', 'text/plain'));
    expect(unsupported.status).toBe(422);
    expect(unsupported.payload.error.code).toBe('unprocessable_file');

    const other = await ok<Schema['Document']>(transport, 'POST', '/documents', resumeFile('我的简历.pdf'));
    const failed = await runOperation(transport, (await ok<Schema['AcceptedResponse']>(transport, 'POST', `/documents/${other.id}/parse`)).operationId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('示例');
    expect((await ok<Schema['Document']>(transport, 'GET', `/documents/${other.id}`)).status).toBe('failed');
    expect((await fail(transport, 'GET', `/documents/${other.id}/draft`)).status).toBe(404);

    const example = await ok<Schema['Document']>(transport, 'POST', '/documents', resumeFile(EXAMPLE_RESUME_FILENAME));
    const accepted = await ok<Schema['AcceptedResponse']>(transport, 'POST', `/documents/${example.id}/parse`);
    const finished = await runOperation(transport, accepted.operationId);
    expect(finished.status).toBe('succeeded');

    const draft = await ok<Schema['ParseDraft']>(transport, 'GET', `/documents/${example.id}/draft`);
    const result = draft.result as { experiences: { description: string; quote: string }[]; skills: { name: string; quote: string }[] };
    expect(result.experiences).toHaveLength(2);
    expect(result.skills.map((skill) => skill.name)).toEqual(['Python', 'SQL', '数据分析']);
    for (const skill of result.skills) {
      expect(result.experiences.some((experience) => experience.description.includes(skill.quote))).toBe(true);
    }

    const saved = await ok<{ experienceIds: string[]; skillIds: string[] }>(transport, 'POST', `/documents/${example.id}/confirm`, { confirm: true });
    expect(saved.experienceIds).toHaveLength(2);
    const bundle = await ok<Schema['EvidenceBundle']>(transport, 'GET', '/evidence');
    expect(bundle.experiences.length).toBeGreaterThanOrEqual(4);
    expect(bundle.links.every((link) => link.status === 'pending' || link.status === 'confirmed' || link.status === 'missing_evidence')).toBe(true);
  });
});

describe('演示数据源 · 岗位、匹配与组合', () => {
  it('私人 JD 解析要求并确认后才进入岗位详情，公共库只展示已发布岗位', async () => {
    const transport = makeTransport();
    await login(transport);
    const publicJobs = await ok<Schema['JobListResponse']>(transport, 'GET', '/jobs?scope=public');
    expect(publicJobs.items.map((job) => job.title)).toEqual(expect.arrayContaining(['数据分析实习生', '产品运营实习生']));

    const created = await ok<Schema['Job']>(transport, 'POST', '/jobs', {
      title: '增长分析实习生（私人）',
      company: '演示公司',
      location: '广州',
      jdText: '任职要求：本科及以上学历。\n熟悉 JavaScript 与数据看板工具。',
    });
    expect(created.scope).toBe('private');
    expect(created.requirements).toHaveLength(0);

    await confirmRequirements(transport, created.id);
    const detail = await ok<Schema['Job']>(transport, 'GET', `/jobs/${created.id}`);
    expect(detail.requirements.length).toBeGreaterThan(0);
    expect(detail.requirements.every((requirement) => (requirement.quote ?? '').length > 0)).toBe(true);
    expect(detail.degreeRequirement).toBe('bachelor');

    const mine = await ok<Schema['JobListResponse']>(transport, 'GET', '/jobs?scope=mine');
    expect(mine.items.map((job) => job.id)).toContain(created.id);
    const stillPublic = await ok<Schema['JobListResponse']>(transport, 'GET', '/jobs?scope=public');
    expect(stillPublic.items.map((job) => job.id)).not.toContain(created.id);
  });

  it('学生看不到未发布岗位，管理员可以发布、下架与查看草稿', async () => {
    const transport = makeTransport();
    await login(transport, DEMO_USER_IDS.student);
    expect((await fail(transport, 'GET', '/admin/jobs')).status).toBe(403);

    await login(transport, DEMO_USER_IDS.admin);
    const adminJobs = await ok<Schema['JobListResponse']>(transport, 'GET', '/admin/jobs');
    const draft = adminJobs.items.find((job) => job.status === 'draft');
    expect(draft?.title).toBe('算法工程实习生');

    const published = await ok<Schema['Job']>(transport, 'POST', `/admin/jobs/${draft!.id}/publish`, { action: 'publish' });
    expect(published.status).toBe('published');

    await login(transport, DEMO_USER_IDS.student);
    const visible = await ok<Schema['JobListResponse']>(transport, 'GET', '/jobs?scope=public');
    expect(visible.items.map((job) => job.title)).toContain('算法工程实习生');
  });

  it('匹配沿用 rules-v1：硬条件三态、分项分数与引用解释，未同步输入返回 sync_required', async () => {
    const transport = makeTransport();
    await login(transport);
    const jobs = await ok<Schema['JobListResponse']>(transport, 'GET', '/jobs?scope=public');
    const job = jobs.items.find((item) => item.title === '数据分析实习生')!;
    const profile = await ok<Schema['Profile']>(transport, 'GET', '/profile');

    const stale = await fail(transport, 'POST', '/matches', {
      jobId: job.id,
      clientProfileVersion: profile.version + 1,
      clientExperienceVersions: [],
    });
    expect(stale.status).toBe(409);
    expect(stale.payload.error.code).toBe('sync_required');

    const accepted = await ok<Schema['AcceptedResponse']>(transport, 'POST', '/matches', {
      jobId: job.id,
      clientProfileVersion: profile.version,
      clientExperienceVersions: [],
    });
    const operation = await runOperation(transport, accepted.operationId);
    expect(operation.status).toBe('succeeded');
    const snapshot = await ok<Schema['MatchSnapshot']>(transport, 'GET', `/matches/${operation.resultRef}`);
    expect(snapshot.ruleVersion).toBe('rules-v1');
    expect(snapshot.hardConditions.every((condition) => ['met', 'unmet', 'unknown'].includes(condition.status))).toBe(true);
    expect(snapshot.scores.total).toBeGreaterThan(0);
    expect(snapshot.scores.coverageNote).toContain('技能覆盖 50%');
    expect(snapshot.quotes.length + snapshot.gaps.length).toBeGreaterThanOrEqual(0);

    const confirmedSkill = snapshot.hardConditions.find((condition) => condition.kind === 'skill' && condition.requirement === 'Python');
    expect(confirmedSkill).toMatchObject({ status: 'met', note: '已确认证据' });
  });

  it('要求未在经历中出现的技能时，硬条件为未知而不是通过', async () => {
    const transport = makeTransport();
    await login(transport);
    const created = await ok<Schema['Job']>(transport, 'POST', '/jobs', {
      title: '前端实习生（私人）',
      jdText: '任职要求：熟悉 JavaScript 与 React。',
    });
    await confirmRequirements(transport, created.id);
    const profile = await ok<Schema['Profile']>(transport, 'GET', '/profile');
    const accepted = await ok<Schema['AcceptedResponse']>(transport, 'POST', '/matches', {
      jobId: created.id,
      clientProfileVersion: profile.version,
      clientExperienceVersions: [],
    });
    const operation = await runOperation(transport, accepted.operationId);
    const snapshot = await ok<Schema['MatchSnapshot']>(transport, 'GET', `/matches/${operation.resultRef}`);
    const unknown = snapshot.hardConditions.filter((condition) => condition.kind === 'skill');
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown.every((condition) => condition.status === 'unknown')).toBe(true);
    expect(unknown[0]?.note).toContain('待核实');
  });

  it('组合按预算与硬条件筛选，未满足的岗位不进入执行组合', async () => {
    const transport = makeTransport();
    await login(transport);
    const jobs = await ok<Schema['JobListResponse']>(transport, 'GET', '/jobs?scope=public');
    const profile = await ok<Schema['Profile']>(transport, 'GET', '/profile');
    const blocked = await ok<Schema['Job']>(transport, 'POST', '/jobs', { title: '需要 Java 的私人岗位', jdText: '任职要求：熟悉 Java。' });
    await confirmRequirements(transport, blocked.id);

    for (const jobId of [...jobs.items.map((job) => job.id), blocked.id]) {
      const accepted = await ok<Schema['AcceptedResponse']>(transport, 'POST', '/matches', {
        jobId,
        clientProfileVersion: profile.version,
        clientExperienceVersions: [],
      });
      await runOperation(transport, accepted.operationId);
    }

    const portfolio = await ok<Schema['Portfolio']>(transport, 'POST', '/portfolios', {
      timeBudgetHours: 8,
      pinnedJobIds: [],
      removedJobIds: [],
      asOfDate: '2026-09-29',
    });
    expect(portfolio.items.length).toBe(3);
    const blockedItem = portfolio.items.find((item) => item.jobId === blocked.id);
    expect(blockedItem).toMatchObject({ selected: false, excludedReason: 'hard_conditions' });
    expect(portfolio.items.some((item) => item.selected)).toBe(true);
    expect(portfolio.notes).toMatchObject({ ruleVersion: 'rules-v1' });
  });
});

describe('演示数据源 · 计划、改写与投递', () => {
  async function bootstrapPlan(transport: DemoTransportHandle) {
    await login(transport);
    const jobs = await ok<Schema['JobListResponse']>(transport, 'GET', '/jobs?scope=public');
    const profile = await ok<Schema['Profile']>(transport, 'GET', '/profile');
    for (const job of jobs.items) {
      const accepted = await ok<Schema['AcceptedResponse']>(transport, 'POST', '/matches', {
        jobId: job.id,
        clientProfileVersion: profile.version,
        clientExperienceVersions: [],
      });
      await runOperation(transport, accepted.operationId);
    }
    const portfolio = await ok<Schema['Portfolio']>(transport, 'POST', '/portfolios', { timeBudgetHours: 8, asOfDate: '2026-09-29' });
    const planAccepted = await ok<Schema['AcceptedResponse']>(transport, 'POST', '/plans', {
      portfolioId: portfolio.id,
      clientProfileVersion: profile.version,
      clientExperienceVersions: [],
    });
    const operation = await runOperation(transport, planAccepted.operationId);
    const detail = await ok<Schema['PlanDetail']>(transport, 'GET', `/plans/${operation.resultRef}`);
    return { portfolio, plan: detail.plan, tasks: detail.tasks };
  }

  it('计划先生成草稿，确认后生效并排定提醒；任务延期只产生调整建议', async () => {
    const transport = makeTransport();
    const { plan, tasks } = await bootstrapPlan(transport);
    expect(plan.status).toBe('draft');
    expect(tasks.length).toBeGreaterThanOrEqual(4);
    expect(tasks.every((task) => task.jobId && task.scheduledDate)).toBe(true);
    expect(tasks.some((task) => task.deps.length > 0)).toBe(true);
    expect(tasks.every((task) => (task.scheduledDate ?? '') <= '2026-10-13')).toBe(true);

    const confirmed = await ok<Schema['Plan']>(transport, 'POST', `/plans/${plan.id}/confirm`);
    expect(confirmed.status).toBe('confirmed');

    const notifications = await ok<Schema['NotificationListResponse']>(transport, 'GET', '/notifications');
    expect(notifications.items.length).toBeGreaterThan(0);
    expect(notifications.unreadCount).toBeGreaterThan(0);

    const task = tasks[0]!;
    const delayPayload = { scheduledDate: '2026-10-05', baseVersion: task.version };
    const updated = await ok<{ task: Schema['PlanTask']; suggestionId: string | null }>(transport, 'PATCH', `/tasks/${task.id}`, delayPayload);
    expect(updated.task.scheduledDate).toBe('2026-10-05');
    expect(updated.suggestionId).toBeTruthy();

    const suggestions = await ok<{ items: Schema['AdjustmentSuggestion'][] }>(transport, 'GET', `/plans/${plan.id}/suggestions`);
    expect(suggestions.items[0]).toMatchObject({ trigger: 'task_delay', status: 'pending' });
    const accepted = await ok<Schema['AdjustmentSuggestion']>(transport, 'POST', `/suggestions/${suggestions.items[0]!.id}/resolve`, { action: 'accept' });
    expect(accepted.status).toBe('accepted');

    // 采纳建议后任务回到建议里的日期（提案带版本检查，不会静默覆盖）。
    const detail = await ok<Schema['PlanDetail']>(transport, 'GET', `/plans/${plan.id}`);
    expect(detail.tasks.find((row) => row.id === task.id)?.scheduledDate).toBe('2026-10-05');
  });

  it('确认新计划后旧计划标记 superseded，旧任务保留且不能再次确认', async () => {
    const transport = makeTransport();
    const { plan: first, tasks: firstTasks } = await bootstrapPlan(transport);
    await ok<Schema['Plan']>(transport, 'POST', `/plans/${first.id}/confirm`);

    const { plan: second } = await bootstrapPlan(transport);
    const confirmed = await ok<Schema['Plan']>(transport, 'POST', `/plans/${second.id}/confirm`);
    expect(confirmed.status).toBe('confirmed');

    const list = await ok<{ items: Schema['Plan'][] }>(transport, 'GET', '/plans');
    expect(list.items.find((row) => row.id === first.id)?.status).toBe('superseded');
    expect(list.items.find((row) => row.id === second.id)?.status).toBe('confirmed');

    // 旧计划的任务保留，但状态已不是草稿，不能再确认
    const firstDetail = await ok<Schema['PlanDetail']>(transport, 'GET', `/plans/${first.id}`);
    expect(firstDetail.tasks.length).toBe(firstTasks.length);
    const again = await fail(transport, 'POST', `/plans/${first.id}/confirm`);
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  it('改写建议逐条采纳后写回经历原文并提升版本', async () => {
    const transport = makeTransport();
    await login(transport);
    const bundle = await ok<Schema['EvidenceBundle']>(transport, 'GET', '/evidence');
    const experience = bundle.experiences[0]!;
    const accepted = await ok<Schema['AcceptedResponse']>(transport, 'POST', '/rewrites', { experienceId: experience.id });
    const operation = await runOperation(transport, accepted.operationId);
    const rewrite = await ok<Schema['Rewrite']>(transport, 'GET', `/rewrites/${operation.resultRef}`);
    expect(rewrite.status).toBe('ready');
    const item = rewrite.items[0]!;
    expect(item.quoteVerified).toBe(true);

    const resolved = await ok<Schema['Rewrite']>(transport, 'POST', `/rewrites/${rewrite.id}/items/${item.id}/resolve`, { action: 'accept' });
    expect(resolved.items[0]?.status).toBe('accepted');
    const after = await ok<Schema['EvidenceBundle']>(transport, 'GET', '/evidence');
    const updated = after.experiences.find((row) => row.id === experience.id)!;
    expect(updated.version).toBe(experience.version + 1);
    expect(updated.description).toContain('表述更聚焦岗位职责与产出');
  });

  it('投递状态机、面试提醒与效率统计可用', async () => {
    const transport = makeTransport();
    await login(transport);
    const application = await ok<Schema['Application']>(transport, 'POST', '/applications', {
      jobId: null,
      jobTitle: '数据分析实习生',
      company: '星辰零售（虚构）',
      notes: '',
      status: 'preparing',
    });
    expect((await ok<{ items: Schema['ApplicationEvent'][] }>(transport, 'GET', `/applications/${application.id}/events`)).items).toHaveLength(1);

    const illegal = await fail(transport, 'POST', `/applications/${application.id}/events`, { type: 'status_change', toStatus: 'offered' });
    expect(illegal.status).toBe(422);
    expect(illegal.payload.error.details?.[0]?.issue).toContain('preparing');

    const submitted = await ok<Schema['ApplicationEvent']>(transport, 'POST', `/applications/${application.id}/events`, { type: 'status_change', toStatus: 'submitted' });
    expect(submitted.toStatus).toBe('submitted');

    const interview = await ok<Schema['Interview']>(transport, 'POST', `/applications/${application.id}/interviews`, {
      stage: '一面',
      scheduledAt: '2026-09-30T03:00:00.000Z',
      locationOrLink: '线上会议',
    });
    expect(interview.applicationId).toBe(application.id);

    const empty = await ok<Schema['EfficiencyStats']>(transport, 'GET', '/applications/stats?from=2026-09-01&to=2026-09-30');
    expect(empty).toMatchObject({ interviewedCount: 0, totalHours: 0, efficiency: null });

    await ok(transport, 'POST', '/time-entries', { applicationId: application.id, minutes: 120, spentOn: '2026-09-29', note: '准备面试' });
    await ok(transport, 'POST', `/applications/${application.id}/events`, { type: 'status_change', toStatus: 'interviewing' });
    const stats = await ok<Schema['EfficiencyStats']>(transport, 'GET', '/applications/stats?from=2026-09-01&to=2026-09-30');
    expect(stats.totalHours).toBe(2);
    expect(stats.interviewedCount).toBe(1);
    expect(stats.efficiency).toBe(5);
  });
});

describe('演示数据源 · 离线同步、失败注入与重置', () => {
  it('同步协议幂等去重、版本冲突返回服务端记录、删除必须带 baseVersion', async () => {
    const transport = makeTransport();
    await login(transport);
    const opId = 'op-create-1';
    const create = {
      operations: [
        {
          opId,
          entity: 'experience',
          entityId: '90000000-0000-4000-8000-000000000001',
          baseVersion: 0,
          action: 'upsert',
          payload: { title: '离线新增经历', description: '在无网络时创建的描述。' },
        },
      ],
    };
    const first = await ok<Schema['SyncResponse']>(transport, 'POST', '/sync/operations', create);
    expect(first.results[0]).toMatchObject({ status: 'applied', version: 1 });

    const duplicate = await ok<Schema['SyncResponse']>(transport, 'POST', '/sync/operations', create);
    expect(duplicate.results[0]?.status).toBe('duplicate');

    const stale = await ok<Schema['SyncResponse']>(transport, 'POST', '/sync/operations', {
      operations: [
        {
          opId: 'op-update-stale',
          entity: 'experience',
          entityId: '90000000-0000-4000-8000-000000000001',
          baseVersion: 0,
          action: 'upsert',
          payload: { title: '陈旧版本更新', description: '旧设备的修改。' },
        },
      ],
    });
    expect(stale.results[0]).toMatchObject({ status: 'conflict', version: 1 });
    expect(stale.results[0]?.record).toMatchObject({ title: '离线新增经历' });

    const deleteWithoutVersion = await ok<Schema['SyncResponse']>(transport, 'POST', '/sync/operations', {
      operations: [{ opId: 'op-delete', entity: 'experience', entityId: '90000000-0000-4000-8000-000000000001', action: 'delete' }],
    });
    expect(deleteWithoutVersion.results[0]).toMatchObject({ status: 'rejected' });
    expect(deleteWithoutVersion.results[0]?.error).toContain('baseVersion');

    const changes = await ok<Schema['SyncChangesResponse']>(transport, 'GET', '/sync/changes?since=0&limit=100');
    expect(changes.cursor).toBeGreaterThan(0);
    expect(changes.changes.length).toBeGreaterThan(0);
    expect(changes.changes.every((change) => typeof change.entity === 'string')).toBe(true);
  });

  it('可注入服务端故障与离线失败（离线时 fetch 抛 TypeError，便于演示离线队列）', async () => {
    const transport = makeTransport();
    transport.controls.failNextRequests(1);
    const serverError = await call(transport, 'GET', '/session');
    expect(serverError.status).toBe(503);
    expect((serverError.payload as Schema['ErrorBody']).error.code).toBe('network_unavailable');

    transport.controls.failNextRequests(1, { offline: true });
    await expect(transport('/api/v1/session')).rejects.toBeInstanceOf(TypeError);
    const recovered = await ok<Schema['SessionResponse']>(transport, 'GET', '/session');
    expect(recovered.authenticated).toBe(false);
  });

  it('演示数据重置只清空当前身份，公共岗位库与其他身份保留', async () => {
    const transport = makeTransport();
    await login(transport);
    await ok(transport, 'POST', '/jobs', { title: '临时私人岗位', jdText: '演示数据' });
    await ok(transport, 'POST', '/applications', { jobId: null, jobTitle: '临时投递', company: '', notes: '', status: 'preparing' });
    expect((await ok<Schema['JobListResponse']>(transport, 'GET', '/jobs?scope=mine')).items).toHaveLength(1);

    // 另一个演示身份自己的画像不应被重置。
    await login(transport, DEMO_USER_IDS.student2);
    await ok(transport, 'PUT', '/profile', { targetRoles: ['产品运营实习生'], baseVersion: 0 });
    await login(transport);

    const reset = await ok<Schema['DemoResetResponse']>(transport, 'POST', '/demo/reset');
    expect(reset).toMatchObject({ reset: true, userId: DEMO_USER_IDS.student });
    expect(reset.deletedRows).toBeGreaterThan(0);

    // 当前身份仍然登录，但业务数据已清空（画像回到空壳）。
    expect((await ok<Schema['SessionResponse']>(transport, 'GET', '/session')).authenticated).toBe(true);
    expect((await ok<Schema['JobListResponse']>(transport, 'GET', '/jobs?scope=mine')).items).toHaveLength(0);
    expect((await ok<{ items: Schema['Application'][] }>(transport, 'GET', '/applications')).items).toHaveLength(0);
    expect((await ok<Schema['EvidenceBundle']>(transport, 'GET', '/evidence')).experiences).toHaveLength(0);
    expect((await ok<Schema['Profile']>(transport, 'GET', '/profile')).version).toBe(0);
    // 公共岗位库与另一个演示身份不受影响。
    expect((await ok<Schema['JobListResponse']>(transport, 'GET', '/jobs?scope=public')).items).toHaveLength(2);

    await login(transport, DEMO_USER_IDS.student2);
    expect((await ok<Schema['Profile']>(transport, 'GET', '/profile')).targetRoles).toEqual(['产品运营实习生']);
  });

  it('按选项模拟请求延迟', async () => {
    const transport = makeTransport({ latencyMs: 40, latencyJitterMs: 0 });
    const started = Date.now();
    await ok(transport, 'GET', '/session');
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    transport.controls.setLatency(0);
    const fast = Date.now();
    await ok(transport, 'GET', '/session');
    expect(Date.now() - fast).toBeLessThan(25);
  });
});
