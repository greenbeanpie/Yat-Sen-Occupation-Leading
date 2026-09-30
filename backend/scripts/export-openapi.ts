import { createApp } from "../src/app";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 契约快照导出（backend_plan.md 六）：
 * 生成 openapi/openapi.json 提交进仓库，前端据此生成类型，跨分支协作的唯一契约通道。
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const app = createApp();
const { OPENAPI_CONFIG } = await import("../src/app");
// Export the route registry without executing runtime DB/rate-limit middleware.
const doc = app.getOpenAPIDocument(OPENAPI_CONFIG as never);
const target = join(root, "openapi", "openapi.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(doc, null, 2) + "\n");
const paths = Object.keys(doc.paths ?? {});
console.log(`written: ${target} (${paths.length} paths)`);
