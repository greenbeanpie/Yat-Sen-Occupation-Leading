import { describe, expect, it, vi } from 'vitest';
import { getMf } from './helpers';
import { createSnapshot } from '../src/prototypes/career-announcement';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { AiError } from '../src/infra/ai/errors';
const fake=vi.hoisted(()=>({complete:vi.fn()}));
vi.mock('../src/infra/ai',()=>({getAiProvider:()=>({name:'test-real-provider',complete:fake.complete})}));
vi.mock('../src/middleware/auth',()=>({
 requireAuth:async(c:any,next:any)=>{c.set('user',{id:'test-admin',role:'admin',demo:false});await next();},
 requireAdmin:async(_c:any,next:any)=>next(),requireSuperAdmin:async(_c:any,next:any)=>next(),
 issueSessionCookie:vi.fn(),clearSessionCookie:vi.fn(),resolveUser:vi.fn(),
}));
const empty={schemaVersion:1,title:null,employer:null,applicationDeadline:null,sharedRequirements:[],positions:[],ambiguities:['Manual review required']};
async function setup(go=false){
 const DB=await (await getMf()).mf.getD1Database('DB');
 const env={DB,AI_PROVIDER:'openai',AI_BASE_URL:'https://model.example/v1',AI_MODEL:'fake-test',AI_API_KEY:'test-only',CORS_ORIGIN:'http://yso.test'} as unknown as Env;
 if(go){env.AI_PROVIDER_PRESET='opencode-go';env.AI_BASE_URL='https://opencode.ai/zen/go/v1';env.AI_MODEL='deepseek-v4.1-flash';}
 const source=await createSnapshot({url:'https://career.sysu.edu.cn/campus/view/id/997448',numericId:'997448',retrievedAt:new Date().toISOString(),originalDate:null,sourceExpiry:null,captureMethod:'static-html-text',partial:true},'招聘公告\n工程师');
 const preview={schemaVersion:1,source,title:'招聘公告',employer:null,warnings:[],expiresAt:new Date(Date.now()+900000).toISOString()};
 await DB.prepare('INSERT INTO career_source_cache(cache_key,payload,expires_at) VALUES(?1,?2,?3)').bind('detail:997448',JSON.stringify(preview),Date.now()+900000).run();
 const app=createApp();fake.complete.mockReset().mockResolvedValue(JSON.stringify({...empty,schemaVersion:2}));
 const extract=(hash=source.versionHash,diagnosticBudget?:object)=>app.request('http://yso.test/api/v1/admin/career-source/extract',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://yso.test'},body:JSON.stringify({id:'997448',sourceVersionHash:hash,...(diagnosticBudget?{diagnosticBudget}:{})})},env);
 return {DB,source,extract};
}
describe('configured extraction route with test-only fake provider',()=>{
 it('returns review-only data and reuses same-source candidate without a second call',async()=>{
  const {DB,extract}=await setup();
  const first=await extract();expect(first.status).toBe(200);expect(await first.json()).toMatchObject({status:'needs-human-review',candidate:empty});
  expect((await extract()).status).toBe(200);expect(fake.complete).toHaveBeenCalledTimes(1);
  expect(fake.complete.mock.calls[0]![1]).toMatchObject({maxAttempts:1,timeoutMs:30000,maxResponseBytes:150000,rejectRedirects:true});
  expect(await DB.prepare('SELECT count(*) AS n FROM jobs').first()).toEqual({n:0});
 });
 it('rejects a wrong version before model and an expired source after model',async()=>{
  const {DB,extract}=await setup();expect((await extract('a'.repeat(64))).status).toBe(409);expect(fake.complete).not.toHaveBeenCalled();
  fake.complete.mockImplementationOnce(async()=>{await DB.prepare("UPDATE career_source_cache SET expires_at=0 WHERE cache_key='detail:997448'").run();return JSON.stringify({...empty,schemaVersion:2});});
  expect((await extract()).status).toBe(409);
  expect(await DB.prepare("SELECT count(*) AS n FROM career_source_cache WHERE cache_key LIKE 'draft:%'").first()).toEqual({n:0});
 });
 it('rejects invalid model evidence and never stores a candidate',async()=>{
  const {DB,extract}=await setup();fake.complete.mockResolvedValueOnce('{"schemaVersion":1}');
  const response=await extract();expect(response.status).toBe(502);expect(await response.json()).toMatchObject({error:{code:'career_extraction_failed'}});
  expect(await DB.prepare("SELECT count(*) AS n FROM career_source_cache WHERE cache_key LIKE 'draft:%'").first()).toEqual({n:0});
 });
 it('reports the known output-limit failure without a retry or fake candidate',async()=>{
  const {DB,extract}=await setup();fake.complete.mockRejectedValueOnce(new AiError('模型未完整完成文本输出：达到 token 上限',false));
  const response=await extract();expect(response.status).toBe(502);expect(await response.json()).toMatchObject({error:{code:'career_output_limit',message:expect.stringContaining('不会自动重试或提高预算')}});
  expect(fake.complete).toHaveBeenCalledOnce();expect(await DB.prepare("SELECT count(*) AS n FROM career_source_cache WHERE cache_key LIKE 'draft:%'").first()).toEqual({n:0});
  expect(await DB.prepare('SELECT count(*) AS n FROM jobs').first()).toEqual({n:0});
 });
});
describe('explicit temporary career diagnostic budget, mock provider only',()=>{
 const budget={requestId:'00000000-0000-4000-8000-000000000003',baseVersion:0,maxOutputTokens:16384};
 async function setupTest(){const result=await setup(true);await result.DB.prepare("INSERT INTO users(id,role,access_role,display_name,is_demo,created_at,updated_at) VALUES('test-admin','admin','super_admin','Fixture',0,?1,?1)").bind(new Date().toISOString()).run();return result;}
 it('rejects ordinary admin and stale/oversized budget before model invocation',async()=>{
  const plain=await setup(true);expect((await plain.extract(plain.source.versionHash,budget)).status).toBe(403);expect(fake.complete).not.toHaveBeenCalled();
  await plain.DB.prepare("INSERT INTO users(id,role,access_role,display_name,is_demo,created_at,updated_at) VALUES('test-admin','admin','super_admin','Fixture',0,?1,?1)").bind(new Date().toISOString()).run();
  expect((await plain.extract(plain.source.versionHash,{...budget,baseVersion:1})).status).toBe(409);
  expect((await plain.extract(plain.source.versionHash,{...budget,maxOutputTokens:32769})).status).toBe(422);expect(fake.complete).not.toHaveBeenCalled();
 });
 it('uses one explicit 16k/120s request, records numeric usage and never changes saved version',async()=>{
  const {DB,source,extract}=await setupTest();fake.complete.mockImplementationOnce(async(_messages,options)=>{await options.beforeDispatch();options.onUsage({inputTokens:100,outputTokens:9000,reasoningTokens:7000});return JSON.stringify({...empty,schemaVersion:2});});
  const response=await extract(source.versionHash,budget);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({diagnostic:{requestId:budget.requestId,configurationVersion:0,maxOutputTokens:16384,timeoutMs:120000,usage:{inputTokens:100,outputTokens:9000,reasoningTokens:7000}}});
  expect(fake.complete).toHaveBeenCalledOnce();expect(fake.complete.mock.calls[0]![1]).toMatchObject({maxAttempts:1,careerDiagnosticBudget:{maxOutputTokens:16384,timeoutMs:120000}});
  expect(await DB.prepare('SELECT version,config_json FROM ai_settings WHERE id=1').first()).toEqual({version:0,config_json:null});
  await DB.prepare("UPDATE career_source_cache SET lease_until=0 WHERE cache_key='lease:model'").run();
  expect((await extract(source.versionHash,budget)).status).toBe(409);expect(fake.complete).toHaveBeenCalledOnce();
  expect(await DB.prepare('SELECT count(*) AS n FROM jobs').first()).toEqual({n:0});
 });
 it('keeps CAS/permission fences immediately before dispatch and rejects unsupported test models',async()=>{
  const {DB,source,extract}=await setupTest();fake.complete.mockImplementationOnce(async(_messages,options)=>{await DB.prepare('UPDATE ai_settings SET version=1 WHERE id=1').run();await options.beforeDispatch();throw Error('must not dispatch');});
  expect((await extract(source.versionHash,budget)).status).toBe(409);
  expect(await DB.prepare("SELECT count(*) AS n FROM career_source_cache WHERE cache_key LIKE 'draft:%'").first()).toEqual({n:0});
 });
});
