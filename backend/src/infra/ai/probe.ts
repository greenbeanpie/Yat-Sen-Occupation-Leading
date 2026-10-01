import type { Env } from '../../env';
import { AppError, conflict, forbidden } from '../../shared/errors';
import type { AiSettingsTestResponse } from '../../shared/schemas/ai-settings';
import { fingerprintOf } from '../db/helpers';
import { rateLimit } from '../rate-limit';
import { getAiProvider, AiError } from './index';
import { resolveAiConfig } from './config';
import { readAiSettings, runtimeAiEnv } from './settings';
import { writeAiDiagnostic } from './diagnostics';

const PROMPT = [{ role: 'user' as const, content: '这是非个人信息的接口连接测试。请只回复：连接测试成功。' }];
const emptyLimits = { maxRequests: 1 as const, timeoutMs: 0, maxOutputTokens: 0, maxResponseBytes: 8192 as const };
function failure(error: unknown): { code: string; message: string } {
  if (!(error instanceof AiError)) return { code: 'test_failed', message: '测试未完成，请稍后重试；不会自动重试或更换模型' };
  const message = error.message;
  const http = /HTTP (\d{3})/.exec(message);
  if (http) return { code: `provider_http_${http[1]}`, message };
  if (message.includes('超时')) return { code: 'timeout', message: `${message}；本次测试超时不代表配置无效，思考模型可能需要更长时间` };
  if (message.includes('网络')) return { code: 'network_error', message: '模型网络请求失败；尚未确认配置是否有效，请检查服务可达性' };
  if (message.includes('token 上限')) return { code: 'output_limit', message };
  return { code: 'invalid_configuration_or_response', message: message.slice(0,500) };
}
export async function testSavedAiSettings(env: Env, actorId: string, input: { baseVersion: number; requestId: string }): Promise<AiSettingsTestResponse> {
  const actor = await env.DB.prepare("SELECT 1 FROM users WHERE id=?1 AND COALESCE(access_role,role)='super_admin' AND is_demo=0 AND deleted=0 AND disabled=0").bind(actorId).first();
  if (!actor) throw forbidden('仅超级管理员可执行真实模型测试');
  const row = await readAiSettings(env);
  if (!row || row.version !== input.baseVersion) throw conflict('模型配置已更新，请重新加载后测试',null);
  const report: AiSettingsTestResponse = { version: row.version, status: 'not_run', realRequestAttempted: false, provider: null, model: null, protocol: null, limits: emptyLimits, checks: [], error: null };
  let runtime: Env;
  try { runtime = await runtimeAiEnv(env,actorId,row.version); }
  catch (error) {
    if ((await readAiSettings(env))?.version !== row.version) throw conflict('模型配置已更新，请重新加载后测试',null);
    await writeAiDiagnostic(env,{requestId:input.requestId,stage:'end',code:'invalid_configuration'});
    return { ...report, status: 'failed', error: failure(error) };
  }
  if (runtime.AI_PROVIDER === 'mock') {
    await writeAiDiagnostic(env,{requestId:input.requestId,stage:'end',code:'mock_mode',provider:'mock'});
    return { ...report, provider: 'mock', error: { code: 'mock_mode', message: '当前使用 mock 模拟模式，未发起真实模型请求，不能作为真实连接成功' } };
  }
  if (runtime.AI_PROVIDER !== 'openai' || !runtime.AI_API_KEY?.trim()) return { ...report, error: { code: 'real_model_unconfigured', message: '尚未配置可用的真实模型与密钥；未发出模型请求' } };
  let provider: ReturnType<typeof getAiProvider>;
  try {
    const config = resolveAiConfig(runtime);
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'https:' || ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new AiError('真实连接测试要求公开 HTTPS 模型地址',false);
    provider = getAiProvider(runtime);
    report.provider = config.preset; report.model = config.model; report.protocol = config.protocol;
    report.limits = { ...emptyLimits, timeoutMs: Math.min(config.timeoutMs,90000), maxOutputTokens: config.maxOutputTokens };
  } catch (error) { return { ...report, status: 'failed', error: failure(error) }; }
  const now = Math.floor(Date.now()/1000);
  const marker = await fingerprintOf(['ai-settings-test-request',actorId,input.requestId]);
  if (await env.DB.prepare('SELECT 1 FROM rate_limits WHERE key=?1 AND window=0 AND expires_at>?2').bind(marker,now).first()) throw new AppError(409,'ai_test_already_requested','此测试请求已发起，不能重复付费发送；如需再次测试，请明确发起新测试');
  await rateLimit(env,`ai-settings-test:${actorId}`,3,60);
  const leaseKey = await fingerprintOf(['ai-settings-test-global-lease']), token = crypto.getRandomValues(new Uint32Array(1))[0]!+1;
  const lease = await env.DB.prepare(`INSERT INTO rate_limits(key,window,hits,expires_at) VALUES(?1,0,?2,?3)
    ON CONFLICT(key,window) DO UPDATE SET hits=excluded.hits,expires_at=excluded.expires_at WHERE rate_limits.expires_at<=?4 RETURNING hits`)
    .bind(leaseKey,token,now+Math.ceil(report.limits.timeoutMs/1000)+30,now).first<{hits:number}>();
  if (lease?.hits !== token) throw new AppError(429,'ai_test_in_progress','另一模型测试正在进行，请等候完成后再试');
  try {
    if (!await env.DB.prepare(`INSERT INTO rate_limits(key,window,hits,expires_at) VALUES(?1,0,1,?2)
      ON CONFLICT(key,window) DO UPDATE SET hits=1,expires_at=excluded.expires_at WHERE rate_limits.expires_at<=?3 RETURNING hits`).bind(marker,now+86400,now).first()) throw new AppError(409,'ai_test_already_requested','此测试请求已发起，不能重复付费发送');
    try {
      await provider.complete(PROMPT,{sessionId:input.requestId,maxAttempts:1,timeoutMs:report.limits.timeoutMs,maxResponseBytes:8192,rejectRedirects:true,
        beforeDispatch:async()=>{
          const current=await env.DB.prepare(`SELECT version,EXISTS(SELECT 1 FROM users WHERE id=?1 AND COALESCE(access_role,role)='super_admin' AND is_demo=0 AND deleted=0 AND disabled=0) AS authorized FROM ai_settings WHERE id=1`).bind(actorId).first<{version:number;authorized:number}>();
          if(!current?.authorized)throw forbidden('账户权限已变化；未发出模型请求');
          if(current.version!==row.version)throw conflict('模型配置版本已变化，请重新加载后测试；未发出模型请求',null);
        },onDispatch:()=>{report.realRequestAttempted=true;}});
      report.status='passed';report.checks=[{name:'connection',passed:true,detail:'已收到供应商的成功响应'},{name:'basic_response',passed:true,detail:'已收到完整有效文本；仅验证连接与基本响应，不保证全部业务能力或效果'}];
    } catch(error){if(error instanceof AppError)throw error;report.status='failed';report.error=failure(error);}
    return report;
  } finally {await env.DB.prepare('DELETE FROM rate_limits WHERE key=?1 AND window=0 AND hits=?2').bind(leaseKey,token).run();}
}
