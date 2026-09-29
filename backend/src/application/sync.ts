import type { Env } from "../env";
import { SYNC_ENTITIES, type SyncEntity } from "../shared/constants";
import { nowIso, uuid } from "../shared/datetime";
import { getRow } from "../infra/db/helpers";
import {
  createEntity,
  deleteEntity,
  rowToJson,
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

  const persist = async (result: SyncOpResult): Promise<SyncOpResult> => persistResult(env, userId, op, result);
  if (!(SYNC_ENTITIES as readonly string[]).includes(op.entity)) return persist({ opId: op.opId, status: "rejected", error: "未知实体类型" });
  const entity = op.entity as SyncEntity;
  const registry = SYNC_REGISTRY[entity];

  // 2) 删除必须基于客户端见过的版本，避免旧设备删除新修改。
  if (op.action === "delete") {
    if (!op.entityId) return persist({ opId: op.opId, status: "rejected", error: "delete 操作需要 entityId" });
    if (op.baseVersion == null) return persist({ opId: op.opId, status: "rejected", error: "删除操作必须提供 baseVersion" });
    const row = await getRow(env.DB, registry.cfg.table, op.entityId, userId);
    if (!row) {
      return persist(op.baseVersion === 0
        ? { opId: op.opId, status: "applied", version: 0, record: { id: op.entityId, deleted: true } }
        : { opId: op.opId, status: "conflict", record: { id: op.entityId, deleted: true }, error: "实体不存在或已被删除" });
    }
    const serverVersion = Number(row.version);
    if (op.baseVersion !== serverVersion) {
      return persist({ opId: op.opId, status: "conflict", version: serverVersion, record: serializeRow(registry.cfg, row), error: "版本冲突" });
    }
    if (Number(row.deleted) === 1) {
      return persist({ opId: op.opId, status: "applied", version: serverVersion, record: serializeRow(registry.cfg, row) });
    }
    const success: SyncOpResult = {
      opId: op.opId,
      status: "applied",
      version: serverVersion + 1,
      record: { id: op.entityId, version: serverVersion + 1, deleted: true },
    };
    try {
      await deleteEntity(env, userId, registry.cfg, op.entityId, op.baseVersion, {
        returnOnConflict: true,
        completionStatements: (result) => [conditionalReceiptStmt(env, userId, op, { ...success, version: result.version, record: result.record }, registry.cfg)],
      });
      return await readReceipt(env, userId, op.opId);
    } catch (error) {
      const prior = await readReceiptOrNull(env, userId, op.opId);
      if (prior) return { ...prior, status: "duplicate" };
      throw error;
    }
  }

  // 3) upsert
  if (!op.entityId) {
    // 在线创建走各自路由；离线创建必须带客户端生成的 entityId
    return persist({ opId: op.opId, status: "rejected", error: "upsert 操作需要 entityId（离线新建由客户端生成 UUID）" });
  }

  const validation = validatePayload(entity, op.payload);
  if (!validation.ok) {
    return persist({ opId: op.opId, status: "rejected", details: validation.details, error: "参数校验失败" });
  }

  if (op.baseVersion == null) return persist({ opId: op.opId, status: "rejected", error: "更新操作必须提供 baseVersion" });
  const row = await getRow(env.DB, registry.cfg.table, op.entityId, userId);
  if (!row) {
    if (op.baseVersion === 0) {
      // 离线新建：客户端生成 UUID + baseVersion 0
      try {
        await createEntity(env, userId, registry.cfg, validation.data, undefined, op.entityId, {
          completionStatements: (result) => [receiptStmt(env, userId, op, { opId: op.opId, status: "applied", version: result.version, record: result.record })],
        });
        return await readReceipt(env, userId, op.opId);
      } catch (error) {
        const prior = await readReceiptOrNull(env, userId, op.opId);
        if (prior) return { ...prior, status: "duplicate" };
        const latest = await getRow(env.DB, registry.cfg.table, op.entityId, userId);
        if (latest) {
          return persist({ opId: op.opId, status: "conflict", version: Number(latest.version), record: serializeRow(registry.cfg, latest), error: "实体已存在" });
        }
        throw error;
      }
    }
    return persist({ opId: op.opId, status: "conflict", record: { id: op.entityId, deleted: true }, error: "实体不存在或已被删除" });
  }

  if (Number(row.deleted) === 1) {
    // 远端已删除：冲突处理，不得静默覆盖（PLAN.md 2.6）
    return persist({ opId: op.opId, status: "conflict", version: Number(row.version), record: serializeRow(registry.cfg, row), error: "实体已在远端删除" });
  }

  const serverVersion = Number(row.version);
  if (op.baseVersion !== serverVersion) {
    return persist({ opId: op.opId, status: "conflict", version: serverVersion, error: "版本冲突", record: serializeRow(registry.cfg, row) });
  }

  const success: SyncOpResult = { opId: op.opId, status: "applied", version: serverVersion + 1 };
  try {
    await updateEntity(env, userId, registry.cfg, op.entityId, op.baseVersion, validation.data, {
      returnOnConflict: true,
      completionStatements: (result) => [conditionalReceiptStmt(env, userId, op, { ...success, version: result.version, record: result.record }, registry.cfg)],
    });
    return await readReceipt(env, userId, op.opId);
  } catch (error) {
    const prior = await readReceiptOrNull(env, userId, op.opId);
    if (prior) return { ...prior, status: "duplicate" };
    throw error;
  }
}

