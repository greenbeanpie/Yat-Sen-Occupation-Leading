import type {
  DemoDatabase,
  DemoUser,
  ExperienceRecord,
  JobRecord,
  ParseDraftResult,
  ProfileRecord,
  RequirementRecord,
  SkillRecord,
  EvidenceRecord,
} from './demo-types';

/**
 * 虚构演示数据（PLAN.md：演示站使用虚构资料，界面始终标注“演示站 · 虚构数据”）。
 *
 * 数值与状态刻意保留了几处“未确认/未知”，让硬条件未知、证据待确认、
 * 零工时统计等错误态在演示里真的能被走到，而不是只写在文档里。
 */

export const DEMO_USER_IDS = {
  student: '10000000-0000-4000-8000-000000000001',
  student2: '10000000-0000-4000-8000-000000000002',
  admin: '10000000-0000-4000-8000-0000000000ff',
} as const;

/** 只有这个配套示例文件会返回固定解析草稿；其它文件一律明确报错（PLAN.md 4）。 */
export const EXAMPLE_RESUME_FILENAME = '示例简历-林晓.pdf';
const EXAMPLE_FILE_HINT = /示例|样例|sample|example/i;

export const EXAMPLE_RESUME_TEXT = [
  '林晓 · 数据分析方向',
  '教育经历：中山大学 信息管理与信息系统 本科 2027 届',
  '实习经历：某互联网公司 数据分析实习生',
  '负责搭建门店销量看板，使用 Python 清洗 12 万行订单数据，并把结论整理成每周复盘报告。',
  '项目经历：校园二手交易平台 数据分析项目',
  '使用 SQL 完成用户留存分析，并输出可视化看板，供团队每周复盘使用。',
  '技能：Python、SQL、数据分析、可视化',
].join('\n');

export function isExampleResume(filename: string): boolean {
  return filename === EXAMPLE_RESUME_FILENAME || EXAMPLE_FILE_HINT.test(filename);
}

/** 示例文件的解析草稿：所有 quote 都命中 EXAMPLE_RESUME_TEXT，且能关联到经历。 */
export function buildExampleResumeDraft(): ParseDraftResult {
  return {
    experiences: [
      {
        title: '数据分析实习生 · 某互联网公司',
        organization: '某互联网公司（虚构）',
        kind: 'internship',
        startDate: null,
        endDate: null,
        description: '负责搭建门店销量看板，使用 Python 清洗 12 万行订单数据，并把结论整理成每周复盘报告。',
        quote: '使用 Python 清洗 12 万行订单数据',
      },
      {
        title: '校园二手交易平台 · 数据分析项目',
        organization: '中山大学（虚构演示）',
        kind: 'project',
        startDate: null,
        endDate: null,
        description: '使用 SQL 完成用户留存分析，并输出可视化看板，供团队每周复盘使用。',
        quote: '使用 SQL 完成用户留存分析',
      },
    ],
    skills: [
      { name: 'Python', quote: '使用 Python 清洗 12 万行订单数据' },
      { name: 'SQL', quote: '使用 SQL 完成用户留存分析' },
      { name: '数据分析', quote: '完成用户留存分析' },
    ],
    rejectedCounts: { experiences: 0, skills: 0 },
    engine: 'demo-fixture',
  };
}

const PUBLIC_JOB_IDS = {
  dataAnalyst: '30000000-0000-4000-8000-000000000001',
  operations: '30000000-0000-4000-8000-000000000002',
  algorithm: '30000000-0000-4000-8000-000000000003',
  userResearch: '30000000-0000-4000-8000-000000000004',
} as const;

