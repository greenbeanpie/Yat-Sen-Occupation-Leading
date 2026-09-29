import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { AiError, getAiProvider, MockProvider, OpenAiCompatProvider } from "../src/infra/ai";

function makeEnv(overrides: Partial<Pick<Env, "AI_PROVIDER" | "AI_BASE_URL" | "AI_MODEL" | "AI_API_KEY">> = {}): Env {
  return {
    AI_PROVIDER: "mock",
    AI_BASE_URL: "",
    AI_MODEL: "",
    ...overrides,
  } as Env;
}

describe("getAiProvider", () => {
  it("keeps the explicit mock provider available for the demo deployment", () => {
    expect(getAiProvider(makeEnv())).toBeInstanceOf(MockProvider);
  });

  it("requires a URL when the OpenAI-compatible provider is selected", () => {
    expect(() => getAiProvider(makeEnv({ AI_PROVIDER: "openai" }))).toThrow(
      "AI_PROVIDER=openai 时必须配置 AI_BASE_URL",
    );
    expect(() => getAiProvider(makeEnv({ AI_PROVIDER: "openai", AI_BASE_URL: "   " }))).toThrow(
      "AI_PROVIDER=openai 时必须配置 AI_BASE_URL",
    );
  });

  it("creates the OpenAI-compatible provider when configured", () => {
    expect(
      getAiProvider(
        makeEnv({ AI_PROVIDER: "openai", AI_BASE_URL: "https://model.example/v1", AI_MODEL: "test-model" }),
      ),
    ).toBeInstanceOf(OpenAiCompatProvider);
  });

  it("rejects an unknown provider instead of silently returning mock results", () => {
    expect(() => getAiProvider(makeEnv({ AI_PROVIDER: "custom" }))).toThrow("不支持的 AI_PROVIDER：custom");
  });
});
