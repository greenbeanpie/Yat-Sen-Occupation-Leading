import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { getMf, loginAs, loginRealAdmin, request, STUDENT, ADMIN } from './helpers';
import { defaultSettings } from '../src/infra/ai/settings';
import { testSavedAiSettings } from '../src/infra/ai/probe';
import { writeAiDiagnostic, readAiDiagnostics, networkDiagnosticCode } from '../src/infra/ai/diagnostics';
import type { AiSettingsConfig } from '../src/shared/schemas/ai-settings';
const KEY='synthetic-provider-key-only';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
async function owner(){
 const cookie=await loginRealAdmin(),session=await(await request(cookie,'/session')).json<{user:{id:string}}>();
 const {mf}=await getMf(),DB=await mf.getD1Database('DB');
 await DB.prepare("UPDATE users SET access_role='super_admin' WHERE id=?1").bind(session.user.id).run();
 const env={DB,SESSION_SECRET:'test-secret-with-at-least-32-bytes-long',AI_PROVIDER:'mock',AI_BASE_URL:'',AI_MODEL:''} as Env;
 const send=(path:string,body:object,extra:Record<string,string>={})=>mf.dispatchFetch(`https://yso.test/api/v1${path}`,{method:'POST',headers:{Cookie:cookie,Origin:'https://yso.test','Content-Type':'application/json',...extra},body:JSON.stringify(body)}) as unknown as Promise<Response>;
 const save=(config:AiSettingsConfig,version=0)=>mf.dispatchFetch('https://yso.test/api/v1/admin/ai-settings',{method:'PUT',headers:{Cookie:cookie,Origin:'https://yso.test','Content-Type':'application/json'},body:JSON.stringify({baseVersion:version,config,apiKey:KEY})}) as unknown as Promise<Response>;
 return{cookie,id:session.user.id,DB,env,send,save};
}
function response(protocol:string){
 if(protocol==='responses')return{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'连接测试成功'}]}]};
 if(protocol==='messages')return{stop_reason:'end_turn',content:[{type:'text',text:'连接测试成功'}]};
 if(protocol==='generate-content')return{candidates:[{finishReason:'STOP',content:{parts:[{text:'连接测试成功'}]}}]};
 return{choices:[{finish_reason:'stop',message:{content:'连接测试成功',reasoning_content:'synthetic private thought'}}]};
}
describe('explicit saved AI probes',()=>{
 it('enforces role, CSRF, no-store, strict fixed input, and honestly skips mock mode',async()=>{
  for(const cookie of [undefined,await loginAs(STUDENT),await loginAs(ADMIN),await loginRealAdmin()]){
   for(const path of ['/admin/ai-settings/logs','/admin/ai-settings/test']){
    const r=await request(cookie,path,path.endsWith('/test')?{method:'POST',headers:{Origin:'http://yso.test','Content-Type':'application/json'},body:JSON.stringify({baseVersion:0,requestId:crypto.randomUUID()})}:{});
    expect([401,403]).toContain(r.status);expect(r.headers.get('Cache-Control')).toBe('no-store');
   }
  }
  const a=await owner(),input={baseVersion:0,requestId:crypto.randomUUID()};
  expect((await a.send('/admin/ai-settings/test',input,{Origin:'https://evil.test'})).status).toBe(403);
  expect((await a.send('/admin/ai-settings/test',input,{'Sec-Fetch-Site':'cross-site'})).status).toBe(403);
  expect((await a.send('/admin/ai-settings/test',{...input,prompt:'private data',apiKey:KEY})).status).toBe(422);
  const r=await a.send('/admin/ai-settings/test',input);expect(r.status).toBe(200);expect(await r.json()).toMatchObject({version:0,status:'not_run',provider:'mock',realRequestAttempted:false});
  const logs=await request(a.cookie,'/admin/ai-settings/logs');expect(logs.status).toBe(200);expect(logs.headers.get('Cache-Control')).toBe('no-store');expect(await logs.text()).not.toContain(KEY);
 });
 it.each([
  ['openai','gpt-5','responses'],['deepseek','deepseek-flash','chat-completions'],['anthropic','claude-opus-4-6','messages'],['gemini','gemini-2.5-flash','generate-content'],['opencode-go','glm-5.3','chat-completions'],
 ] as const)('uses saved %s %s %s once without saving or sending business data',async(providerPreset,model,protocol)=>{
  const a=await owner(),config={...defaultSettings(),mode:'real' as const,providerPreset,model,protocol};
  expect((await a.save(config)).status).toBe(200);
  const fetch=vi.fn(async()=>new Response(JSON.stringify(response(protocol))));vi.stubGlobal('fetch',fetch);
  const requestId=crypto.randomUUID(),result=await testSavedAiSettings(a.env,a.id,{baseVersion:1,requestId});
  expect(result).toMatchObject({version:1,status:'passed',realRequestAttempted:true,model,protocol,limits:{maxRequests:1,timeoutMs:60000,maxOutputTokens:4096,maxResponseBytes:8192}});
  expect(fetch).toHaveBeenCalledOnce();const [url,init]=fetch.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toMatch(/^https:\/\//);expect(JSON.stringify(init.body)).toContain('连接测试');expect(JSON.stringify(init.body)).not.toContain(a.id);expect(init.redirect).toBe('manual');
  if(providerPreset==='opencode-go')expect(new Headers(init.headers).get('x-opencode-session')).toBe(requestId);
  expect(await a.DB.prepare('SELECT version FROM ai_settings WHERE id=1').first()).toEqual({version:1});
  const diagnostics=await readAiDiagnostics(a.env,undefined,50);
  expect(diagnostics.items.map(i=>i.event.stage).reverse()).toEqual(['config_validated','dispatch','response','parse','end']);
  expect(JSON.stringify(diagnostics)).not.toContain(KEY);expect(JSON.stringify(diagnostics)).not.toContain('private thought');expect(JSON.stringify(diagnostics)).not.toContain('连接测试成功');
  await expect(testSavedAiSettings(a.env,a.id,{baseVersion:1,requestId})).rejects.toMatchObject({status:409,code:'ai_test_already_requested'});expect(fetch).toHaveBeenCalledOnce();
  expect((await a.save({...config,maxOutputTokens:2000},1)).status).toBe(200); // test never bumps CAS
 });
 it('blocks concurrent cross-request probes and stale versions before fetch',async()=>{
  const a=await owner(),config={...defaultSettings(),mode:'real' as const,providerPreset:'deepseek' as const,model:'deepseek-flash'};await a.save(config);
  let release!:(r:Response)=>void;const fetch=vi.fn(()=>new Promise<Response>(resolve=>{release=resolve;}));vi.stubGlobal('fetch',fetch);
  const first=testSavedAiSettings(a.env,a.id,{baseVersion:1,requestId:crypto.randomUUID()});await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce());
  await expect(testSavedAiSettings(a.env,a.id,{baseVersion:1,requestId:crypto.randomUUID()})).rejects.toMatchObject({status:429,code:'ai_test_in_progress'});
  await expect(testSavedAiSettings(a.env,a.id,{baseVersion:0,requestId:crypto.randomUUID()})).rejects.toMatchObject({status:409});
  release(new Response(JSON.stringify(response('chat-completions'))));expect((await first).status).toBe('passed');expect(fetch).toHaveBeenCalledOnce();
 });
 it('reports sanitized provider failure, preserves config, and releases the lease without automatic retry',async()=>{
  const a=await owner();await a.save({...defaultSettings(),mode:'real',providerPreset:'deepseek',model:'deepseek-flash'});
  const fetch=vi.fn(async()=>new Response(`provider echoed ${KEY}`,{status:403}));vi.stubGlobal('fetch',fetch);
  const result=await testSavedAiSettings(a.env,a.id,{baseVersion:1,requestId:crypto.randomUUID()});
  expect(result).toMatchObject({status:'failed',realRequestAttempted:true,error:{code:'provider_http_403'}});expect(JSON.stringify(result)).not.toContain(KEY);expect(fetch).toHaveBeenCalledOnce();
  expect(await a.DB.prepare('SELECT version FROM ai_settings').first()).toEqual({version:1});
  expect(JSON.stringify(await readAiDiagnostics(a.env,undefined,50))).not.toContain(KEY);
 });
 it('checks permission and version again at dispatch and isolates unavailable diagnostic storage',async()=>{
  const a=await owner();await a.save({...defaultSettings(),mode:'real',providerPreset:'deepseek',model:'deepseek-flash'});
  const fetch=vi.fn(async()=>new Response(JSON.stringify(response('chat-completions'))));vi.stubGlobal('fetch',fetch);
  const original=a.DB.batch.bind(a.DB);let demote=true;
  const wrapped={...a.env,DB:new Proxy(a.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof a.DB.batch>[0])=>{const r=await original(statements);if(demote){demote=false;await a.DB.prepare("UPDATE users SET access_role='admin' WHERE id=?1").bind(a.id).run();}return r;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}})} as Env;
  await expect(testSavedAiSettings(wrapped,a.id,{baseVersion:1,requestId:crypto.randomUUID()})).rejects.toMatchObject({status:403});expect(fetch).not.toHaveBeenCalled();
  await a.DB.prepare("UPDATE users SET access_role='super_admin' WHERE id=?1").bind(a.id).run();await a.DB.prepare('DROP TABLE ai_diagnostics').run();
  expect((await testSavedAiSettings(a.env,a.id,{baseVersion:1,requestId:crypto.randomUUID()})).status).toBe('passed');expect(fetch).toHaveBeenCalledOnce();
 });
});
describe('bounded diagnostic metadata',()=>{
 it('classifies safe network causes without retaining their secret-bearing raw diagnostics',()=>{
  expect(networkDiagnosticCode({cause:{code:'ENOTFOUND'},message:KEY,stack:KEY})).toBe('dns_error');
  expect(networkDiagnosticCode({code:'ERR_TLS_CERT_ALTNAME_INVALID',message:KEY})).toBe('tls_error');
  expect(networkDiagnosticCode({code:'ECONNRESET',message:KEY})).toBe('connection_reset');
  expect(networkDiagnosticCode(new Error(KEY))).toBe('network_error');
 });
 it('bounds a hung logging backend so it cannot hang a model operation',async()=>{
  vi.useFakeTimers();const statement={bind:()=>statement};const env={DB:{prepare:()=>statement,batch:()=>new Promise(()=>{})}} as unknown as Env;
  const result=writeAiDiagnostic(env,{requestId:crypto.randomUUID(),stage:'end',code:'ok'});await vi.advanceTimersByTimeAsync(1000);expect(await result).toBe(false);
 });
 it('whitelists fields and model IDs instead of storing secrets, prompts, URLs, or errors',async()=>{
  const a=await owner();await writeAiDiagnostic(a.env,{requestId:'https://bad.test?key='+KEY,stage:'end',code:'network_error',provider:'custom',model:KEY,prompt:'private prompt',response:'private answer',headers:{Authorization:KEY},error:new Error(KEY)} as never);
  const logs=await readAiDiagnostics(a.env,undefined,10);expect(logs.items).toHaveLength(1);const text=JSON.stringify(logs);for(const s of [KEY,'private prompt','private answer','bad.test','Authorization'])expect(text).not.toContain(s);
  expect(logs.items[0]!.event.model).toBe('(unlisted)');
 });
 async function seedRaw(a:Awaited<ReturnType<typeof owner>>,n:number,payload:string){
  const bytes=new TextEncoder().encode(payload).length;
  const statements=[];for(let i=0;i<n;i+=30){const count=Math.min(30,n-i),sql='INSERT INTO ai_diagnostics(created_at,event_json,bytes) VALUES '+Array(count).fill('(?,?,?)').join(',');statements.push(a.DB.prepare(sql).bind(...Array.from({length:count},()=>['fixture',payload,bytes]).flat()));}
  await a.DB.batch(statements);
 }
 it('trims latest rows atomically to both count and encoded UTF-8 bytes, including concurrent writes',async()=>{
  const a=await owner();await seedRaw(a,1005,JSON.stringify({fixture:true}));
  await writeAiDiagnostic(a.env,{requestId:crypto.randomUUID(),stage:'end',code:'ok'});let state=await readAiDiagnostics(a.env,undefined,100);expect(state.retainedCount).toBe(1000);expect(state.retainedBytes).toBeLessThanOrEqual(1000000);
  await a.DB.prepare('DELETE FROM ai_diagnostics').run();await seedRaw(a,650,JSON.stringify({fixture:'中'.repeat(600)}));
  await Promise.all(Array.from({length:24},()=>writeAiDiagnostic(a.env,{requestId:crypto.randomUUID(),stage:'end',code:'ok'})));
  state=await readAiDiagnostics(a.env,undefined,100);expect(state.retainedCount).toBeLessThanOrEqual(1000);expect(state.retainedBytes).toBeLessThanOrEqual(1000000);
  expect(await a.DB.prepare('SELECT COUNT(*) AS n FROM ai_diagnostics WHERE bytes!=length(CAST(event_json AS BLOB))').first()).toEqual({n:0});
 },30000);
});
