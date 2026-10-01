import { describe, expect, it } from 'vitest';
import { getMf, loginRealAdmin, loginAs, request, STUDENT, ADMIN } from './helpers';
import { createSnapshot } from '../src/prototypes/career-announcement';
const headers={'Content-Type':'application/json',Origin:'http://yso.test'};
const post=(cookie:string|undefined,path:string,body:object,custom=headers)=>request(cookie,`/admin/career-source/${path}`,{method:'POST',headers:custom,body:JSON.stringify(body)});
describe('review-only career source API',()=>{
 it('requires real administrators for every endpoint and leaves no source data',async()=>{
  for(const cookie of [undefined,await loginAs(STUDENT),await loginAs(ADMIN)]){
   const expected=cookie?403:401;
   expect((await request(cookie,'/admin/career-source')).status).toBe(expected);
   for(const [path,body] of [['refresh',{}],['preview',{id:'997448'}],['extract',{id:'997448',sourceVersionHash:'a'.repeat(64)}]] as const)expect((await post(cookie,path,body)).status).toBe(expected);
  }
  const db=await (await getMf()).mf.getD1Database('DB');
  expect(await db.prepare('SELECT count(*) AS n FROM career_source_cache').first()).toEqual({n:0});
 });
 it('serves empty cache and honest model availability without fetching',async()=>{
  const cookie=await loginRealAdmin();const res=await request(cookie,'/admin/career-source');
  expect(res.status).toBe(200);expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(await res.json()).toMatchObject({cachedList:null,extractionAvailable:false,extractionUnavailableReason:'real_model_unconfigured',publicationSupported:false});
  const extraction=await post(cookie,'extract',{id:'997448',sourceVersionHash:'a'.repeat(64)});
  expect(extraction.status).toBe(503);expect(await extraction.json()).toMatchObject({error:{code:'real_model_unconfigured'}});
 });
 it('rejects CSRF, unexpected inputs, URLs and oversized operation bodies',async()=>{
  const cookie=await loginRealAdmin();
  expect((await post(cookie,'preview',{id:'997448'},{...headers,Origin:'https://evil.test'})).status).toBe(403);
  expect((await post(cookie,'preview',{id:'997448'},{'Content-Type':'application/json'} as typeof headers)).status).toBe(403);
  for(const body of [{id:'https://evil.test'}, {id:'997448',url:'https://evil.test'}, {id:'1'.repeat(13)}])expect((await post(cookie,'preview',body)).status).toBe(422);
  expect((await post(cookie,'preview',{id:'1'.repeat(3000)})).status).toBe(413);
 });
 it('reuses cached source and never creates jobs or operations',async()=>{
  const cookie=await loginRealAdmin(), db=await (await getMf()).mf.getD1Database('DB');
  const source=await createSnapshot({url:'https://career.sysu.edu.cn/campus/view/id/997448',numericId:'997448',retrievedAt:new Date().toISOString(),originalDate:null,sourceExpiry:null,captureMethod:'static-html-text',partial:true},'招聘公告\n工程师');
  const preview={schemaVersion:1,source,title:'招聘公告',employer:null,warnings:['Needs review'],expiresAt:new Date(Date.now()+900000).toISOString()};
  await db.prepare('INSERT INTO career_source_cache(cache_key,payload,expires_at) VALUES(?1,?2,?3)').bind('detail:997448',JSON.stringify(preview),Date.now()+900000).run();
  expect(await (await post(cookie,'preview',{id:'997448'})).json()).toEqual(preview);
  expect(await db.prepare('SELECT count(*) AS n FROM jobs').first()).toEqual({n:0});
  expect(await db.prepare('SELECT count(*) AS n FROM async_operations').first()).toEqual({n:0});
 });
 it('global source lease denies concurrent refreshes without network requests',async()=>{
  const cookie=await loginRealAdmin(),db=await (await getMf()).mf.getD1Database('DB');
  await db.prepare('INSERT INTO career_source_cache(cache_key,lease_until,lease_token) VALUES(?1,?2,?3)').bind('lease:source',Date.now()+60000,'held').run();
  expect((await post(cookie,'refresh',{})).status).toBe(429);
  expect((await post(cookie,'preview',{id:'997448'})).status).toBe(429);
 });
});
