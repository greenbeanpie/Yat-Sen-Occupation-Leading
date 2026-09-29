import type { Env } from "../env";
import { SYNC_ENTITIES, type SyncEntity } from "../shared/constants";
import { nowIso } from "../shared/datetime";
import { getRow } from "../infra/db/helpers";
import {
  createEntity,
  deleteEntity,
  updateEntity,
  type EntityConfig,
} from "./entity-writer";
import {
  APPLICATION_CFG,
  APPLICATION_EVENT_CFG,
  EVIDENCE_CFG,
  EXPERIENCE_CFG,
  INTERVIEW_CFG,
  PORTFOLIO_CFG,
  PROFILE_CFG,
  SKILL_CFG,
  TASK_CFG,
  TIME_ENTRY_CFG,
} from "./configs";

type PayloadSchema = { parse: (v: unknown) => Record<string, unknown> };

/** 同步实体注册表：离线写入与在线写入共用同一 EntityConfig 与 payload 校验。 */
const SYNC_REGISTRY: Record<SyncEntity, { cfg: EntityConfig }> = {
  profile: { cfg: PROFILE_CFG },
  experience: { cfg: EXPERIENCE_CFG },
  skill: { cfg: SKILL_CFG },
  evidence: { cfg: EVIDENCE_CFG },
  job: { cfg: { entity: "job", table: "jobs", fields: { title: {}, company: {}, location: { nullable: true }, sourceUrl: { nullable: true }, deadlineDate: { nullable: true }, jdText: {} } } },
  portfolio: { cfg: PORTFOLIO_CFG },
  task: { cfg: TASK_CFG },
  application: { cfg: APPLICATION_CFG },
  application_event: { cfg: APPLICATION_EVENT_CFG },
  interview: { cfg: INTERVIEW_CFG },
  time_entry: { cfg: TIME_ENTRY_CFG },
};

export interface SyncOpInput {
  opId: string;
  entity: string;
  entityId?: string | null;
  baseVersion?: number | null;
  action: "upsert" | "delete";
  payload?: unknown;
}

export interface SyncOpResult {
  opId: string;
  status: "applied" | "duplicate" | "conflict" | "rejected";
  version?: number;
  record?: unknown;
  error?: string;
  details?: { field: string; issue: string }[];
}

/** 简单字段校验（离线路径要求与在线 Zod 相同约束，这里做结构级校验 + 必填项）。 */
function validatePayload(entity: SyncEntity, payload: unknown): { ok: true; data: Record<string, unknown> } | { ok: false; details: { field: string; issue: string }[] } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, details: [{ field: "payload", issue: "payload 必须是对象" }] };
  }
  const data = payload as Record<string, unknown>;
  const required: Record<SyncEntity, string[]> = {
    profile: [],
    experience: ["title", "description"],
    skill: ["name"],
    evidence: ["skillId", "experienceId", "quote"],
    job: ["title"],
    portfolio: ["timeBudgetHours"],
    task: ["title"],
    application: ["jobTitle"],
    application_event: ["applicationId", "type"],
    interview: ["applicationId", "scheduledAt"],
    time_entry: ["minutes", "spentOn"],
  };
  const details: { field: string; issue: string }[] = [];
  for (const field of required[entity]) {
    if (data[field] === undefined || data[field] === null || data[field] === "") {
      details.push({ field, issue: "该字段为必填" });
    }
  }
  if (details.length > 0) return { ok: false, details };
  return { ok: true, data };
}

/**
 * 同步单条操作（PLAN.md 2.6）：
 * 1. opId 去重（幂等，重复提交返回原回执）
 * 2. baseVersion 判断可否更新；远端已删除 → conflict
 * 3. baseVersion=0 + 实体不存在 → 以客户端 UUID 创建（离线新建）
 * 4. 冲突返回服务器当前记录，不静默覆盖
 */
