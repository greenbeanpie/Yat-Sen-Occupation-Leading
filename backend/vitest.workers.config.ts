import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * vitest-pool-workers 配置（真实 workerd 运行时集成测试）。
 * 注意：Windows + 非 ASCII 工作区路径下会触发已知 bug
 * （https://github.com/cloudflare/workers-sdk/issues/14655），
 * 报 "No such module cloudflare:test-internal"。ASCII 路径或 CI 上运行：
 *   npm run test:workers
 */
export default defineWorkersConfig({
  test: {
    include: ["test/workers-runtime/**/*.test.ts"],
    pool: "@cloudflare/vitest-pool-workers",
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: "2025-10-11",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          r2Buckets: ["DOCS"],
        },
      },
    },
  },
});