export function buildDemoDatabase(now: Date): DemoDatabase {
  const stamp = now.toISOString();
  const student = DEMO_USER_IDS.student;

  const users: DemoUser[] = [
    {
      id: DEMO_USER_IDS.student,
      role: 'student',
      displayName: '林晓（演示学生）',
      timezone: 'Asia/Shanghai',
      notifyTaskDue: true,
      notifyInterview: true,
    },
    {
      id: DEMO_USER_IDS.student2,
      role: 'student',
      displayName: '陈然（演示学生）',
      timezone: 'Asia/Shanghai',
      notifyTaskDue: true,
      notifyInterview: true,
    },
    {
      id: DEMO_USER_IDS.admin,
      role: 'admin',
      displayName: '演示管理员',
      timezone: 'Asia/Shanghai',
      notifyTaskDue: true,
      notifyInterview: true,
    },
  ];

  // 画像默认填全，保证“岗位 → 匹配 → 组合 → 计划”在演示里能一次走通；
  // “未知”的硬条件会在用户粘贴要求新技能的私人 JD 时自然出现（未知不视为通过）。
  const profile: ProfileRecord = {
    id: '40000000-0000-4000-8000-000000000001',
    userId: student,
    version: 1,
    deleted: false,
    createdAt: stamp,
    updatedAt: stamp,
    targetRoles: ['数据分析实习生'],
    industries: ['互联网'],
    graduationYear: 2027,
    degree: 'bachelor',
    preferredLocations: ['广州', '深圳'],
    weeklyTimeBudgetHours: 8,
  };

  const experiences: ExperienceRecord[] = [
    {
      id: '50000000-0000-4000-8000-000000000001',
      userId: student,
      version: 1,
      deleted: false,
      createdAt: stamp,
      updatedAt: stamp,
      title: '数据分析实习生',
      organization: '某互联网公司（虚构）',
      kind: 'internship',
      startDate: '2026-07-01',
      endDate: '2026-09-15',
      description: '负责搭建门店销量看板，使用 Python 清洗 12 万行订单数据，并把结论整理成每周复盘报告。',
    },
    {
      id: '50000000-0000-4000-8000-000000000002',
      userId: student,
      version: 1,
      deleted: false,
      createdAt: stamp,
      updatedAt: stamp,
      title: '校园二手交易平台 · 数据分析项目',
      organization: '中山大学（虚构演示）',
      kind: 'project',
      startDate: '2026-02-01',
      endDate: '2026-05-30',
      description: '使用 SQL 完成用户留存分析，并输出可视化看板，供团队每周复盘使用。',
    },
  ];

  const skills: SkillRecord[] = [
    { id: '60000000-0000-4000-8000-000000000001', userId: student, version: 1, deleted: false, createdAt: stamp, updatedAt: stamp, name: 'Python' },
    { id: '60000000-0000-4000-8000-000000000002', userId: student, version: 1, deleted: false, createdAt: stamp, updatedAt: stamp, name: 'SQL' },
    { id: '60000000-0000-4000-8000-000000000003', userId: student, version: 1, deleted: false, createdAt: stamp, updatedAt: stamp, name: '数据分析' },
  ];

  // 三种证据状态都覆盖：已确认 / 待确认 / 缺少证据。
  const evidence: EvidenceRecord[] = [
    {
      id: '70000000-0000-4000-8000-000000000001',
      userId: student,
      version: 1,
      deleted: false,
      createdAt: stamp,
      updatedAt: stamp,
      skillId: skills[0]!.id,
      experienceId: experiences[0]!.id,
      quote: '使用 Python 清洗 12 万行订单数据',
      status: 'confirmed',
    },
    {
      id: '70000000-0000-4000-8000-000000000002',
      userId: student,
      version: 1,
      deleted: false,
      createdAt: stamp,
      updatedAt: stamp,
      skillId: skills[1]!.id,
      experienceId: experiences[1]!.id,
      quote: '使用 SQL 完成用户留存分析',
      status: 'pending',
    },
    {
      id: '70000000-0000-4000-8000-000000000003',
      userId: student,
      version: 1,
      deleted: false,
      createdAt: stamp,
      updatedAt: stamp,
      skillId: skills[2]!.id,
      experienceId: experiences[1]!.id,
      quote: '待补：独立负责的数据分析产出',
      status: 'missing_evidence',
    },
  ];

  const jobs: JobRecord[] = [
    publicJob({
      id: PUBLIC_JOB_IDS.dataAnalyst,
      stamp,
      title: '数据分析实习生',
      company: '星辰零售（虚构）',
      location: '广州',
      degreeRequirement: 'bachelor',
      graduationYearFrom: null,
      graduationYearTo: null,
      deadlineDate: '2026-10-20',
      status: 'published',
      jdText: [
        '岗位职责：负责门店经营数据看板与每周复盘。',
        '任职要求：本科及以上学历，2027 届优先。',
        '工作地点：广州 天河区。',
        '熟悉 Python 数据处理，能使用 SQL 完成基本查询。',
      ].join('\n'),
      sourceUrl: 'https://example.invalid/jobs/data-analyst',
    }),
    publicJob({
      id: PUBLIC_JOB_IDS.operations,
      stamp,
      title: '产品运营实习生',
      company: '山海出行（虚构）',
      location: '深圳',
      degreeRequirement: null,
      graduationYearFrom: 2027,
      graduationYearTo: 2027,
      deadlineDate: '2026-11-05',
      status: 'published',
      jdText: [
        '面向 2027 届毕业生，每周可到岗 3 天以上。',
        '有数据分析或用户研究经验者优先。',
        '工作内容：用户增长活动策划与效果复盘。',
      ].join('\n'),
      sourceUrl: 'https://example.invalid/jobs/product-operations',
    }),
    publicJob({
      id: PUBLIC_JOB_IDS.algorithm,
      stamp,
      title: '算法工程实习生',
      company: '云杉科技（虚构）',
      location: '深圳',
      degreeRequirement: 'master',
      graduationYearFrom: null,
      graduationYearTo: null,
      deadlineDate: '2026-12-01',
      status: 'draft',
      jdText: [
        '硕士及以上学历，计算机相关专业。',
        '熟悉 Python 与机器学习基础，有推荐系统经验优先。',
      ].join('\n'),
      sourceUrl: null,
    }),
    publicJob({
      id: PUBLIC_JOB_IDS.userResearch,
      stamp,
      title: '用户研究实习生',
      company: '岭南研究院（虚构）',
      location: '北京',
      degreeRequirement: null,
      graduationYearFrom: null,
      graduationYearTo: null,
      deadlineDate: null,
      status: 'archived',
      jdText: '参与用户访谈与问卷设计，整理研究结论。',
      sourceUrl: null,
    }),
  ];

  const requirements: RequirementRecord[] = [
    requirement(PUBLIC_JOB_IDS.dataAnalyst, 'degree', 'bachelor', '本科及以上学历'),
    requirement(PUBLIC_JOB_IDS.dataAnalyst, 'location', '广州', '工作地点：广州 天河区。'),
    requirement(PUBLIC_JOB_IDS.dataAnalyst, 'skill', 'Python', '熟悉 Python 数据处理'),
    requirement(PUBLIC_JOB_IDS.dataAnalyst, 'skill', 'SQL', '能使用 SQL 完成基本查询'),
    requirement(PUBLIC_JOB_IDS.operations, 'graduation_year', '2027', '面向 2027 届毕业生'),
    requirement(PUBLIC_JOB_IDS.operations, 'skill', '数据分析', '有数据分析或用户研究经验者优先'),
  ];

  return {
    schema: 1,
    seededAt: stamp,
    sessionUserId: null,
    users,
    profiles: [profile],
    experiences,
    skills,
    evidence,
    jobs,
    requirements,
    requirementDrafts: [],
    documents: [],
    parseDrafts: [],
    matches: [],
    portfolios: [],
    plans: [],
    tasks: [],
    suggestions: [],
    rewrites: [],
    applications: [],
    applicationEvents: [],
    interviews: [],
    timeEntries: [],
    operations: [],
    reminders: [],
    pushSubscriptions: [],
    changes: [],
    syncReceipts: [],
    sequence: 0,
  } as DemoDatabase;
}

