import { RULE_VERSION } from "../shared/constants";

/**
 * 规则引擎（PLAN.md 2.5）：硬条件判断、匹配分、组合选择。
 * 全部为确定性纯函数，带 RULE_VERSION 版本标识；模型不能改写规则分数。
 */

export type HardStatus = "met" | "unmet" | "unknown";

export interface HardRequirement {
  kind: string; // degree | location | graduation_year | skill | experience | other
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
  status: "pending" | "confirmed" | "missing_evidence";
}

const DEGREE_ORDER = ["associate", "bachelor", "master", "phd"];

/** 硬条件三态：未知不能视为通过（不满足或待核实的岗位不自动进入组合）。 */
export function evaluateHardConditions(requirements: HardRequirement[], profile: CandidateProfile, evidence: SkillEvidence[]): ConditionResult[] {
  const byName = new Map(evidence.map((e) => [e.skillName.toLowerCase(), e]));
  return requirements.map((req) => {
    const base: ConditionResult = { kind: req.kind, requirement: req.value, status: "unknown" };
    switch (req.kind) {
      case "degree": {
        if (!req.value || req.value === "none") return { ...base, status: "met", note: "无学历要求" };
        if (!profile.degree) return { ...base, note: "画像未填写学历" };
        const reqIdx = DEGREE_ORDER.indexOf(req.value);
        const myIdx = DEGREE_ORDER.indexOf(profile.degree);
        if (reqIdx < 0 || myIdx < 0) return base;
        return { ...base, status: myIdx >= reqIdx ? "met" : "unmet" };
      }
      case "graduation_year": {
        const year = Number(req.value);
        if (!Number.isFinite(year)) return base;
        if (profile.graduationYear == null) return { ...base, note: "画像未填写毕业年份" };
        // 岗位要求的毕业年份区间以 value±0 表示单一年份；前后各放宽 1 年容忍
        return { ...base, status: Math.abs(profile.graduationYear - year) <= 1 ? "met" : "unmet" };
      }
      case "location": {
        if (profile.preferredLocations.length === 0) return { ...base, note: "画像未填写意向地点" };
        const reqLower = req.value.toLowerCase();
        const hit = profile.preferredLocations.some((loc) => reqLower.includes(loc.toLowerCase()) || loc.toLowerCase().includes(reqLower));
        return { ...base, status: hit ? "met" : "unmet" };
      }
      case "skill": {
        const ev = byName.get(req.value.toLowerCase());
        if (!ev) return { ...base, note: "经历中未出现该技能，待核实" };
        return { ...base, status: "met", note: ev.status === "confirmed" ? "已确认证据" : "证据待确认" };
      }
      default:
        return { ...base, status: "unknown", note: "需人工核实" };
    }
  });
}

export interface MatchScores {
  skillCoverage: number;
  evidenceCoverage: number;
  preference: number | null;
  total: number;
  coverageNote: string;
}

const W_SKILL = 0.5;
const W_EVIDENCE = 0.3;
const W_PREF = 0.2;

/**
 * 匹配分：技能覆盖 50% + 已确认证据覆盖 30% + 岗位与偏好 20%。
 * 偏好缺失时移除该项并归一化，同时说明评分覆盖范围。分数只用于解释排序，不是概率。
 */
