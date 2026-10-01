import { createRoute, z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { allowedOrigins, type App } from '../app';
import type { AppEnv } from '../env';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { AppError, conflict, forbidden } from '../shared/errors';
import { ErrorBodySchema } from '../shared/schemas';
import { readCareerCache, writeCareerCache, withCareerLease, SOURCE_TTL_MS } from '../infra/career-cache';
import { fetchCareerHtml, parseCareerList, parseCareerDetail } from '../infra/career-source';
import { rateLimit } from '../infra/rate-limit';
import { getAiProvider } from '../infra/ai';
import { AiError } from '../infra/ai/errors';
import { runtimeAiEnv } from '../infra/ai/settings';
import { hasConfiguredRealAi } from '../infra/ai/config';
import { careerDiagnosticTokenLimit, resolveAiConfig } from '../infra/ai/config';
import { fingerprintOf } from '../infra/db/helpers';
import type { AiUsage } from '../infra/ai/usage';
import { writeAiDiagnostic, type DiagnosticEvent } from '../infra/ai/diagnostics';
import { classifyCareerSourceError } from '../infra/career-source-errors';
import { AnnouncementCandidate, SourceMetadataSchema, createSnapshot, extractAnnouncement, type Snapshot, type ReviewDraft } from '../prototypes/career-announcement';

const Id=z.string().regex(/^\d{1,12}$/);
const Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Item=z.object({id:Id,title:z.string(),url:z.string().url(),publishedAt:z.string(),pinned:z.boolean()});
const SnapshotSchema=z.object({metadata:SourceMetadataSchema,text:z.string(),versionHash:Hash}).openapi('CareerSourceSnapshot');
const Preview=z.object({schemaVersion:z.literal(1),source:SnapshotSchema,title:z.string(),employer:z.string().nullable(),warnings:z.array(z.string()),expiresAt:z.string().datetime()}).openapi('CareerSourcePreview');
type PreviewData=z.infer<typeof Preview>;
const Listing=z.object({schemaVersion:z.literal(1),items:z.array(Item),retrievedAt:z.string().datetime(),expiresAt:z.string().datetime()}).openapi('CareerSourceListing');
type ListingData=z.infer<typeof Listing>;
const Usage=z.object({inputTokens:z.number().int().nullable(),outputTokens:z.number().int().nullable(),reasoningTokens:z.number().int().nullable()}).strict();
const Diagnostic=z.object({requestId:z.string().uuid(),configurationVersion:z.number().int(),maxOutputTokens:z.number().int(),timeoutMs:z.number().int(),usage:Usage}).strict();
const Draft=z.object({status:z.literal('needs-human-review'),provider:z.string(),source:SnapshotSchema,candidate:AnnouncementCandidate,warnings:z.array(z.string()),diagnostic:Diagnostic.optional()}).openapi('CareerExtractionReview');
const Status=z.object({schemaVersion:z.literal(1),sourceId:z.literal('sysu-campus'),extractionAvailable:z.boolean(),extractionUnavailableReason:z.string().nullable(),cachedList:Listing.nullable().openapi("NullableCareerSourceListing"),cacheTtlSeconds:z.literal(900),publicationSupported:z.literal(false),configurationVersion:z.number().int().optional(),diagnosticTokenLimit:z.number().int().optional()}).openapi('CareerSourceStatus');
const DiagnosticBudget=z.object({requestId:z.string().uuid(),baseVersion:z.number().int().nonnegative(),maxOutputTokens:z.number().int().min(4097).max(32768)}).strict();
const errors=Object.fromEntries([401,403,409,413,422,429,502,503].map(status=>[status,{content:{'application/json':{schema:ErrorBodySchema}},description:'错误包络；code 区分鉴权、来源保护、版本冲突或模型未配置'}]));
const guard:MiddlewareHandler<AppEnv>=async(c,next)=>{
  c.header('Cache-Control','no-store');
  if(c.req.method!=='GET'){
    const origin=c.req.header('Origin');
    if(!origin || (origin!==new URL(c.req.url).origin&&!allowedOrigins(c.env).includes(origin)) || c.req.header('Sec-Fetch-Site')==='cross-site') throw forbidden('请从本站管理中心提交');
    if(!/^application\/json(?:;|$)/i.test(c.req.header('Content-Type')??'')) throw forbidden('需要 JSON 请求');
  }
  await next();
};
const middleware=[requireAuth,requireAdmin,guard,bodyLimit({maxSize:2048,onError:()=>{throw new AppError(413,'payload_too_large','来源操作请求体上限为 2KB');}})];
async function configuredEnv(env: import('../env').Env) { try { const resolved = await runtimeAiEnv(env); return hasConfiguredRealAi(resolved) ? resolved : null; } catch { return null; } }
async function sourceCall<T>(env:import('../env').Env,requestId:string,fn:(trace:(stage:DiagnosticEvent['stage'])=>Promise<void>)=>Promise<T>):Promise<T>{
  const started=Date.now();
  const trace=async(stage:DiagnosticEvent['stage'])=>{await writeAiDiagnostic(env,{requestId,stage,code:'ok',httpStatus:stage==='source_fetch'?undefined:200,timeoutMs:15000,elapsedMs:Date.now()-started});};
  await trace('source_fetch');
  try{const result=await fn(trace);await trace('source_end');return result;}
  catch(error){if(error instanceof AppError)throw error;const failure=classifyCareerSourceError(error);
    await writeAiDiagnostic(env,{requestId,stage:failure.stage,code:failure.code,httpStatus:failure.httpStatus,timeoutMs:15000,elapsedMs:Date.now()-started});
    await writeAiDiagnostic(env,{requestId,stage:'source_end',code:failure.code,httpStatus:failure.httpStatus,timeoutMs:15000,elapsedMs:Date.now()-started});
    throw new AppError(failure.status,failure.code,failure.message);
  }
}
const base='/admin/career-source';
const statusRoute=createRoute({method:'get',path:base,tags:['career-source'],middleware,responses:{200:{content:{'application/json':{schema:Status}},description:'仅缓存及能力，不发出来源请求'},...errors}});
const refreshRoute=createRoute({method:'post',path:`${base}/refresh`,tags:['career-source'],middleware,request:{body:{required:true,content:{'application/json':{schema:z.object({}).strict()}}}},responses:{200:{content:{'application/json':{schema:Listing}},description:'首页公告缓存，15 分钟内复用；无自动翻页'},...errors}});
const previewRoute=createRoute({method:'post',path:`${base}/preview`,tags:['career-source'],middleware,request:{body:{required:true,content:{'application/json':{schema:z.object({id:Id}).strict()}}}},responses:{200:{content:{'application/json':{schema:Preview}},description:'限定公告纯文本及来源版本，15 分钟内复用'},...errors}});
const extractRoute=createRoute({method:'post',path:`${base}/extract`,tags:['career-source'],middleware,request:{body:{required:true,content:{'application/json':{schema:z.object({id:Id,sourceVersionHash:Hash,diagnosticBudget:DiagnosticBudget.optional()}).strict()}}}},responses:{200:{content:{'application/json':{schema:Draft}},description:'仅待人工审核候选；可选临时诊断预算仅超级管理员，配置不变且不复用模型缓存'},...errors}});
export function registerCareerSourceRoutes(app:App):void{
  app.openapi(statusRoute,async c=>{const runtime=await configuredEnv(c.env),ready=!!runtime;const row=await c.env.DB.prepare('SELECT version FROM ai_settings WHERE id=1').first<{version:number}>();const actor=c.get('user')!;return c.json({schemaVersion:1,sourceId:'sysu-campus',extractionAvailable:ready,extractionUnavailableReason:ready?null:'real_model_unconfigured',cachedList:await readCareerCache<ListingData>(c.env,'list'),cacheTtlSeconds:900,publicationSupported:false,configurationVersion:row?.version??0,diagnosticTokenLimit:runtime&&actor.role==='super_admin'?careerDiagnosticTokenLimit(resolveAiConfig(runtime)):0},200) as never;});
  app.openapi(refreshRoute,async c=>{
    const cached=await readCareerCache<ListingData>(c.env,'list');if(cached)return c.json(cached,200) as never;
    const result=await withCareerLease(c.env,'source',()=>sourceCall(c.env,c.res.headers.get('X-Request-Id')??crypto.randomUUID(),async trace=>{
      const existing=await readCareerCache<ListingData>(c.env,'list');if(existing)return existing;
      const html=await fetchCareerHtml('/campus/index');await trace('source_response');const items=await parseCareerList(html);await trace('source_parse');
      const data:ListingData={schemaVersion:1,items,retrievedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+SOURCE_TTL_MS).toISOString()};
      await writeCareerCache(c.env,'list',data);return data;
    }));return c.json(result,200) as never;
  });
  app.openapi(previewRoute,async c=>{
    const {id}=c.req.valid('json');const cached=await readCareerCache<PreviewData>(c.env,`detail:${id}`);if(cached)return c.json(cached,200) as never;
    const result=await withCareerLease(c.env,'source',()=>sourceCall(c.env,c.res.headers.get('X-Request-Id')??crypto.randomUUID(),async trace=>{
      const existing=await readCareerCache<PreviewData>(c.env,`detail:${id}`);if(existing)return existing;
      const html=await fetchCareerHtml(`/campus/view/id/${id}`);await trace('source_response');const detail=await parseCareerDetail(html,id);await trace('source_parse');
      const source=await createSnapshot({url:detail.url,numericId:id,retrievedAt:new Date().toISOString(),originalDate:detail.originalDate,sourceExpiry:detail.sourceExpiry,captureMethod:'static-html-text',partial:detail.partial},`公告标题：${detail.title}\n${detail.employer?`发布单位：${detail.employer}\n`:''}正文：\n${detail.text}`);
      const data:PreviewData={schemaVersion:1,source,title:detail.title,employer:detail.employer,warnings:detail.warnings,expiresAt:new Date(Date.now()+SOURCE_TTL_MS).toISOString()};
      await writeCareerCache(c.env,`detail:${id}`,data);return data;
    }));return c.json(result,200) as never;
  });
  app.openapi(extractRoute,async c=>{
    const {id,sourceVersionHash,diagnosticBudget}=c.req.valid('json');
    const actorId=c.get('user')!.id;
    const assertDiagnosticAccess=async()=>{
      if(!diagnosticBudget)return;
      const row=await c.env.DB.prepare(`SELECT version,EXISTS(SELECT 1 FROM users WHERE id=?1 AND COALESCE(access_role,role)='super_admin' AND is_demo=0 AND disabled=0 AND deleted=0) AS authorized FROM ai_settings WHERE id=1`).bind(actorId).first<{version:number;authorized:number}>();
      if(!row?.authorized)throw forbidden('仅超级管理员可使用临时公告诊断预算');
      if(row.version!==diagnosticBudget.baseVersion)throw conflict('模型配置版本已变化，请重新读取状态后测试',null);
    };
    await assertDiagnosticAccess();
    const aiEnv=await configuredEnv(c.env);
    if(!aiEnv)throw new AppError(503,'real_model_unconfigured','尚未配置真实模型；mock 不支持公告提取，请先由运维配置并批准模型使用');
    if(diagnosticBudget&&diagnosticBudget.maxOutputTokens>careerDiagnosticTokenLimit(resolveAiConfig(aiEnv)))throw new AppError(422,'career_test_model_unsupported','当前模型未验证此临时预算，未发出模型请求');
    const getSource=async():Promise<Snapshot>=>{const preview=await readCareerCache<PreviewData>(c.env,`detail:${id}`);if(!preview||preview.source.versionHash!==sourceVersionHash)throw new AppError(409,'source_version_conflict','来源缓存过期或版本变化，请重新预览');return preview.source;};
    await getSource();const key=`draft:${id}:${sourceVersionHash}`;const cached=await readCareerCache<ReviewDraft>(c.env,key);if(cached&&!diagnosticBudget)return c.json(cached,200) as never;
    const draft=await withCareerLease(c.env,'model',async()=>{
      await getSource();const existing=await readCareerCache<ReviewDraft>(c.env,key);if(existing&&!diagnosticBudget)return existing;
      if(diagnosticBudget){
        const now=Math.floor(Date.now()/1000),marker=await fingerprintOf(['career-test-request',actorId,diagnosticBudget.requestId]);
        if(!await c.env.DB.prepare(`INSERT INTO rate_limits(key,window,hits,expires_at) VALUES(?1,0,1,?2) ON CONFLICT(key,window) DO UPDATE SET hits=1,expires_at=excluded.expires_at WHERE rate_limits.expires_at<=?3 RETURNING hits`).bind(marker,now+86400,now).first())throw new AppError(409,'career_test_already_requested','同一诊断请求已发起，不重复付费发送');
        await rateLimit(c.env,`career-test:${actorId}`,3,60);
      }else await rateLimit(c.env,`career-extract:${id}`,3,3600);
      await rateLimit(c.env,'career-extract:global',10,3600);
      const source=await getSource();let result:ReviewDraft;
      let usage:AiUsage={inputTokens:null,outputTokens:null,reasoningTokens:null};
      try{result=await extractAnnouncement(source,getAiProvider(aiEnv),diagnosticBudget?{sessionId:diagnosticBudget.requestId,careerDiagnosticBudget:{maxOutputTokens:diagnosticBudget.maxOutputTokens,timeoutMs:120000},beforeDispatch:async()=>{await assertDiagnosticAccess();await getSource();},onUsage:value=>{usage=value;}}:undefined);}catch(error){
        if(error instanceof AppError)throw error;
        if(error instanceof AiError && error.message.includes('token 上限'))throw new AppError(502,'career_output_limit','本次提取达到已保存的输出 token 上限（思考 token 也可能占用预算），未产生完整候选；不会自动重试或提高预算');
        throw new AppError(502,'career_extraction_failed','模型请求或证据校验失败，未产生可用候选');
      }
      await getSource(); // Never return/store a result for a changed or expired snapshot.
      if(diagnosticBudget)result.diagnostic={requestId:diagnosticBudget.requestId,configurationVersion:diagnosticBudget.baseVersion,maxOutputTokens:diagnosticBudget.maxOutputTokens,timeoutMs:120000,usage};
      await writeCareerCache(c.env,key,result);return result;
    });return c.json(draft,200) as never;
  });
}
