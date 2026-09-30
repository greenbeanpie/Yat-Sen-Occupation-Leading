#!/usr/bin/env node
/**
 * 部署前只读预检：本地质量门禁 + OpenAPI 契约快照 + 两个 Worker 的 dry-run + Cloudflare 只读状态。
 *
 * 用法：
 *   node scripts/deploy-preflight.mjs            # 完整预检
 *   node scripts/deploy-preflight.mjs --quick    # 跳过测试、构建与契约再生成，只查配置、云端状态与 dry-run
 *   node scripts/deploy-preflight.mjs --strict   # 账号侧待办也判定为失败（正式发布前使用）
 *
 * 本脚本不会创建 Cloudflare 资源、不写入密钥、也不部署。
 * 资源创建见 `node scripts/bootstrap-cloudflare.mjs --apply`。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BACKEND = join(ROOT, "backend");
const FRONTEND = join(ROOT, "frontend");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

const argv = new Set(process.argv.slice(2));
const QUICK = argv.has("--quick");
const STRICT = argv.has("--strict");

const counts = { pass: 0, fail: 0, todo: 0, warn: 0 };
const labels = { pass: "PASS", fail: "FAIL", todo: "TODO", warn: "WARN" };

function mark(kind, message) {
  counts[kind] += 1;
  console.log(`  [${labels[kind]}] ${message}`);
}

function run(command, args, { cwd = ROOT } = {}) {
  // Windows 上 npm/npx 是 .cmd 批处理；Node 20.12+ 出于 CVE-2024-27980
  // 默认拒绝 spawnSync 直接执行 .cmd，必须经 shell 解析。
  const winPackager = process.platform === "win32" && /^(npm|npx|pnpm|yarn)(\.cmd|\.bat)?$/i.test(command);
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, shell: winPackager || undefined });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) return { code: 127, output: `${output}\n${result.error.message}`.trim() };
  return { code: result.status ?? 1, output };
}

function tail(text, lines = 15) {
  const parts = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return parts.slice(-lines).join("\n");
}

function gate(title, command, args, cwd) {
  process.stdout.write(`\n> ${title}\n`);
  const result = run(command, args, { cwd });
  if (result.code === 0) {
    mark("pass", title);
  } else {
    mark("fail", `${title}（退出码 ${result.code}）`);
    if (result.output) console.log(tail(result.output));
  }
  return result;
}

function readJsonc(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, ""));
}

/**
 * 快照一致性：命令重新生成文件后与生成前逐字节比较，不等即判定漂移并恢复原文件。
 * 在共享工作区里只做校验，不改动他人正在编辑的生成物；CI 的干净检出同样适用。
 */
function contractCheck(title, target, command, args, cwd) {
  process.stdout.write(`\n> ${title}\n`);
  const before = readFileSync(target, "utf8");
  const result = run(command, args, { cwd });
  if (result.code !== 0) {
    mark("fail", `${title}：再生成命令失败（退出码 ${result.code}）`);
    if (result.output) console.log(tail(result.output));
    writeFileSync(target, before);
    return;
  }
  const after = readFileSync(target, "utf8");
  // Windows 检出为 CRLF、生成器写出 LF，按内容（归一化换行）比较。
  const normalize = (text) => text.replace(/\r\n/g, "\n");
  if (normalize(after) === normalize(before)) {
    mark("pass", `${title}：与当前代码一致`);
    writeFileSync(target, before);
    return;
  }
  writeFileSync(target, before);
  mark("fail", `${title}：快照落后于当前代码（已恢复原文件，请执行重新生成并提交后再部署）`);
}

console.log("部署前预检（yso 实习工作台）");
console.log(`仓库：${ROOT}`);

const major = Number(process.versions.node.split(".")[0]);
if (major >= 20) mark("pass", `Node ${process.version}`);
else mark("fail", `Node ${process.version} 过低，需要 >= 20`);

const backendConfig = readJsonc(join(BACKEND, "wrangler.jsonc"));
const frontendConfig = readJsonc(join(FRONTEND, "wrangler.jsonc"));
const d1Name = backendConfig.d1_databases?.[0]?.database_name;
const databaseId = String(backendConfig.d1_databases?.[0]?.database_id ?? "");
const bucketName = backendConfig.r2_buckets?.[0]?.bucket_name;
const backendWorker = backendConfig.name;
const frontendWorker = frontendConfig.name;
const serviceBinding = frontendConfig.services?.[0]?.service;
const placeholder = !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId);

if (serviceBinding === backendWorker) {
  mark("pass", `前端 Service Binding：${serviceBinding}`);
} else {
  mark("fail", `前端 Service Binding 指向 ${serviceBinding}，与后端 Worker 名 ${backendWorker} 不一致`);
}

if (QUICK) {
  process.stdout.write("\n> 本地质量门禁\n");
  mark("warn", "--quick：已跳过类型检查、Lint、测试、构建与契约快照比对");
} else {
  gate("后端类型检查", NPM, ["run", "typecheck"], BACKEND);
  gate("后端测试", NPM, ["test"], BACKEND);
  gate("前端类型检查", NPM, ["run", "typecheck"], FRONTEND);
  gate("前端 Lint", NPM, ["run", "lint"], FRONTEND);
  gate("前端测试", NPM, ["test"], FRONTEND);
  gate("前端生产构建", NPM, ["run", "build"], FRONTEND);

  contractCheck(
    "OpenAPI 快照与当前代码一致",
    join(BACKEND, "openapi", "openapi.json"),
    NPM,
    ["run", "export:openapi"],
    BACKEND,
  );
  contractCheck(
    "前端生成类型与快照一致",
    join(FRONTEND, "src", "api", "schema.ts"),
    NPM,
    ["run", "generate:api"],
    FRONTEND,
  );
}

