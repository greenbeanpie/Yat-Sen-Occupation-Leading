import { APPLICATION_STATUSES, type ApplicationStatus } from "../shared/constants";

/**
 * 投递状态机（PLAN.md 三）：准备中/已投递/面试中/已录用/已拒绝/已撤回。
 * 变化历史记录在 application_events。
 */
export const APPLICATION_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  preparing: ["submitted", "withdrawn"],
  submitted: ["interviewing", "rejected", "withdrawn"],
  interviewing: ["offered", "rejected", "withdrawn"],
  offered: ["withdrawn"],
  rejected: [],
  withdrawn: [],
};

export function canTransition(from: string, to: string): boolean {
  const allowed = APPLICATION_TRANSITIONS[from as ApplicationStatus];
  if (!allowed) return false;
  return allowed.includes(to as ApplicationStatus);
}

export function isApplicationStatus(v: string): v is ApplicationStatus {
  return (APPLICATION_STATUSES as readonly string[]).includes(v);
}

/** 任务状态流转：pending → in_progress → done；pending/in_progress 可取消。 */
export const TASK_TRANSITIONS: Record<string, string[]> = {
  pending: ["in_progress", "done", "cancelled"],
  in_progress: ["done", "cancelled", "pending"],
  done: [],
  cancelled: [],
};

export function canTransitionTask(from: string, to: string): boolean {
  return (TASK_TRANSITIONS[from] ?? []).includes(to);
}
