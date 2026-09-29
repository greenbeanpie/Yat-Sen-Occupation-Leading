import type { Env } from "../env";
import { syncRequired } from "../shared/errors";
import { RULE_VERSION } from "../shared/constants";
import { fingerprintOf } from "../infra/db/helpers";
import { rowToJson } from "./entity-writer";
import { PROFILE_CFG } from "./configs";
import type { CandidateProfile, SkillEvidence } from "../domain/rules";

/** 用户输入上下文（匹配/计划的规则输入）。 */
export interface UserRuleContext {
  profile: CandidateProfile;
  profileVersion: number;
  experiences: { id: string; version: number; title: string; description: string; kind: string }[];
  evidence: SkillEvidence[];
}

export async function loadRuleContext(env: Env, userId: string): Promise<UserRuleContext> {
  const profileRow = await env.DB.prepare(`SELECT * FROM profiles WHERE user_id = ?1`).bind(userId).first<Record<string, unknown>>();
  const profileJson = profileRow ? rowToJson(PROFILE_CFG, profileRow) : {};
  const expRows = await env.DB.prepare(`SELECT id, version, title, description, kind FROM experiences WHERE user_id = ?1 AND deleted = 0 ORDER BY id`)
    .bind(userId)
    .all<{ id: string; version: number; title: string; description: string; kind: string }>();
  const evidenceRows = await env.DB
    .prepare(
      `SELECT s.name AS skill_name, es.status AS status FROM experience_skills es JOIN skills s ON s.id = es.skill_id WHERE es.user_id = ?1 AND es.deleted = 0 AND s.deleted = 0`,
    )
    .bind(userId)
    .all<{ skill_name: string; status: string }>();

  return {
    profileVersion: profileRow ? Number(profileRow.version) : 0,
    profile: {
      degree: (profileJson.degree as string | null) ?? null,
      graduationYear: (profileJson.graduationYear as number | null) ?? null,
      preferredLocations: (profileJson.preferredLocations as string[] | undefined) ?? [],
      targetRoles: (profileJson.targetRoles as string[] | undefined) ?? [],
      industries: (profileJson.industries as string[] | undefined) ?? [],
    },
    experiences: expRows.results.map((r) => ({ id: r.id, version: Number(r.version), title: r.title, description: r.description, kind: r.kind })),
    evidence: evidenceRows.results.map((r) => ({ skillName: r.skill_name, status: r.status as SkillEvidence["status"] })),
  };
}

/** 输入指纹的 parts 组装（与 startOperation/处理器共用同一算法）。 */
export function contextParts(ctx: UserRuleContext, extras: unknown[] = []): unknown[] {
  return [RULE_VERSION, ctx.profileVersion, ctx.experiences.map((e) => [e.id, e.version]).sort(), ...extras];
}

/** 输入指纹：画像/经历版本 + 规则版本；旧输入产生的结果不得覆盖新数据。 */
export async function contextFingerprint(ctx: UserRuleContext, extras: unknown[] = []): Promise<string> {
  return fingerprintOf(contextParts(ctx, extras));
}

/**
 * 画像/经历有未同步修改时，必须先同步才能请求新的匹配或计划（PLAN.md 2.6）：
 * 客户端声明的版本领先于服务端，说明本地存在未推送的修改，此时基于服务端数据
 * 生成分析会立刻过期，因此返回 sync_required；客户端版本落后则由同步流程拉取。
 */
export async function assertFreshInputs(
  env: Env,
  userId: string,
  clientProfileVersion: number | null | undefined,
  clientExperienceVersions: { id: string; version: number }[] | null | undefined,
): Promise<void> {
  const ctx = await loadRuleContext(env, userId);
  if (clientProfileVersion != null && clientProfileVersion > ctx.profileVersion) {
    throw syncRequired("画像存在未同步的修改，请先完成同步");
  }
  if (clientExperienceVersions && clientExperienceVersions.length > 0) {
    const server = new Map(ctx.experiences.map((e) => [e.id, e.version]));
    for (const ce of clientExperienceVersions) {
      const sv = server.get(ce.id);
      // A client-only ID is an offline-created experience. It must reach the
      // server through /sync before an analysis can use the server snapshot.
      if (sv === undefined || ce.version > sv) {
        throw syncRequired("经历存在未同步的修改，请先完成同步");
      }
    }
  }
}