gate("后端 wrangler deploy --dry-run", NPX, ["wrangler", "deploy", "--dry-run"], BACKEND);
gate("前端 wrangler deploy --dry-run", NPX, ["wrangler", "deploy", "--dry-run"], FRONTEND);

process.stdout.write("\n> Cloudflare 只读状态\n");
const whoami = run(NPX, ["wrangler", "whoami"], { cwd: BACKEND });
const email = whoami.output.match(/associated with the email\s+([\w.+-]+@[\w.-]+\.\w+)/i)?.[1];
const accountId = whoami.output.match(/\b([0-9a-f]{32})\b/i)?.[1];
let authenticated = whoami.code === 0 && Boolean(email);

if (authenticated) {
  mark("pass", `Cloudflare 已登录：${email}${accountId ? `（account ${accountId}）` : ""}`);
} else {
  mark("todo", "Cloudflare 未登录：cd backend && npx wrangler login");
}

if (authenticated) {
  const d1List = run(NPX, ["wrangler", "d1", "list", "--json"], { cwd: BACKEND });
  let databases = [];
  if (d1List.code === 0) {
    const start = d1List.output.indexOf("[");
    // wrangler 的 npm notice 可能出现在 JSON 之后（stdout/stderr 合并），因此截到最后一个 ']'。
    const end = d1List.output.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        databases = JSON.parse(d1List.output.slice(start, end + 1));
      } catch {
        databases = [];
      }
    }
  }

  const byName = databases.find((item) => item.name === d1Name);
  if (!byName) {
    mark("todo", `D1 数据库 ${d1Name} 不存在：node scripts/bootstrap-cloudflare.mjs --apply`);
  } else if (placeholder) {
    mark("todo", `D1 ${d1Name} 已存在（${byName.uuid}），但 wrangler.jsonc 的 database_id 仍是占位符`);
  } else if (databaseId === byName.uuid) {
    mark("pass", `D1 绑定就绪：${d1Name} -> ${byName.uuid}`);
  } else {
    const configured = databases.find((item) => item.uuid === databaseId);
    if (configured) mark("warn", `D1 database_id 指向 ${configured.name}，与配置中的 ${d1Name} 不同名，请确认`);
    else mark("warn", `D1 database_id ${databaseId} 不在当前账号列表中，请确认账号或 id`);
  }

  const r2List = run(NPX, ["wrangler", "r2", "bucket", "list"], { cwd: BACKEND });
  const buckets = [...r2List.output.matchAll(/^name:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  if (buckets.includes(bucketName)) mark("pass", `R2 私有桶就绪：${bucketName}`);
  else mark("todo", `R2 桶 ${bucketName} 不存在：node scripts/bootstrap-cloudflare.mjs --apply`);

  if (STRICT) {
    // npm/npx .cmd runs through cmd.exe on Windows; keep the fixed SQL as one argument.
    const sql = "SELECT name FROM d1_migrations ORDER BY id";
    const migrationState = run(NPX, ["wrangler", "d1", "execute", "DB", "--remote", "--command", process.platform === "win32" ? `"${sql}"` : sql, "--json"], { cwd: BACKEND });
    let applied = [];
    try {
      const start = migrationState.output.indexOf("["); const end = migrationState.output.lastIndexOf("]");
      applied = JSON.parse(migrationState.output.slice(start, end + 1)).flatMap((entry) => (entry.results ?? []).map((row) => row.name));
    } catch { /* A failed read cannot establish migration readiness. */ }
    const expected = readdirSync(join(BACKEND, "migrations")).filter((file) => file.endsWith(".sql"));
    const pending = expected.filter((file) => !applied.includes(file));
    if (migrationState.code !== 0 || pending.length) mark("fail", `远端迁移未就绪或无法读取：${pending.join(", ") || "读取失败"}`);
    else mark("pass", "远端已应用全部仓库迁移（只读核验）");
  }
}

console.log("\n────────────────────────");
console.log(`通过 ${counts.pass} / 失败 ${counts.fail} / 待办 ${counts.todo} / 提示 ${counts.warn}`);

if (counts.todo > 0 || counts.fail > 0) {
  console.log("\n下一步：");
  console.log("  1. node scripts/bootstrap-cloudflare.mjs --apply     # 创建 D1/R2 并回填 database_id");
  console.log("  2. cd backend && npm run db:migrate:remote           # 应用远端迁移");
  console.log("  3. cd backend && npx wrangler secret put SESSION_SECRET");
  console.log("  4. cd backend && npm run deploy && cd ../frontend && npm run deploy");
  console.log("  5. node backend/scripts/smoke-deploy.mjs <后端地址>   # 部署后冒烟");
  console.log("  详见 backend/docs/deployment.md");
}

const failed = counts.fail > 0 || (STRICT && counts.todo > 0);
console.log(failed ? "\n预检未通过。" : "\n预检通过（账号侧待办不影响本地结论）。");
process.exit(failed ? 1 : 0);
