#!/usr/bin/env node
/** Read-only/unauthenticated release checks. Never creates a session or fetches SYSU. */
const base = process.argv[2]?.replace(/\/+$/, '');
if (!base || !/^https?:\/\//.test(base)) throw Error('Usage: node backend/scripts/smoke-career-source.mjs <backend-or-site-url>');
let failures=0;
const check=(ok,label)=>{console.log(`[${ok?'PASS':'FAIL'}] ${label}`);if(!ok)failures++;};
async function call(path, options={}){
 const response=await fetch(`${base}/api/v1${path}`,{...options,signal:AbortSignal.timeout(15000),redirect:'manual'});
 return {response,body:await response.json()};
}
const health=await call('/health');check(health.response.status===200,'Public backend health');
const contract=await call('/openapi.json');
for(const suffix of ['', '/refresh','/preview','/extract'])check(Boolean(contract.body.paths?.[`/api/v1/admin/career-source${suffix}`]),`Contract ${suffix||'status'}`);
for(const [suffix,body]of [['',null],['/refresh',{}],['/preview',{id:'997448'}],['/extract',{id:'997448',sourceVersionHash:'a'.repeat(64)}]]){
 const result=await call(`/admin/career-source${suffix}`,body?{method:'POST',headers:{'Content-Type':'application/json',Origin:new URL(base).origin},body:JSON.stringify(body)}:{});
 check(result.response.status===401&&result.body.error?.code==='unauthorized',`Unauthenticated ${suffix||'status'} denied`);
 check(result.response.headers.get('Cache-Control')==='no-store',`No-store ${suffix||'status'}`);
}
console.log('These checks do not prove authenticated edge source access or real model extraction.');
process.exitCode=failures?1:0;
