import type { EntityConfig } from "./entity-writer";

/** 实体列配置（契约字段 ↔ D1 列），在线与离线写入共用。 */
export const PROFILE_CFG: EntityConfig = {
  entity: "profile",
  table: "profiles",
  fields: {
    targetRoles: { json: true },
    industries: { json: true },
    graduationYear: { nullable: true },
    degree: { nullable: true },
    preferredLocations: { json: true },
    weeklyTimeBudgetHours: { nullable: true },
  },
};

export const EXPERIENCE_CFG: EntityConfig = {
  entity: "experience",
  table: "experiences",
  fields: {
    title: {},
    organization: {},
    kind: {},
    startDate: { nullable: true },
    endDate: { nullable: true },
    description: {},
    sourceDocumentId: { nullable: true },
  },
};

export const SKILL_CFG: EntityConfig = {
  entity: "skill",
  table: "skills",
  fields: { name: {} },
};

export const EVIDENCE_CFG: EntityConfig = {
  entity: "evidence",
  table: "experience_skills",
  fields: {
    skillId: {},
    experienceId: {},
    quote: {},
    status: {},
  },
};

export const TASK_CFG: EntityConfig = {
  entity: "task",
  table: "plan_tasks",
  fields: {
    title: {},
    description: {},
    jobId: { nullable: true },
    evidenceId: { nullable: true },
    gap: { nullable: true },
    estimateHours: { nullable: true },
    actualHours: { nullable: true },
    scheduledDate: { nullable: true },
    status: {},
    deps: { json: true, column: "deps_json" },
  },
};

export const APPLICATION_CFG: EntityConfig = {
  entity: "application",
  table: "applications",
  fields: {
    jobId: { nullable: true },
    jobTitle: {},
    company: {},
    status: {},
    notes: {},
  },
};

export const APPLICATION_EVENT_CFG: EntityConfig = {
  entity: "application_event",
  table: "application_events",
  fields: {
    applicationId: {},
    type: {},
    fromStatus: { nullable: true },
    toStatus: { nullable: true },
    note: { nullable: true },
    occurredAt: {},
  },
};

export const INTERVIEW_CFG: EntityConfig = {
  entity: "interview",
  table: "interviews",
  fields: {
    applicationId: {},
    stage: {},
    scheduledAt: {},
    locationOrLink: { nullable: true },
    result: {},
    feedback: { nullable: true },
  },
};

export const TIME_ENTRY_CFG: EntityConfig = {
  entity: "time_entry",
  table: "time_entries",
  fields: {
    applicationId: { nullable: true },
    taskId: { nullable: true },
    minutes: {},
    spentOn: {},
    note: { nullable: true },
  },
};

export const PORTFOLIO_CFG: EntityConfig = {
  entity: "portfolio",
  table: "portfolios",
  fields: {
    timeBudgetHours: {},
    items: { json: true, column: "items_json" },
    notes: { json: true, column: "notes_json" },
  },
};