function publicJob(input: {
  id: string;
  stamp: string;
  title: string;
  company: string;
  location: string;
  degreeRequirement: string | null;
  graduationYearFrom: number | null;
  graduationYearTo: number | null;
  deadlineDate: string | null;
  status: JobRecord['status'];
  jdText: string;
  sourceUrl: string | null;
}): JobRecord {
  return {
    id: input.id,
    userId: null,
    scope: 'public',
    version: 1,
    deleted: false,
    createdAt: input.stamp,
    updatedAt: input.stamp,
    title: input.title,
    company: input.company,
    location: input.location,
    degreeRequirement: input.degreeRequirement,
    graduationYearFrom: input.graduationYearFrom,
    graduationYearTo: input.graduationYearTo,
    sourceUrl: input.sourceUrl,
    deadlineDate: input.deadlineDate,
    status: input.status,
    jdText: input.jdText,
    jobVersion: 1,
    requirements: [],
  };
}

let requirementSeq = 0;

function requirement(jobId: string, kind: string, value: string, quote: string): RequirementRecord {
  requirementSeq += 1;
  return {
    id: `80000000-0000-4000-8000-${String(requirementSeq).padStart(12, '0')}`,
    jobId,
    jobVersion: 1,
    kind,
    value,
    quote,
  };
}
