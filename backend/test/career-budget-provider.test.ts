import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatProvider } from '../src/infra/ai';
import type { Env } from '../src/env';
import { modelUsage } from '../src/infra/ai/usage';
afterEach(()=>vi.unstubAllGlobals());
describe('operation-only temporary budget, synthetic HTTP responses',()=>{
 const env={AI_PROVIDER:'openai',AI_PROVIDER_PRESET:'opencode-go',AI_BASE_URL:'https://opencode.ai/zen/go/v1',AI_MODEL:'deepseek-v4.1-flash',AI_API_KEY:'fixture-only',AI_REASONING_EFFORT:'default',AI_MAX_OUTPUT_TOKENS:'4096',AI_TIMEOUT_MS:'60000',AI_MAX_ATTEMPTS:'3'} as Env;
 it('changes only approved request token/time caps and leaves subsequent ordinary requests at saved defaults',async()=>{
  const fetcher=vi.fn().mockImplementation(()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{}'}}],usage:{prompt_tokens:123,completion_tokens:456,completion_tokens_details:{reasoning_tokens:300},secret:'must-not-forward'}})));vi.stubGlobal('fetch',fetcher);
  const provider=new OpenAiCompatProvider(env),onUsage=vi.fn();
  await provider.complete([],{maxAttempts:1,careerDiagnosticBudget:{maxOutputTokens:16384,timeoutMs:120000},timeoutMs:120000,onUsage});
  await provider.complete([],{maxAttempts:1});
  const first=JSON.parse(fetcher.mock.calls[0]![1].body),ordinary=JSON.parse(fetcher.mock.calls[1]![1].body);
  expect(first).toMatchObject({model:'deepseek-v4.1-flash',max_tokens:16384});expect(ordinary.max_tokens).toBe(4096);
  expect(first).not.toHaveProperty('thinking');expect(first).not.toHaveProperty('reasoning_effort');expect(env.AI_MAX_OUTPUT_TOKENS).toBe('4096');
  expect(onUsage).toHaveBeenCalledExactlyOnceWith({inputTokens:123,outputTokens:456,reasoningTokens:300});
  expect(new Headers(fetcher.mock.calls[0]![1].headers).get('x-opencode-session')).toBeTruthy();expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('never retries length or accepts a larger-than-project cap',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'incomplete'}}],usage:{completion_tokens:16384}})));vi.stubGlobal('fetch',fetcher);
  const provider=new OpenAiCompatProvider(env),onUsage=vi.fn();
  await expect(provider.complete([],{maxAttempts:1,careerDiagnosticBudget:{maxOutputTokens:16384,timeoutMs:120000},onUsage})).rejects.toThrow('token 上限');
  expect(fetcher).toHaveBeenCalledOnce();expect(onUsage).toHaveBeenCalledExactlyOnceWith({inputTokens:null,outputTokens:16384,reasoningTokens:null});
  await expect(provider.complete([],{careerDiagnosticBudget:{maxOutputTokens:32769,timeoutMs:120000}})).rejects.toThrow();expect(fetcher).toHaveBeenCalledOnce();
 });
 it('extracts only bounded numeric usage across protocols and ignores malformed/secret values',()=>{
  expect(modelUsage({usage:{input_tokens:10,output_tokens:20,output_tokens_details:{reasoning_tokens:5}}},'responses')).toEqual({inputTokens:10,outputTokens:20,reasoningTokens:5});
  expect(modelUsage({usageMetadata:{promptTokenCount:10,candidatesTokenCount:20,thoughtsTokenCount:5}},'generate-content')).toEqual({inputTokens:10,outputTokens:20,reasoningTokens:5});
  expect(modelUsage({usage:{input_tokens:'key=secret',output_tokens:-1,reasoning_tokens:Infinity}},'messages')).toEqual({inputTokens:null,outputTokens:null,reasoningTokens:null});
 });
});
