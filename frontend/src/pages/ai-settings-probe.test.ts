import { describe, expect, it, vi } from 'vitest';
import { createAiProbeRunner, type AiProbeReport, type AiProbeRequest } from './ai-settings-probe';
const result:AiProbeReport={requestId:'00000000-0000-4000-8000-000000000000',version:3,status:'passed',realRequestAttempted:true,provider:'deepseek',model:'deepseek-flash',protocol:'chat-completions',limits:{maxRequests:1,timeoutMs:60000,maxOutputTokens:4096,maxResponseBytes:8192},checks:[],error:null};
describe('explicit probe click controller',()=>{
 it('has no automatic call and collapses rapid repeated clicks to one saved-version request',async()=>{
  let resolve!:(r:AiProbeReport)=>void;const send=vi.fn<(body:AiProbeRequest)=>Promise<AiProbeReport>>(()=>new Promise<AiProbeReport>(r=>{resolve=r;})),runner=createAiProbeRunner(send);
  expect(send).not.toHaveBeenCalled();const a=runner.run(3),b=runner.run(3);expect(a).toBe(b);expect(runner.pending).toBe(true);await vi.waitFor(()=>expect(send).toHaveBeenCalledOnce());
  expect(Object.keys(send.mock.calls[0]![0])).toEqual(['baseVersion','requestId']);expect(send.mock.calls[0]![0]).toMatchObject({baseVersion:3,requestId:expect.any(String)});
  resolve(result);expect(await a).toBe(result);await Promise.resolve();expect(runner.pending).toBe(false);
 });
 it('keeps save state independent after failed testing, never retries, and uses the next saved version',async()=>{
  const send=vi.fn().mockRejectedValueOnce(new Error('本次测试超时不代表配置无效')).mockResolvedValue(result),runner=createAiProbeRunner(send);
  await expect(runner.run(3)).rejects.toThrow('不代表配置无效');expect(send).toHaveBeenCalledOnce();expect(runner.pending).toBe(false);
  await runner.run(4);expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[1]![0].baseVersion).toBe(4);expect(send.mock.calls[1]![0].requestId).not.toBe(send.mock.calls[0]![0].requestId);
 });
});
