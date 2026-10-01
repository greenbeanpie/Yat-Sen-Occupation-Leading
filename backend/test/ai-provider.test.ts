import { afterEach, describe, expect, it, vi } from "vitest";
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


describe('bounded extraction model calls',()=>{
 afterEach(()=>vi.unstubAllGlobals());
 const provider=()=>new OpenAiCompatProvider(makeEnv({AI_PROVIDER:'openai',AI_BASE_URL:'https://model.example/v1',AI_MODEL:'test-model'}));
 const options={maxAttempts:1,maxResponseBytes:100,rejectRedirects:true,timeoutMs:1000};
 it('does not follow redirects or retry a denied response',async()=>{
  const fake=vi.fn().mockResolvedValue(new Response('',{status:302,headers:{Location:'https://other.example'}}));vi.stubGlobal('fetch',fake);
  await expect(provider().complete([{role:'user',content:'data'}],options)).rejects.toThrow('HTTP 302');
  expect(fake).toHaveBeenCalledTimes(1);expect(fake.mock.calls[0]![1]).toMatchObject({redirect:'manual'});
 });
 it('cancels an oversized response and accepts a bounded completion',async()=>{
  const fake=vi.fn().mockResolvedValueOnce(new Response('x'.repeat(101))).mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:'{}'}}]})));vi.stubGlobal('fetch',fake);
  await expect(provider().complete([],options)).rejects.toThrow('模型响应过大');
  expect(await provider().complete([],options)).toBe('{}');expect(fake).toHaveBeenCalledTimes(2);
 });
});
