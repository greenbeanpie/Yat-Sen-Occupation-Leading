import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Env } from '../src/env';
import { getMf, loginRealAdmin, loginAs, request, STUDENT, ADMIN } from './helpers';
import { defaultSettings, credentialBinding, resolveWebConfig, runtimeAiEnv, getConfiguredAiProvider, settingsEnv } from '../src/infra/ai/settings';
import { encryptApiKey, decryptApiKey, encryptionAvailable } from '../src/infra/ai/credentials';
import type { AiSettingsConfig } from '../src/shared/schemas/ai-settings';
const ROOT = 'test-secret-with-at-least-32-bytes-long';
const KEY = 'synthetic-provider-key-A';
const headers = { 'Content-Type': 'application/json', Origin: 'https://yso.test' };
const realConfig = (): AiSettingsConfig => ({ ...defaultSettings(), mode:'real',providerPreset:'openai',protocol:'responses',model:'gpt-5',reasoningEffort:'medium' });
async function owner() {
  const cookie = await loginRealAdmin();
  const session = await (await request(cookie,'/session')).json<{user:{id:string}}>();
  const {mf} = await getMf(), DB = await mf.getD1Database('DB');
  await DB.prepare("UPDATE users SET access_role='super_admin' WHERE id=?1").bind(session.user.id).run();
  const env = { DB, SESSION_SECRET:ROOT, AI_PROVIDER:'mock', AI_BASE_URL:'', AI_MODEL:'', AI_API_KEY:'existing-env-key-never-inherit' } as Env;
  const send = async (body: object, extraHeaders: Record<string,string> = {}) => mf.dispatchFetch('https://yso.test/api/v1/admin/ai-settings',{method:'PUT',headers:{...headers,Cookie:cookie,...extraHeaders},body:JSON.stringify(body)}) as unknown as Promise<Response>;
  return { cookie,id:session.user.id,DB,env,send };
}
afterEach(()=>vi.unstubAllGlobals());