export function computeMatchScores(
  requirements: HardRequirement[],
  evidence: SkillEvidence[],
  profile: CandidateProfile,
  job: { title: string; company: string; location: string | null },
): MatchScores {
  const skillReqs = requirements.filter((r) => r.kind === "skill");
  const byName = new Map(evidence.map((e) => [e.skillName.toLowerCase(), e]));

  let skillCoverage = 1;
  let evidenceCoverage = 1;
  if (skillReqs.length === 0) {
    // 岗位未列出技能要求：覆盖视为满分，但说明覆盖范围
    skillCoverage = 1;
    evidenceCoverage = 1;
  } else {
    let covered = 0;
    let confirmed = 0;
    for (const req of skillReqs) {
      const ev = byName.get(req.value.toLowerCase());
      if (ev) {
        covered++;
        if (ev.status === "confirmed") confirmed++;
      }
    }
    skillCoverage = covered / skillReqs.length;
    evidenceCoverage = covered === 0 ? 0 : confirmed / covered;
  }

  // 偏好分：目标角色与岗位标题、行业与公司/地点的粗粒度重叠
  const hasPreference = profile.targetRoles.length > 0 || profile.industries.length > 0 || profile.preferredLocations.length > 0;
  let preference: number | null = null;
  if (hasPreference) {
    const haystack = `${job.title} ${job.company} ${job.location ?? ""}`.toLowerCase();
    const tokens = [...profile.targetRoles, ...profile.industries, ...profile.preferredLocations].filter((t) => t.length >= 2);
    const hits = tokens.filter((t) => haystack.includes(t.toLowerCase())).length;
    preference = tokens.length === 0 ? 0 : hits / tokens.length;
  }

  let total: number;
  let coverageNote: string;
  if (preference === null) {
    total = (skillCoverage * W_SKILL + evidenceCoverage * W_EVIDENCE) / (W_SKILL + W_EVIDENCE);
    coverageNote = "偏好未填写：已按技能覆盖与证据覆盖两项归一化评分";
  } else {
    total = skillCoverage * W_SKILL + evidenceCoverage * W_EVIDENCE + preference * W_PREF;
    coverageNote = "技能覆盖 50% + 已确认证据覆盖 30% + 岗位与偏好匹配 20%";
  }
  return { skillCoverage, evidenceCoverage, preference, total, coverageNote };
}

/** 组合候选：由规则引擎选择的输入。 */
export interface PortfolioCandidate {
  jobId: string;
  title: string;
  score: number;
  hardBlocked: boolean; // 有不满足或未知的硬条件
  prepHours: number | null;
  deadline: string | null; // YYYY-MM-DD
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

/**
 * 组合选择（PLAN.md 2.5）：按“匹配分／预计准备时间”排序，在剩余预算内依次选择
 * 能在截止日前完成准备的岗位；同分优先截止时间较近者。预算不足明确指出。
 */
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
    .filter((c) => !removed.has(c.jobId))
    .map((c) => ({
      jobId: c.jobId,
      pinned: pinned.has(c.jobId),
      score: c.score,
      prepHours: c.prepHours,
      deadline: c.deadline,
      unitBenefit: c.prepHours && c.prepHours > 0 ? c.score / c.prepHours : null,
      selected: false,
      excludedReason: null,
    }));

  // 有单位时间收益按其排序，无则按分数；同分先截止近者
  const order = (a: PortfolioSelectionItem, b: PortfolioSelectionItem): number => {
    const ua = a.unitBenefit ?? -1;
    const ub = b.unitBenefit ?? -1;
    if (ua !== ub) return ub - ua;
    if (a.score !== b.score) return b.score - a.score;
    return (a.deadline ?? "9999-12-31").localeCompare(b.deadline ?? "9999-12-31");
  };

  const rank = (list: PortfolioSelectionItem[]) => {
    const pinnedItems = list.filter((i) => i.pinned).sort(order);
    const rest = list.filter((i) => !i.pinned).sort(order);
    return [...pinnedItems, ...rest];
  };

  let remaining = budgetHours;
  const asOfTime = asOf ? new Date(asOf).getTime() : null;
  for (const item of rank(items)) {
    const candidate = candidates.find((c) => c.jobId === item.jobId);
    if (candidate?.hardBlocked) {
      item.excludedReason = "hard_conditions"; // 不满足或待核实的硬条件：不自动进入组合
      continue;
    }
    if (item.prepHours != null && item.prepHours > remaining) {
      item.excludedReason = "budget"; // 预算不足，明确指出而不扩大预算
      continue;
    }
    if (item.prepHours != null && item.deadline && asOfTime != null) {
      const daysNeeded = Math.ceil((item.prepHours / weekly) * 7);
      const finish = asOfTime + daysNeeded * 86_400_000;
      if (finish > new Date(item.deadline).getTime()) {
        item.excludedReason = "deadline"; // 截止前无法完成准备
        continue;
      }
    }
    item.selected = true;
    if (item.prepHours != null) remaining -= item.prepHours;
  }

  const pinnedButExcluded = items.filter((i) => i.pinned && !i.selected && i.excludedReason);
  return {
    items,
    notes: {
      ruleVersion: RULE_VERSION,
      remainingBudget: remaining,
      ...(pinnedButExcluded.length > 0
        ? { pinnedWarning: "部分固定岗位因预算或截止时间未能进入组合" }
        : {}),
    },
  };
}
