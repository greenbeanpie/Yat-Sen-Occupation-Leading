/**
 * 规则引擎的演示镜像（backend/src/domain/rules.ts 的 rules-v1 语义）。
 *
 * 只保留演示适配器需要的最小集合，并与后端保持同样的确定性：
 * 硬条件三态（未知不等于通过）、技能覆盖 50% + 已确认证据 30% + 偏好 20%、
 * 单位时间收益排序的组合选择。真实分数仍以服务端为准；这里只在无后端演示时使用。
 */

export const RULE_VERSION = 'rules-v1';

export type HardStatus = 'met' | 'unmet' | 'unknown';

export interface HardRequirement {
  kind: string;
  value: string;
  quote?: string | null;
}

export interface ConditionResult {
  kind: string;
  requirement: string;
  status: HardStatus;
  note?: string;
}

export interface CandidateProfile {
  degree: string | null;
  graduationYear: number | null;
  preferredLocations: string[];
  targetRoles: string[];
  industries: string[];
}

export interface SkillEvidence {
  skillName: string;
  status: 'pending' | 'confirmed' | 'missing_evidence';
}

export interface MatchScores {
  skillCoverage: number;
  evidenceCoverage: number;
  preference: number | null;
  total: number;
  coverageNote: string;
}

const DEGREE_ORDER = ['associate', 'bachelor', 'master', 'phd'];