export async function applySyncOperation(env: Env, userId: string, op: SyncOpInput): Promise<SyncOpResult> {
  // 1) 幂等去重：重复提交返回 duplicate + 原回执信息（数据只写一次）
  const existing = await env.DB
    .prepare(`SELECT result_json FROM sync_operations WHERE user_id = ?1 AND op_id = ?2`)
    .bind(userId, op.opId)
    .first<{ result_json: string }>();
  if (existing) {
    const stored = JSON.parse(existing.result_json) as SyncOpResult;
    return { ...stored, status: "duplicate" };
  }

  if (!(SYNC_ENTITIES as readonly string[]).includes(op.entity)) {
    return { opId: op.opId, status: "rejected", error: "未知实体类型" };
  }
  const entity = op.entity as SyncEntity;
  const registry = SYNC_REGISTRY[entity];
  const finalize = async (result: SyncOpResult): Promise<SyncOpResult> => {
    await env.DB
      .prepare(`INSERT INTO sync_operations (id, user_id, op_id, request_json, result_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
      .bind(crypto.randomUUID(), userId, op.opId, JSON.stringify(op), JSON.stringify(result), nowIso())
      .run();
    return result;
  };

  // 2) 删除：墓碑；实体不存在视为已达成（幂等）
  if (op.action === "delete") {
    if (!op.entityId) return finalize({ opId: op.opId, status: "rejected", error: "delete 操作需要 entityId" });
    const row = await getRow(env.DB, registry.cfg.table, op.entityId, userId);
    if (!row) return finalize({ opId: op.opId, status: "applied" });
    try {
      await deleteEntity(env, userId, registry.cfg, op.entityId);
      return finalize({ opId: op.opId, status: "applied" });
    } catch {
      return finalize({ opId: op.opId, status: "rejected", error: "删除失败" });
    }
  }

  // 3) upsert
  if (!op.entityId) {
    // 在线创建走各自路由；离线创建必须带客户端生成的 entityId
    return finalize({ opId: op.opId, status: "rejected", error: "upsert 操作需要 entityId（离线新建由客户端生成 UUID）" });
  }

  const validation = validatePayload(entity, op.payload);
  if (!validation.ok) {
    return finalize({ opId: op.opId, status: "rejected", details: validation.details, error: "参数校验失败" });
  }

  const row = await getRow(env.DB, registry.cfg.table, op.entityId, userId);
  if (!row) {
    if ((op.baseVersion ?? 0) === 0) {
      // 离线新建：客户端生成 UUID + baseVersion 0
      const { record, version } = await createEntity(env, userId, registry.cfg, validation.data, undefined, op.entityId);
      return finalize({ opId: op.opId, status: "applied", version, record });
    }
    return finalize({ opId: op.opId, status: "conflict", record: { id: op.entityId, deleted: true }, error: "实体不存在或已被删除" });
  }

  if (Number(row.deleted) === 1) {
    // 远端已删除：冲突处理，不得静默覆盖（PLAN.md 2.6）
    return finalize({ opId: op.opId, status: "conflict", record: { id: op.entityId, deleted: true }, error: "实体已在远端删除" });
  }

  const serverVersion = Number(row.version);
  if (op.baseVersion == null) {
    return finalize({ opId: op.opId, status: "rejected", error: "更新操作必须提供 baseVersion" });
  }
  if (op.baseVersion !== serverVersion) {
    return finalize({ opId: op.opId, status: "conflict", version: serverVersion, error: "版本冲突", record: { ...serializeRow(registry.cfg, row) } });
  }

  try {
    const { record, version } = await updateEntity(env, userId, registry.cfg, op.entityId, baseVersionOrNull(op.baseVersion), validation.data);
    return finalize({ opId: op.opId, status: "applied", version, record });
  } catch (e) {
    if (e instanceof Error && e.message.includes("409")) {
      return finalize({ opId: op.opId, status: "conflict", error: "版本冲突" });
    }
    return finalize({ opId: op.opId, status: "rejected", error: e instanceof Error ? e.message : "写入失败" });
  }
}

function baseVersionOrNull(v: number | null | undefined): number | null | undefined {
  return v;
}

function serializeRow(cfg: EntityConfig, row: Record<string, unknown>): Record<string, unknown> {
  void cfg;
  // 轻量序列化：仅用于冲突提示
  return { ...row, deleted: Number(row.deleted) === 1 };
}

/** 批量同步：顺序应用，逐条返回回执。 */
export async function applySyncBatch(env: Env, userId: string, ops: SyncOpInput[]): Promise<SyncOpResult[]> {
  const results: SyncOpResult[] = [];
  for (const op of ops) {
    try {
      results.push(await applySyncOperation(env, userId, op));
    } catch (e) {
      results.push({ opId: op.opId, status: "rejected", error: e instanceof Error ? e.message : "处理失败" });
    }
  }
  return results;
}