async function persistResult(env: Env, userId: string, op: SyncOpInput, result: SyncOpResult): Promise<SyncOpResult> {
  try {
    await env.DB.batch([receiptStmt(env, userId, op, result)]);
    return result;
  } catch (error) {
    const prior = await readReceiptOrNull(env, userId, op.opId);
    if (prior) return { ...prior, status: "duplicate" };
    throw error;
  }
}

function receiptStmt(env: Env, userId: string, op: SyncOpInput, result: SyncOpResult): D1PreparedStatement {
  return env.DB
    .prepare(`INSERT INTO sync_operations (id, user_id, op_id, request_json, result_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(uuid(), userId, op.opId, JSON.stringify(op), JSON.stringify(result), nowIso());
}

/** Build a receipt whose result follows the CAS and is committed with that write. */
function conditionalReceiptStmt(
  env: Env,
  userId: string,
  op: SyncOpInput,
  success: SyncOpResult,
  cfg: EntityConfig,
): D1PreparedStatement {
  const recordExpr = sqlRecordObject(cfg);
  const currentRecord = `(SELECT ${recordExpr} FROM ${cfg.table} WHERE id = ?8 AND user_id = ?9 LIMIT 1)`;
  const conflictResult = `json_object(
    'opId', ?7,
    'status', 'conflict',
    'version', (SELECT version FROM ${cfg.table} WHERE id = ?8 AND user_id = ?9 LIMIT 1),
    'error', '版本冲突',
    'record', COALESCE(${currentRecord}, json_object('id', ?8, 'deleted', json('true')))
  )`;
  return env.DB
    .prepare(
      `INSERT INTO sync_operations (id, user_id, op_id, request_json, result_json, created_at)
       VALUES (?1, ?2, ?3, ?4, CASE WHEN changes() = 1 THEN ?5 ELSE ${conflictResult} END, ?6)`,
    )
    .bind(uuid(), userId, op.opId, JSON.stringify(op), JSON.stringify(success), nowIso(), op.opId, op.entityId, userId);
}

function sqlRecordObject(cfg: EntityConfig): string {
  const pairs = [
    "'id'", `${cfg.table}.id`,
    "'version'", `${cfg.table}.version`,
    "'deleted'", `(${cfg.table}.deleted = 1)`,
    "'createdAt'", `${cfg.table}.created_at`,
    "'updatedAt'", `${cfg.table}.updated_at`,
    "'userId'", `${cfg.table}.user_id`,
  ];
  for (const [field, spec] of Object.entries(cfg.fields)) {
    const column = spec.column ?? field.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    const expression = spec.json ? `json(COALESCE(${cfg.table}.${column}, '[]'))` : `${cfg.table}.${column}`;
    pairs.push(`'${field.replace(/'/g, "''")}'`, expression);
  }
  return `json_object(${pairs.join(", ")})`;
}

async function readReceipt(env: Env, userId: string, opId: string): Promise<SyncOpResult> {
  const receipt = await readReceiptOrNull(env, userId, opId);
  if (!receipt) throw new Error("同步操作回执未写入");
  return receipt;
}

async function readReceiptOrNull(env: Env, userId: string, opId: string): Promise<SyncOpResult | null> {
  const existing = await env.DB
    .prepare(`SELECT result_json FROM sync_operations WHERE user_id = ?1 AND op_id = ?2`)
    .bind(userId, opId)
    .first<{ result_json: string }>();
  return existing ? JSON.parse(existing.result_json) as SyncOpResult : null;
}

function serializeRow(cfg: EntityConfig, row: Record<string, unknown>): Record<string, unknown> {
  return rowToJson(cfg, row);
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
