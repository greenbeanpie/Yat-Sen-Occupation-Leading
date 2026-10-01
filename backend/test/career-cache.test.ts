import { describe, expect, it } from 'vitest';
import { getMf } from './helpers';
import { withCareerLease, readCareerCache, writeCareerCache } from '../src/infra/career-cache';
import type { Env } from '../src/env';
async function env(){return {DB:await (await getMf()).mf.getD1Database('DB')} as unknown as Env;}
describe('globally fenced career cache',()=>{
 it('serializes requests across callers and enforces completion spacing',async()=>{
  const e=await env();let release!:()=>void;
  const running=withCareerLease(e,'source',()=>new Promise<void>(resolve=>{release=resolve;}));
  while(!release)await new Promise(r=>setTimeout(r,1));
  await expect(withCareerLease(e,'source',async()=>null)).rejects.toMatchObject({code:'career_busy'});
  release();await running;
  await expect(withCareerLease(e,'source',async()=>null)).rejects.toMatchObject({code:'career_busy'});
  const row=await e.DB.prepare('SELECT lease_until,lease_token FROM career_source_cache WHERE cache_key=?1').bind('lease:source').first<{lease_until:number,lease_token:null}>();
  expect(row!.lease_until).toBeGreaterThan(Date.now()+900);expect(row!.lease_token).toBeNull();
 });
 it('cools down after a source failure and fences an obsolete owner',async()=>{
  const e=await env();await expect(withCareerLease(e,'source',async()=>{throw new Error('blocked');})).rejects.toThrow('blocked');
  const row=await e.DB.prepare('SELECT lease_until FROM career_source_cache WHERE cache_key=?1').bind('lease:source').first<{lease_until:number}>();
  expect(row!.lease_until).toBeGreaterThan(Date.now()+890000);
  await e.DB.prepare('DELETE FROM career_source_cache').run();
  await withCareerLease(e,'source',async()=>{await e.DB.prepare('UPDATE career_source_cache SET lease_token=?1,lease_until=?2 WHERE cache_key=?3').bind('new-owner',Date.now()+300000,'lease:source').run();});
  expect(await e.DB.prepare('SELECT lease_token FROM career_source_cache WHERE cache_key=?1').bind('lease:source').first()).toEqual({lease_token:'new-owner'});
 });
 it('expires reads, cleans old data, and bounds cache rows without deleting leases',async()=>{
  const e=await env();await writeCareerCache(e,'list',{items:[]});expect(await readCareerCache(e,'list')).toEqual({items:[]});
  await e.DB.prepare('UPDATE career_source_cache SET expires_at=0 WHERE cache_key=?1').bind('list').run();expect(await readCareerCache(e,'list')).toBeNull();
  await e.DB.batch(Array.from({length:102},(_,i)=>e.DB.prepare('INSERT INTO career_source_cache(cache_key,payload,expires_at) VALUES(?1,?2,?3)').bind(`detail:${i}`,'{}',Date.now()+900000)));
  await withCareerLease(e,'model',async()=>null);
  await writeCareerCache(e,'fresh',{a:1});
  expect(await e.DB.prepare('SELECT count(*) AS n FROM career_source_cache WHERE payload IS NOT NULL').first()).toEqual({n:100});
  expect(await e.DB.prepare('SELECT count(*) AS n FROM career_source_cache WHERE cache_key=?1').bind('lease:model').first()).toEqual({n:1});
 });
});
