#!/usr/bin/env node
/**
 * 首次部署的 Cloudflare 资源准备：创建 D1 与 R2，并把真实 database_id 回填到
 * backend/wrangler.jsonc。默认只打印计划；加 --apply 才会真正创建资源。
 *
 * 用法：
 *   node scripts/bootstrap-cloudflare.mjs           # 计划模式（只读）
 *   node scripts/bootstrap-cloudflare.mjs --apply   # 创建资源并回填 database_id
 *
 * 幂等：资源已存在时跳过创建，只校正 database_id。不会写入任何密钥。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BACKEND = join(ROOT, "backend");
const WRANGLER_CONFIG = join(BACKEND, "wrangler.jsonc");
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const APPLY = process.argv.includes("--apply");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function run(args, { inherit = false } = {}) {
  const result = spawnSync(NPX, ["wrangler", ...args], {
    cwd: BACKEND,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (inherit) return { code: result.status ?? 1, output: "" };
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function step(kind, message) {
  console.log(`  [${kind}] ${message}`);
}

function wranglerJson(args, openChar) {
  const result = run(args);
  if (result.code !== 0) return { error: result.output.trim() };
  const start = result.output.indexOf(openChar);
  if (start < 0) return { error: `无法解析 wrangler 输出：${result.output.trim().slice(0, 200)}` };
  try {
    return { value: JSON.parse(result.output.slice(start)) };
  } catch (error) {
    return { error: `无法解析 wrangler 输出：${error.message}` };
  }
}

function listDatabases() {
  const result = wranglerJson(["d1", "list", "--json"], "[");
  return Array.isArray(result.value) ? result.value : [];
}

function listBuckets() {
  const result = run(["r2", "bucket", "list"]);
  if (result.code !== 0) return [];
  return [...result.output.matchAll(/^name:\s*(\S+)\s*$/gm)].map((match) => match[1]);
}

function readConfig() {
  const raw = readFileSync(WRANGLER_CONFIG, "utf8");
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  const d1 = config.d1_databases?.[0] ?? {};
  const r2 = config.r2_buckets?.[0] ?? {};
  return { raw, config, d1Name: d1.database_name, databaseId: String(d1.database_id ?? ""), bucketName: r2.bucket_name };
}

function patchDatabaseId(currentRaw, nextId) {
  const nextRaw = currentRaw.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${nextId}$2`);
  if (nextRaw === currentRaw) throw new Error("未在 backend/wrangler.jsonc 找到 database_id 字段");
  writeFileSync(WRANGLER_CONFIG, nextRaw);
}

console.log(APPLY ? "Cloudflare 资源准备（apply）" : "Cloudflare 资源准备（计划模式，不创建任何资源）");

const whoami = run(["whoami"]);
const email = whoami.output.match(/associated with the email\s+([\w.+-]+@[\w.-]+\.\w+)/i)?.[1];
const accountId = whoami.output.match(/\b([0-9a-f]{32})\b/i)?.[1];
if (whoami.code !== 0 || !email) {
  console.error("未登录 Cloudflare。请先执行：cd backend && npx wrangler login");
  process.exit(1);
}
console.log(`账号：${email}${accountId ? `（${accountId}）` : ""}`);

const { raw, d1Name, databaseId, bucketName } = readConfig();
if (!d1Name || !bucketName) {
  console.error("backend/wrangler.jsonc 缺少 D1 或 R2 绑定名称。");
  process.exit(1);
}

console.log("\nD1：");
let databases = listDatabases();
let database = databases.find((item) => item.name === d1Name);
if (database) {
  step("SKIP", `数据库 ${d1Name} 已存在（${database.uuid}）`);
} else if (!APPLY) {
  step("PLAN", `将创建数据库 ${d1Name}：npx wrangler d1 create ${d1Name}`);
} else {
  step("RUN", `创建数据库 ${d1Name} ...`);
  const created = run(["d1", "create", d1Name], { inherit: true });
  if (created.code !== 0) {
    console.error("D1 创建失败，请查看上方 wrangler 输出。");
    process.exit(1);
  }
  databases = listDatabases();
  database = databases.find((item) => item.name === d1Name);
  if (!database) {
    console.error(`创建后仍未在账号中找到 ${d1Name}，请手动执行 npx wrangler d1 list --json 核对。`);
    process.exit(1);
  }
  step("DONE", `数据库 ${d1Name} -> ${database.uuid}`);
}

if (database) {
  if (databaseId === database.uuid) {
    step("SKIP", "wrangler.jsonc 的 database_id 已指向该数据库");
  } else if (!APPLY) {
    step("PLAN", `将把 backend/wrangler.jsonc 的 database_id 由 ${databaseId || "(空)"} 改为 ${database.uuid}`);
  } else {
    patchDatabaseId(raw, database.uuid);
    step("DONE", `已回填 database_id = ${database.uuid}`);
  }
} else if (UUID_RE.test(databaseId)) {
  step("WARN", `wrangler.jsonc 已配置 database_id ${databaseId}，但账号中没有名为 ${d1Name} 的数据库`);
}

console.log("\nR2：");
const buckets = listBuckets();
if (buckets.includes(bucketName)) {
  step("SKIP", `私有桶 ${bucketName} 已存在`);
} else if (!APPLY) {
  step("PLAN", `将创建私有桶 ${bucketName}：npx wrangler r2 bucket create ${bucketName}`);
} else {
  step("RUN", `创建私有桶 ${bucketName} ...`);
  const created = run(["r2", "bucket", "create", bucketName], { inherit: true });
  if (created.code !== 0) {
    console.error("R2 创建失败，请查看上方 wrangler 输出。");
    process.exit(1);
  }
  step("DONE", `私有桶 ${bucketName} 已创建`);
}

if (!APPLY) {
  console.log("\n计划模式结束。执行以下命令应用：");
  console.log("  node scripts/bootstrap-cloudflare.mjs --apply");
} else {
  console.log("\n资源已就绪。下一步：");
}
console.log("\n  1. cd backend && npm run db:migrate:remote");
console.log("  2. cd backend && npx wrangler secret put SESSION_SECRET        # 值用 openssl rand -hex 32 生成");
console.log("  3. cd backend && npm run generate:vapid                      # 公钥填 vars，私钥 secret put VAPID_PRIVATE_KEY");
console.log("  4. cd backend && npm run deploy");
console.log("  5. cd frontend && npm run deploy                             # 先构建，再部署静态资源 Worker");
console.log("  6. node backend/scripts/smoke-deploy.mjs <后端地址>            # 部署后冒烟");
console.log("  详见 backend/docs/deployment.md");
