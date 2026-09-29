import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { startOperation } from "../src/application/operations";
import { getMf, STUDENT } from "./helpers";

describe("异步作业派发", () => {
  it("Workflow 派发失败后将作业标记为 failed", async () => {
    const { mf } = await getMf();
    const DB = await mf.getD1Database("DB");
    const env = {
      DB,
      GENERATE_MATCH: {
        create: async () => {
          throw new Error("queue unavailable");
        },
      },
    } as unknown as Env;

    const operationId = await startOperation(env, STUDENT, "generate_match", { jobId: "job-1" }, []);
    const operation = await DB
      .prepare(`SELECT status, error FROM async_operations WHERE id = ?1`)
      .bind(operationId)
      .first<{ status: string; error: string }>();

    expect(operation).toMatchObject({ status: "failed", error: "queue unavailable" });
  });
});
