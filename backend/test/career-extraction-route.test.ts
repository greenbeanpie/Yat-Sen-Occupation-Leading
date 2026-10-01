import { describe, expect, it, vi } from 'vitest';
import { getMf } from './helpers';
import { createSnapshot } from '../src/prototypes/career-announcement';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
const fake=vi.hoisted(()=>({complete:vi.fn()}));
vi.mock('../src/infra/ai',()=>({getAiProvider:()=>({name:'test-real-provider',complete:fake.complete})}));
vi.mock('../src/middleware/auth',()=>({
 requireAuth:async(c:any,next:any)=>{c.set('user',{id:'test-admin',role:'admin',demo:false});await next();},
 requireAdmin:async(_c:any,next:any)=>next(),requireSuperAdmin:async(_c:any,next:any)=>next(),
 issueSessionCookie:vi.fn(),clearSessionCookie:vi.fn(),resolveUser:vi.fn(),
}));
const empty={schemaVersion:1,title:null,employer:null,applicationDeadline:null,sharedRequirements:[],positions:[],ambiguities:['Manual review required']};
async function setup(){
 const DB=await (await getMf()).mf.getD1Database('DB');
 const env={DB,AI_PROVIDER:'openai',AI_BASE_URL:'https://model.example/v1',AI_MODEL:'fake-test',AI_API_KEY:'test-only',CORS_ORIGIN:'http://yso.test'} as unknown as Env;
 const source=await createSnapshot({url:'https://career.sysu.edu.cn/campus/view/id/997448',numericId:'997448',retrievedAt:new Date().toISOString(),originalDate:null,sourceExpiry:null,captureMethod:'static-html-text',partial:true},'招聘公告\n工程师');
 const preview={schemaVersion:1,source,title:'招聘公告',employer:null,warnings:[],expiresAt:new Date(Date.now()+900000).toISOString()};
 await DB.prepare('INSERT INTO career_source_cache(cache_key,payload,expires_at) VALUES(?1,?2,?3)').bind('detail:997448',JSON.stringify(preview),Date.now()+900000).run();
 const app=createApp();fake.complete.mockReset().mockResolvedValue(JSON.stringify(empty));
 const extract=(hash=source.versionHash)=>app.request('http://yso.test/api/v1/admin/career-source/extract',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://yso.test'},body:JSON.stringify({id:'997448',sourceVersionHash:hash})},env);
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
  fake.complete.mockImplementationOnce(async()=>{await DB.prepare("UPDATE career_source_cache SET expires_at=0 WHERE cache_key='detail:997448'").run();return JSON.stringify(empty);});
  expect((await extract()).status).toBe(409);
  expect(await DB.prepare("SELECT count(*) AS n FROM career_source_cache WHERE cache_key LIKE 'draft:%'").first()).toEqual({n:0});
 });
 it('rejects invalid model evidence and never stores a candidate',async()=>{
  const {DB,extract}=await setup();fake.complete.mockResolvedValueOnce('{"schemaVersion":1}');
  const response=await extract();expect(response.status).toBe(502);expect(await response.json()).toMatchObject({error:{code:'career_extraction_failed'}});
  expect(await DB.prepare("SELECT count(*) AS n FROM career_source_cache WHERE cache_key LIKE 'draft:%'").first()).toEqual({n:0});
 });
});