describe('AI setting authorization, persistence and credential binding',()=>{
  it('blocks ordinary/demo/admin access and accepts only non-demo super admins',async()=>{
    for(const cookie of [undefined,await loginAs(STUDENT),await loginAs(ADMIN),await loginRealAdmin()]) expect([401,403]).toContain((await request(cookie,'/admin/ai-settings')).status);
    const account=await owner(); const response=await request(account.cookie,'/admin/ai-settings');
    expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body=await response.json();expect(body).toMatchObject({version:0,config:{mode:'environment'},credentialStatus:'environment',encryptionAvailable:true});
    expect(JSON.stringify(body)).not.toContain(KEY);expect(JSON.stringify(body)).not.toContain('secret_ciphertext');
  });
  it('persists encrypted credentials and preserves per-version AAD when editing options',async()=>{
    const a=await owner(),config=realConfig();
    const first=await a.send({baseVersion:0,config,apiKey:KEY});expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({version:1,credentialStatus:'stored'});
    const row=await a.DB.prepare('SELECT * FROM ai_settings').first<{config_json:string;secret_ciphertext:string;version:number}>();
    expect(JSON.stringify(row)).not.toContain(KEY);expect(row!.secret_ciphertext).toContain('"v":1');
    expect((await runtimeAiEnv(a.env,a.id)).AI_API_KEY).toBe(KEY);
    const updated={...config,maxOutputTokens:2000};
    expect((await a.send({baseVersion:1,config:updated})).status).toBe(200);
    const row2=await a.DB.prepare('SELECT * FROM ai_settings').first<{secret_ciphertext:string;version:number}>();
    expect(row2!.version).toBe(2);expect(row2!.secret_ciphertext).not.toBe(row!.secret_ciphertext);
    expect((await runtimeAiEnv(a.env,a.id)).AI_API_KEY).toBe(KEY);
    const audit=await a.DB.prepare('SELECT * FROM ai_settings_audit ORDER BY new_version').all();
    expect(audit.results).toHaveLength(2);expect(JSON.stringify(audit)).not.toContain(KEY);expect(audit.results[1]).toMatchObject({previous_version:1,new_version:2,key_action:'preserve'});
  });
  it('fails closed instead of inheriting deployment key; clear disables real use',async()=>{
    const a=await owner(),config=realConfig();
    expect((await a.send({baseVersion:0,config})).status).toBe(422);
    expect((await a.send({baseVersion:0,config,apiKey:KEY})).status).toBe(200);
    const cleared=await a.send({baseVersion:1,config,clearApiKey:true});expect(cleared.status).toBe(200);expect(await cleared.json()).toMatchObject({credentialStatus:'missing'});
    await expect(runtimeAiEnv(a.env,a.id)).rejects.toThrow('不会改用环境密钥');
  });
  it('requires a new key on provider, protocol or full-root path changes',async()=>{
    const a=await owner(),config=realConfig();await a.send({baseVersion:0,config,apiKey:KEY});
    for(const changes of [{protocol:'chat-completions'}, {providerPreset:'custom',baseUrl:'https://api.openai.com/v1'}, {baseUrl:'https://api.openai.com/another/v1'}]){
      const result=await a.send({baseVersion:1,config:{...config,reasoningEffort:'default',...changes}});
      expect(result.status).toBe(422);expect(await result.text()).toContain('重新输入密钥');
    }
    expect((await a.send({baseVersion:1,config:{...config,baseUrl:'https://api.openai.com/another/v1'},apiKey:'synthetic-provider-key-B'})).status).toBe(200);
    expect((await runtimeAiEnv(a.env,a.id)).AI_API_KEY).toBe('synthetic-provider-key-B');
  });
  it('rejects cross-origin, insecure credential submission, mass assignment and stale version',async()=>{
    const a=await owner(),config=realConfig();
    expect((await a.send({baseVersion:0,config,apiKey:KEY},{Origin:'https://evil.test'})).status).toBe(403);
    expect((await a.send({baseVersion:0,config,apiKey:KEY},{'Sec-Fetch-Site':'cross-site'})).status).toBe(403);
    expect((await a.send({baseVersion:0,config,apiKey:KEY,secret_ciphertext:'forged'})).status).toBe(422);
    expect((await request(a.cookie,'/admin/ai-settings',{method:'PUT',headers:{'Content-Type':'application/json',Origin:'http://yso.test'},body:JSON.stringify({baseVersion:0,config,apiKey:KEY})})).status).toBe(403);
    expect((await a.send({baseVersion:0,config,apiKey:KEY})).status).toBe(200);
    expect((await a.send({baseVersion:0,config,apiKey:KEY})).status).toBe(409);
    expect(await a.DB.prepare('SELECT count(*) AS n FROM ai_settings_audit').first()).toEqual({n:1});
  });
  it('checks current privileges, blocks paid demo dispatches, and uses saved config for real users',async()=>{
    const a=await owner();await a.send({baseVersion:0,config:realConfig(),apiKey:KEY});
    expect((await getConfiguredAiProvider(a.env,STUDENT)).name).toBe('mock');
    expect((await getConfiguredAiProvider(a.env,a.id)).name).toBe('openai:gpt-5');
    await a.DB.prepare("UPDATE users SET access_role='admin' WHERE id=?1").bind(a.id).run();
    expect((await a.send({baseVersion:1,config:realConfig(),apiKey:KEY})).status).toBe(403);
  });
  it('dispatches saved credentials only to their bound endpoint and keeps operation sessions stable',async()=>{
    const a=await owner();
    const config={...realConfig(),providerPreset:'opencode-go',protocol:'chat-completions',model:'glm-5.3',reasoningEffort:'default'};
    expect((await a.send({baseVersion:0,config,apiKey:KEY})).status).toBe(200);
    const fetch=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}]})));vi.stubGlobal('fetch',fetch);
    const conversation=crypto.randomUUID();
    await (await getConfiguredAiProvider(a.env,a.id,conversation)).complete([{role:'user',content:'synthetic fixture'}]);
    await (await getConfiguredAiProvider(a.env,a.id,conversation)).complete([{role:'user',content:'second fixture'}]);
    for(const call of fetch.mock.calls as unknown as [string,RequestInit][]){
      expect(call[0]).toBe('https://opencode.ai/zen/go/v1/chat/completions');
      const headers=new Headers(call[1].headers);expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);expect(headers.get('x-opencode-session')).toBe(conversation);
      expect(JSON.parse(call[1].body as string)).not.toHaveProperty('temperature');
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('fails closed when the singleton row or saved config disappears',async()=>{
    const a=await owner();await a.send({baseVersion:0,config:realConfig(),apiKey:KEY});
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    await a.DB.prepare('UPDATE ai_settings SET config_json=NULL').run();
    await expect(runtimeAiEnv(a.env,a.id)).rejects.toThrow('配置损坏');
    await a.DB.prepare('DELETE FROM ai_settings').run();
    await expect(runtimeAiEnv(a.env,a.id)).rejects.toThrow('记录缺失');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports root rotation as unreadable and requires key re-entry without env fallback',async()=>{
    const a=await owner();await a.send({baseVersion:0,config:realConfig(),apiKey:KEY});
    await expect(runtimeAiEnv({...a.env,SESSION_SECRET:'rotated-root-with-at-least-thirty-two-bytes'},a.id)).rejects.toThrow('重新输入密钥');
    const row=await a.DB.prepare('SELECT secret_ciphertext FROM ai_settings').first<{secret_ciphertext:string}>();
    await a.DB.prepare('UPDATE ai_settings SET secret_ciphertext=?1').bind(row!.secret_ciphertext.replace('"data":"','"data":"AAAA')).run();
    expect(await (await request(a.cookie,'/admin/ai-settings')).json()).toMatchObject({credentialStatus:'unreadable'});
    expect((await a.send({baseVersion:1,config:realConfig()})).status).toBe(422);
    expect((await a.send({baseVersion:1,config:realConfig(),apiKey:KEY})).status).toBe(200);
  });
});

