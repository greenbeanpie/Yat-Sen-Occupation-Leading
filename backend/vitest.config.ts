import { defineConfig } from "vitest/config";

/**
 * Node 池通过 Miniflare 运行真实 workerd/D1/R2 集成测试。
 * 测试文件共享数据库重建流程，必须串行运行以避免跨文件重置冲突。
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/workers-runtime/**"],
    environment: "node",
    pool: "threads",
    fileParallelism: false,
  },
  resolve: {
    preserveSymlinks: true,
  },
});
