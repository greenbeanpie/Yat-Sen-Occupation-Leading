import { createRoute } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { allowedOrigins, type App } from '../app';
import type { AppEnv } from '../env';
import { requireAuth, requireSuperAdmin } from '../middleware/auth';
import { ErrorBodySchema } from '../shared/schemas';
import { AiSettingsWriteSchema, AiSettingsResponseSchema } from '../shared/schemas/ai-settings';
import { AppError, conflict, forbidden } from '../shared/errors';
import { nowIso, uuid } from '../shared/datetime';
import { credentialBinding, readAiSettings, resolveWebConfig, rowConfig, settingsResponse } from '../infra/ai/settings';
import { decryptApiKey, encryptApiKey } from '../infra/ai/credentials';
import { AiError } from '../infra/ai';

const guard: MiddlewareHandler<AppEnv> = async (c,next) => {
  c.header('Cache-Control','no-store');
  if (c.req.method !== 'GET') {
    const origin = c.req.header('Origin');
    if (!origin || (origin !== new URL(c.req.url).origin && !allowedOrigins(c.env).includes(origin)) || c.req.header('Sec-Fetch-Site') === 'cross-site') throw forbidden('请从本站管理中心提交');
    if (!/^application\/json(?:;|$)/i.test(c.req.header('Content-Type') ?? '')) throw forbidden('需要 JSON 请求');
  }
  await next();
};
const middleware = [requireAuth, requireSuperAdmin, guard, bodyLimit({maxSize:16000,onError:()=>{throw new AppError(413,'payload_too_large','模型配置请求过大');}})] as const;
const errors = Object.fromEntries([401,403,409,413,422,503].map(status=>[status,{content:{'application/json':{schema:ErrorBodySchema}},description:'权限、配置或版本错误；不会返回密钥'}]));
const response = { 200: { content: { 'application/json': { schema: AiSettingsResponseSchema } }, description:'仅非敏感配置、密钥状态及能力表；不发出模型请求' }, ...errors };
export function registerAiSettingsRoutes(app: App): void {
  app.openapi(createRoute({method:'get',path:'/admin/ai-settings',tags:['admin'],middleware:[...middleware],responses:response}), async c => c.json(await settingsResponse(c.env,await readAiSettings(c.env)),200) as never);
  app.openapi(createRoute({method:'put',path:'/admin/ai-settings',tags:['admin'],middleware:[...middleware],request:{body:{required:true,content:{'application/json':{schema:AiSettingsWriteSchema}}}},responses:response}), async c => {
    const input = c.req.valid('json');
    if (input.apiKey && new URL(c.req.url).protocol !== 'https:') throw forbidden('模型密钥只能通过 HTTPS 提交');
    const current = await readAiSettings(c.env);
    if (!current || current.version !== input.baseVersion) throw conflict('模型配置已更新，请重新加载后再保存', null);
    if (input.apiKey && input.clearApiKey) throw new AppError(422,'invalid_request','不能同时输入新密钥并清除密钥');
    const version = current.version + 1;
    let ciphertext: string | null = null;
    try {
      // Inactive settings may be empty; any key retention still validates its destination.
      const resolved = input.config.mode === 'real' || input.apiKey || (current.secret_ciphertext && !input.clearApiKey) ? resolveWebConfig(c.env,input.config) : null;
      const binding = resolved ? credentialBinding(resolved) : '';
      let key = input.apiKey;
      if (!key && current.secret_ciphertext && !input.clearApiKey) {
        const previous = credentialBinding(resolveWebConfig(c.env,rowConfig(current)));
        if (previous !== binding) throw new AiError('更换供应商、协议或完整 API 根地址必须重新输入密钥，不能沿用既存密钥', false);
        key = await decryptApiKey(c.env,current.secret_ciphertext,previous,current.version);
      }
      if (input.config.mode === 'real' && !key && !input.clearApiKey) throw new AiError('首次网页真实模型配置必须输入密钥；不会继承部署环境密钥', false);
      if (key) ciphertext = await encryptApiKey(c.env,key,binding,version);
    } catch(error) {
      if (error instanceof AiError) throw new AppError(422,'invalid_ai_config',error.message);
      throw error;
    }
    const auditId = uuid(), now = nowIso();
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO ai_settings_audit(id,actor_id,previous_version,new_version,key_action,created_at)
        SELECT ?1,?2,version,?3,?4,?5 FROM ai_settings WHERE id=1 AND version=?6
        AND EXISTS(SELECT 1 FROM users WHERE id=?2 AND COALESCE(access_role,role)='super_admin' AND is_demo=0 AND deleted=0 AND disabled=0)`)
        .bind(auditId,c.get('user').id,version,input.apiKey?'replace':input.clearApiKey?'clear':'preserve',now,current.version),
      c.env.DB.prepare('UPDATE ai_settings SET version=?1,config_json=?2,secret_ciphertext=?3,updated_at=?4 WHERE id=1 AND version=?5 AND EXISTS(SELECT 1 FROM ai_settings_audit WHERE id=?6)')
        .bind(version,JSON.stringify(input.config),ciphertext,now,current.version,auditId),
    ]);
    if (results[1]!.meta.changes !== 1) throw conflict('权限或配置版本已变化，请重新加载',null);
    return c.json(await settingsResponse(c.env,await readAiSettings(c.env)),200) as never;
  });
}