function normalize(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 引用核验：归一化空白后必须在来源文本中命中（伪造引用直接拒绝）。 */
export function verifyQuote(source: string, quote: string): boolean {
  const target = normalize(quote);
  if (!target) return false;
  return normalize(source).includes(target);
}

export function evaluateHardConditions(
  requirements: HardRequirement[],
  profile: CandidateProfile,
  evidence: SkillEvidence[],
): ConditionResult[] {
  const byName = new Map(evidence.map((item) => [item.skillName.toLowerCase(), item]));
  return requirements.map((req) => {
    const base: ConditionResult = { kind: req.kind, requirement: req.value, status: 'unknown' };
    switch (req.kind) {
      case 'degree': {
        if (!req.value || req.value === 'none') return { ...base, status: 'met', note: '无学历要求' };
        if (!profile.degree) return { ...base, note: '画像未填写学历' };
        const required = DEGREE_ORDER.indexOf(req.value);
        const mine = DEGREE_ORDER.indexOf(profile.degree);
        if (required < 0 || mine < 0) return base;
        return { ...base, status: mine >= required ? 'met' : 'unmet' };
      }
      case 'graduation_year': {
        const year = Number(req.value);
        if (!Number.isFinite(year)) return base;
        if (profile.graduationYear == null) return { ...base, note: '画像未填写毕业年份' };
        return { ...base, status: Math.abs(profile.graduationYear - year) <= 1 ? 'met' : 'unmet' };
      }
      case 'location': {
        if (profile.preferredLocations.length === 0) return { ...base, note: '画像未填写意向地点' };
        const required = req.value.toLowerCase();
        const hit = profile.preferredLocations.some(
          (loc) => required.includes(loc.toLowerCase()) || loc.toLowerCase().includes(required),
        );
        return { ...base, status: hit ? 'met' : 'unmet' };
      }
      case 'skill': {
        const found = byName.get(req.value.toLowerCase());
        if (!found) return { ...base, note: '经历中未出现该技能，待核实' };
        return { ...base, status: 'met', note: found.status === 'confirmed' ? '已确认证据' : '证据待确认' };
      }
      default:
        return { ...base, status: 'unknown', note: '需人工核实' };
    }
  });
}

const W_SKILL = 0.5;
const W_EVIDENCE = 0.3;
const W_PREFERENCE = 0.2;

export function computeMatchScores(
  requirements: HardRequirement[],
  evidence: SkillEvidence[],
  profile: CandidateProfile,
  job: { title: string; company: string; location: string | null },
): MatchScores {
  const skillRequirements = requirements.filter((req) => req.kind === 'skill');
  const byName = new Map(evidence.map((item) => [item.skillName.toLowerCase(), item]));

  let skillCoverage = 1;
  let evidenceCoverage = 1;
  if (skillRequirements.length > 0) {
    let covered = 0;
    let confirmed = 0;
    for (const req of skillRequirements) {
      const found = byName.get(req.value.toLowerCase());
      if (!found) continue;
      covered += 1;
      if (found.status === 'confirmed') confirmed += 1;
    }
    skillCoverage = covered / skillRequirements.length;
    evidenceCoverage = covered === 0 ? 0 : confirmed / covered;
  }

  const hasPreference =
    profile.targetRoles.length > 0 || profile.industries.length > 0 || profile.preferredLocations.length > 0;
  let preference: number | null = null;
  if (hasPreference) {
    const haystack = `${job.title} ${job.company} ${job.location ?? ''}`.toLowerCase();
    const tokens = [...profile.targetRoles, ...profile.industries, ...profile.preferredLocations].filter(
      (token) => token.length >= 2,
    );
    const hits = tokens.filter((token) => haystack.includes(token.toLowerCase())).length;
    preference = tokens.length === 0 ? 0 : hits / tokens.length;
  }

  if (preference === null) {
    return {
      skillCoverage,
      evidenceCoverage,
      preference,
      total: (skillCoverage * W_SKILL + evidenceCoverage * W_EVIDENCE) / (W_SKILL + W_EVIDENCE),
      coverageNote: '偏好未填写：已按技能覆盖与证据覆盖两项归一化评分',
    };
  }
  return {
    skillCoverage,
    evidenceCoverage,
    preference,
    total: skillCoverage * W_SKILL + evidenceCoverage * W_EVIDENCE + preference * W_PREFERENCE,
    coverageNote: '技能覆盖 50% + 已确认证据覆盖 30% + 岗位与偏好匹配 20%',
  };
}

export interface PortfolioCandidate {
  jobId: string;
  title: string;
  score: number;
  hardBlocked: boolean;
  prepHours: number | null;
  deadline: string | null;
}

export interface PortfolioSelectionItem {
  jobId: string;
  pinned: boolean;
  score: number;
  prepHours: number | null;
  deadline: string | null;
  unitBenefit: number | null;
  selected: boolean;
  excludedReason: string | null;
}

export interface PortfolioSelection {
  items: PortfolioSelectionItem[];
  notes: Record<string, unknown>;
}

export function selectPortfolio(
  candidates: PortfolioCandidate[],
  budgetHours: number,
  pinnedJobIds: string[],
  removedJobIds: string[],
  weeklyBudgetHours: number | null,
  asOf: string,
): PortfolioSelection {
  const pinned = new Set(pinnedJobIds);
  const removed = new Set(removedJobIds);
  const weekly = weeklyBudgetHours && weeklyBudgetHours > 0 ? weeklyBudgetHours : 8;

  const items: PortfolioSelectionItem[] = candidates
    .filter((candidate) => !removed.has(candidate.jobId))
    .map((candidate) => ({
      jobId: candidate.jobId,
      pinned: pinned.has(candidate.jobId),
      score: candidate.score,
      prepHours: candidate.prepHours,
      deadline: candidate.deadline,
      unitBenefit: candidate.prepHours && candidate.prepHours > 0 ? candidate.score / candidate.prepHours : null,
      selected: false,
      excludedReason: null,
    }));

  const order = (a: PortfolioSelectionItem, b: PortfolioSelectionItem): number => {
    const ua = a.unitBenefit ?? -1;
    const ub = b.unitBenefit ?? -1;
    if (ua !== ub) return ub - ua;
    if (a.score !== b.score) return b.score - a.score;
    return (a.deadline ?? '9999-12-31').localeCompare(b.deadline ?? '9999-12-31');
  };
  const rank = (list: PortfolioSelectionItem[]) => [
    ...list.filter((item) => item.pinned).sort(order),
    ...list.filter((item) => !item.pinned).sort(order),
  ];

  let remaining = budgetHours;
  const asOfTime = asOf ? new Date(asOf).getTime() : null;
  for (const item of rank(items)) {
    const candidate = candidates.find((entry) => entry.jobId === item.jobId);
    if (candidate?.hardBlocked) {
      item.excludedReason = 'hard_conditions';
      continue;
    }
    if (item.prepHours != null && item.prepHours > remaining) {
      item.excludedReason = 'budget';
      continue;
    }
    if (item.prepHours != null && item.deadline && asOfTime != null) {
      const daysNeeded = Math.ceil((item.prepHours / weekly) * 7);
      const finish = asOfTime + daysNeeded * 86_400_000;
      if (finish > new Date(item.deadline).getTime()) {
        item.excludedReason = 'deadline';
        continue;
      }
    }
    item.selected = true;
    if (item.prepHours != null) remaining -= item.prepHours;
  }

  const pinnedButExcluded = items.filter((item) => item.pinned && !item.selected && item.excludedReason);
  return {
    items,
    notes: {
      ruleVersion: RULE_VERSION,
      remainingBudget: remaining,
      ...(pinnedButExcluded.length > 0
        ? { pinnedWarning: '部分固定岗位因预算或截止时间未能进入组合' }
        : {}),
    },
  };
}

/** 投递状态机（与后端 domain/state.ts 一致）。 */
export const APPLICATION_TRANSITIONS: Record<string, string[]> = {
  preparing: ['submitted', 'withdrawn'],
  submitted: ['interviewing', 'rejected', 'withdrawn'],
  interviewing: ['offered', 'rejected', 'withdrawn'],
  offered: ['withdrawn'],
  rejected: [],
  withdrawn: [],
};

export const TASK_TRANSITIONS: Record<string, string[]> = {
  pending: ['in_progress', 'done', 'cancelled'],
  in_progress: ['done', 'cancelled', 'pending'],
  done: [],
  cancelled: [],
};

export function canTransition(from: string, to: string): boolean {
  return (APPLICATION_TRANSITIONS[from] ?? []).includes(to);
}

export function canTransitionTask(from: string, to: string): boolean {
  return (TASK_TRANSITIONS[from] ?? []).includes(to);
}
