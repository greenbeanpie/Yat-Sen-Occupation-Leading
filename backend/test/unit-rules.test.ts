import { describe, expect, it } from "vitest";
import { computeMatchScores, evaluateHardConditions, selectPortfolio, type PortfolioCandidate } from "../src/domain/rules";

const profile = {
  degree: "bachelor",
  graduationYear: 2026,
  preferredLocations: ["上海"],
  targetRoles: ["后端开发"],
  industries: ["互联网"],
};

describe("硬条件三态判定", () => {
  it("学历：满足/不满足/未知", () => {
    const res = evaluateHardConditions(
      [
        { kind: "degree", value: "bachelor" },
        { kind: "degree", value: "master" },
      ],
      profile,
      [],
    );
    expect(res[0]?.status).toBe("met");
    expect(res[1]?.status).toBe("unmet");
    const unknown = evaluateHardConditions([{ kind: "degree", value: "bachelor" }], { ...profile, degree: null }, []);
    expect(unknown[0]?.status).toBe("unknown");
  });

  it("毕业年份在容差内满足", () => {
    const res = evaluateHardConditions([{ kind: "graduation_year", value: "2026" }], profile, []);
    expect(res[0]?.status).toBe("met");
  });

  it("技能有证据满足；无证据为未知（不视为通过）", () => {
    const res = evaluateHardConditions(
      [{ kind: "skill", value: "TypeScript" }],
      profile,
      [{ skillName: "TypeScript", status: "confirmed" }],
    );
    expect(res[0]?.status).toBe("met");
    const unknown = evaluateHardConditions([{ kind: "skill", value: "Go" }], profile, []);
    expect(unknown[0]?.status).toBe("unknown");
  });
});

describe("匹配分（50/30/20 可归一化）", () => {
  it("全覆盖得满分；偏好缺失时归一化并说明", () => {
    const full = computeMatchScores(
      [{ kind: "skill", value: "TypeScript" }],
      [{ skillName: "TypeScript", status: "confirmed" }],
      profile,
      { title: "后端开发工程师", company: "某互联网公司", location: "上海" },
    );
    expect(full.total).toBeCloseTo(1, 5);

    const noPref = computeMatchScores(
      [{ kind: "skill", value: "TypeScript" }],
      [{ skillName: "TypeScript", status: "confirmed" }],
      { ...profile, preferredLocations: [], targetRoles: [], industries: [] },
      { title: "后端开发工程师", company: "某互联网公司", location: "上海" },
    );
    expect(noPref.preference).toBeNull();
    expect(noPref.total).toBeCloseTo(1, 5);
    expect(noPref.coverageNote).toContain("归一化");
  });

  it("待确认证据只给部分覆盖分", () => {
    const pending = computeMatchScores(
      [{ kind: "skill", value: "TypeScript" }],
      [{ skillName: "TypeScript", status: "pending" }],
      profile,
      { title: "后端开发", company: "", location: "上海" },
    );
    // 技能覆盖 1，证据覆盖 0 → 0.5 + 0 + 0.2*pref
    expect(pending.skillCoverage).toBe(1);
    expect(pending.evidenceCoverage).toBe(0);
    expect(pending.total).toBeLessThan(1);
  });
});

describe("组合选择（单位时间收益 + 截止日 + 预算）", () => {
  const candidates: PortfolioCandidate[] = [
    { jobId: "a", title: "A", score: 0.8, hardBlocked: false, prepHours: 10, deadline: "2026-11-30" },
    { jobId: "b", title: "B", score: 0.6, hardBlocked: false, prepHours: 4, deadline: "2026-11-30" },
    { jobId: "c", title: "C", score: 0.9, hardBlocked: false, prepHours: 20, deadline: "2026-11-30" },
    { jobId: "d", title: "D", score: 0.95, hardBlocked: true, prepHours: 2, deadline: null },
  ];

  it("按分数/时间排序选入，预算不足明确排除，硬条件不通过不入选", () => {
    const sel = selectPortfolio(candidates, 15, [], [], 8, "2026-10-01");
    const byId = Object.fromEntries(sel.items.map((i) => [i.jobId, i]));
    // b：0.15/小时 单位收益最高 → 选入
    expect(byId["b"]?.selected).toBe(true);
    // a：0.08/小时 → 选入（剩余 11）
    expect(byId["a"]?.selected).toBe(true);
    // c：0.045/小时 需要 20 > 剩余 5 → budget
    expect(byId["c"]?.selected).toBe(false);
    expect(byId["c"]?.excludedReason).toBe("budget");
    // d：硬条件不通过 → hard_conditions
    expect(byId["d"]?.excludedReason).toBe("hard_conditions");
  });

  it("固定岗位优先纳入，但预算不够仍如实排除", () => {
    const sel = selectPortfolio(candidates, 6, ["c"], [], 8, "2026-10-01");
    const byId = Object.fromEntries(sel.items.map((i) => [i.jobId, i]));
    expect(byId["c"]?.pinned).toBe(true);
    expect(byId["c"]?.selected).toBe(false);
    expect(byId["c"]?.excludedReason).toBe("budget");
    expect(sel.notes.pinnedWarning).toBeTruthy();
  });

  it("截止日之前无法完成准备的不入选", () => {
    const soon: PortfolioCandidate[] = [{ jobId: "x", title: "X", score: 0.9, hardBlocked: false, prepHours: 100, deadline: "2026-10-03" }];
    const sel = selectPortfolio(soon, 200, [], [], 7, "2026-10-01");
    expect(sel.items[0]?.excludedReason).toBe("deadline");
  });

  it("缺少估算时不计算单位时间收益，按分数排序", () => {
    const noPrep: PortfolioCandidate[] = [
      { jobId: "p", title: "P", score: 0.7, hardBlocked: false, prepHours: null, deadline: null },
      { jobId: "q", title: "Q", score: 0.9, hardBlocked: false, prepHours: null, deadline: null },
    ];
    const sel = selectPortfolio(noPrep, 40, [], [], null, "2026-10-01");
    const byId = Object.fromEntries(sel.items.map((i) => [i.jobId, i]));
    expect(byId["q"]?.unitBenefit).toBeNull();
    expect(byId["q"]?.selected).toBe(true);
    expect(byId["p"]?.selected).toBe(true); // 无估算不占预算
  });
});