describe('web endpoint and crypto safety',()=>{
  it('binds ciphertext to config version and destination, uses unique IVs and rejects short root/tamper',async()=>{
    const env={SESSION_SECRET:ROOT} as Env, binding='["openai","responses","https://api.openai.com/v1"]';
    const one=await encryptApiKey(env,KEY,binding,1),two=await encryptApiKey(env,KEY,binding,1);
    expect(one).not.toBe(two);expect(await decryptApiKey(env,one,binding,1)).toBe(KEY);
    await expect(decryptApiKey(env,one,binding,2)).rejects.toThrow('无法解密');
    await expect(decryptApiKey(env,one,binding+'/changed',1)).rejects.toThrow('无法解密');
    await expect(decryptApiKey(env,one.slice(0,-5),binding,1)).rejects.toThrow('无法解密');
    expect(encryptionAvailable({SESSION_SECRET:'short'} as Env)).toBe(false);
    await expect(encryptApiKey({SESSION_SECRET:'short'} as Env,KEY,binding,1)).rejects.toThrow('安全加密未配置');
  });
  it.each(['http://api.openai.com/v1','https://127.0.0.1/v1','https://[::1]/v1','https://169.254.169.254/v1','https://private.local/v1','https://api.openai.com:8443/v1','https://evil.attacker.net/v1','https://api.openai.com/v1/../bad','https://api.openai.com/%2e%2e/bad','https://api.openai.com/v1?key=secret'])('rejects unsafe web root %s',baseUrl=>{
    expect(()=>resolveWebConfig({} as Env,{...realConfig(),baseUrl})).toThrow();
  });
  it('allows only explicit operator-approved custom hosts and binds the canonical full root',()=>{
    const env={AI_ALLOWED_HOSTS:'models.company.net'} as Env;
    const config=resolveWebConfig(env,{...realConfig(),providerPreset:'custom',protocol:'responses',baseUrl:'https://models.company.net/gateway/v1/',reasoningEffort:'default'});
    expect(credentialBinding(config)).toBe('["custom","responses","https://models.company.net/gateway/v1"]');
    expect(config.temperature).toBeUndefined();
    expect(settingsEnv(env,realConfig()).AI_API_KEY).toBeUndefined();
    expect(()=>resolveWebConfig(env,{...realConfig(),providerPreset:'opencode-go',model:'glm-5.3',protocol:'auto',reasoningEffort:'default',baseUrl:'https://models.company.net/zen/go/v1'})).toThrow('官方');
  });
});
