import { describe, expect, it } from "vitest";
import { allQuotesFound, verifyQuote } from "../src/domain/quotes";

describe("引用核验（伪造引用直接拒绝）", () => {
  const source = "负责后端接口开发，使用  TypeScript 与 Node.js。\n\n带领 3 人团队完成项目。";

  it("精确命中并返回位置", () => {
    const hit = verifyQuote(source, "TypeScript 与 Node.js");
    expect(hit.found).toBe(true);
    expect(source.slice(hit.start, hit.end)).toBe("TypeScript 与 Node.js");
  });

  it("空白差异归一化后命中", () => {
    const hit = verifyQuote(source, "负责后端接口开发，使用  TypeScript");
    expect(hit.found).toBe(true);
  });

  it("伪造引用不命中", () => {
    expect(verifyQuote(source, "使用 Rust 与 Go 完成").found).toBe(false);
    expect(verifyQuote(source, "带领 10 人团队").found).toBe(false);
  });

  it("空引用不命中", () => {
    expect(verifyQuote(source, "   ").found).toBe(false);
  });

  it("批量校验：任一伪造即整体失败", () => {
    expect(allQuotesFound(source, ["TypeScript 与 Node.js", "带领 3 人团队完成项目"])).toBe(true);
    expect(allQuotesFound(source, ["TypeScript 与 Node.js", "伪造引用"])).toBe(false);
  });
});
