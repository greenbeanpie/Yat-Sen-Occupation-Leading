import { defineConfig } from "vitest/config";

/**
 * 本地默认测试配置：纯 Node 池，覆盖领域规则、协议与（通过注入桩的）应用逻辑。
 * Workers 运行时行为由 `npm run dev` + `npm run test:smoke` 在真实 workerd 中验证。
 *
 * vitest-pool-workers（vitest.workers.config.ts，`npm run test:workers`）在本机不可用：
 * Windows + 非 ASCII 工作区路径会报 "No such module cloudflare:test-internal"
 * （https://github.com/cloudflare/workers-sdk/issues/14655）。ASCII 路径/CI 环境可正常使用。
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/workers-runtime/**"],
    environment: "node",
    pool: "threads",
  },
  resolve: {
    preserveSymlinks: true,
  },
});
