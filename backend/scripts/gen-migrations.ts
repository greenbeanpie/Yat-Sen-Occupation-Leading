import { MIGRATION_0001 } from "../src/infra/db/schema";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "migrations", "0001_init.sql");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `-- 由 src/infra/db/schema.ts 生成（npm run gen:migrations），请勿手改\n${MIGRATION_0001}\n`);
console.log(`written: ${target}`);
