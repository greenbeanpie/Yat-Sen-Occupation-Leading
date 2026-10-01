import { describe, expect, it, vi } from 'vitest';
import { getMf } from './helpers';
import { createApp } from '../src/app';
import { CareerSourceError } from '../src/infra/career-source';
import type { Env } from '../src/env';
import { classifySourceRedirect } from '../src/infra/career-source-redirect';
const fake=vi.hoisted(()=>({fetch:vi.fn(),list:vi.fn()}));
vi.mock('../src/infra/career-source',async importOriginal=>({...await importOriginal<typeof import('../src/infra/career-source')>(),fetchCareerHtml:fake.fetch,parseCareerList:fake.list}));
vi.mock('../src/middleware/auth',()=>({requireAuth:async(c:any,next:any)=>{c.set('user',{id:'fixture-admin',role:'admin',demo:false});await next();},requireAdmin:async(_c:any,next:any)=>next(),requireSuperAdmin:async(_c:any,next:any)=>next(),issueSessionCookie:vi.fn(),clearSessionCookie:vi.fn(),resolveUser:vi.fn()}));
async function setup(){const DB=await(await getMf()).mf.getD1Database('DB'),env={DB,AI_PROVIDER:'mock',CORS_ORIGIN:'http://yso.test'} as Env;fake.fetch.mockReset();fake.list.mockReset();const app=createApp();return {DB,refresh:()=>app.request('http://yso.test/api/v1/admin/career-source/refresh',{method:'POST',headers:{Origin:'http://yso.test','Content-Type':'application/json'},body:'{}'},env)};}
describe('source-stage diagnosis with synthetic HTML only',()=>{
 it('persists a safe redirect target with the request ID and stops parsing/model work',async()=>{
  const {DB,refresh}=await setup();const redirect=classifySourceRedirect('/campus/index/?ticket=fixture-secret#fixture-secret','https://career.sysu.edu.cn/campus/index');
  fake.fetch.mockRejectedValueOnce(new CareerSourceError('Source redirect rejected',302,redirect));
  const response=await refresh();const body=await response.json();expect(response.status).toBe(502);expect(body).toMatchObject({error:{code:'source_redirect',message:expect.stringContaining('https://career.sysu.edu.cn/campus/index/')}});
  const rows=await DB.prepare('SELECT event_json FROM ai_diagnostics ORDER BY seq').all<{event_json:string}>();const events=rows.results.map(row=>JSON.parse(row.event_json));
  expect(events.map(event=>event.stage)).toEqual(['source_fetch','source_response','source_end']);
  expect(events.slice(1).every(event=>event.requestId===response.headers.get('X-Request-Id')&&event.httpStatus===302&&event.sourceRedirect.kind==='same_origin_public')).toBe(true);
  expect(JSON.stringify([body,events])).not.toContain('fixture-secret');expect(fake.list).not.toHaveBeenCalled();expect(fake.fetch).toHaveBeenCalledOnce();
  expect((await refresh()).status).toBe(429);expect(fake.fetch).toHaveBeenCalledOnce();
 });
 it('reports remote 403 with matching request ID, stops one fetch, and persists only fixed diagnostic fields',async()=>{
  const {DB,refresh}=await setup();fake.fetch.mockRejectedValueOnce(new CareerSourceError('Source access restricted (403); stopped',403));
  const response=await refresh();expect(response.status).toBe(502);expect(await response.json()).toMatchObject({error:{code:'source_forbidden',message:expect.stringContaining('学校服务器拒绝访问')}});
  const rows=await DB.prepare('SELECT event_json FROM ai_diagnostics ORDER BY seq').all<{event_json:string}>();const events=rows.results.map(row=>JSON.parse(row.event_json));
  expect(events.map(event=>event.stage)).toEqual(['source_fetch','source_response','source_end']);expect(events.every(event=>event.requestId===response.headers.get('X-Request-Id'))).toBe(true);
  expect(events[1]).toMatchObject({code:'source_forbidden',httpStatus:403});expect(fake.fetch).toHaveBeenCalledOnce();expect(fake.list).not.toHaveBeenCalled();
  expect((await refresh()).status).toBe(429);expect(fake.fetch).toHaveBeenCalledOnce();
 });
 it('distinguishes successful HTTP fetch plus decode/parser/internal failures without raw HTML or exception leakage',async()=>{
  const {DB,refresh}=await setup();fake.fetch.mockResolvedValueOnce('<html>synthetic secret source text</html>');fake.list.mockRejectedValueOnce(new CareerSourceError('Unsupported source serialization'));
  const response=await refresh();expect(await response.json()).toMatchObject({error:{code:'source_decode_error'}});
  const rows=await DB.prepare('SELECT event_json FROM ai_diagnostics ORDER BY seq').all<{event_json:string}>();expect(rows.results.map(row=>JSON.parse(row.event_json).stage)).toEqual(['source_fetch','source_response','source_decode','source_end']);
  expect(JSON.stringify(rows.results)).not.toContain('synthetic secret source text');
 });
 it('retains a successful source result if diagnostic storage is absent',async()=>{
  const {DB,refresh}=await setup();await DB.prepare('DROP TABLE ai_diagnostics').run();fake.fetch.mockResolvedValueOnce('fixture-html');fake.list.mockResolvedValueOnce([{id:'1',title:'Fixture',url:'https://career.sysu.edu.cn/campus/view/id/1',publishedAt:'2026-10-01 12:00:00',pinned:false}]);
  expect((await refresh()).status).toBe(200);expect(fake.fetch).toHaveBeenCalledOnce();
 });
});
