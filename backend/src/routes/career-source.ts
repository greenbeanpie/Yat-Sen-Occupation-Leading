import { createRoute, z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { allowedOrigins, type App } from '../app';
import type { AppEnv } from '../env';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { AppError, forbidden } from '../shared/errors';
import { ErrorBodySchema } from '../shared/schemas';
import { readCareerCache, writeCareerCache, withCareerLease, SOURCE_TTL_MS } from '../infra/career-cache';
import { fetchCareerHtml, parseCareerList, parseCareerDetail } from '../infra/career-source';
import { rateLimit } from '../infra/rate-limit';
import { getAiProvider } from '../infra/ai';
import { runtimeAiEnv } from '../infra/ai/settings';
import { hasConfiguredRealAi } from '../infra/ai/config';
import { AnnouncementCandidate, SourceMetadataSchema, createSnapshot, extractAnnouncement, type Snapshot, type ReviewDraft } from '../prototypes/career-announcement';

const Id=z.string().regex(/^\d{1,12}$/);
const Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Item=z.object({id:Id,title:z.string(),url:z.string().url(),publishedAt:z.string(),pinned:z.boolean()});
const SnapshotSchema=z.object({metadata:SourceMetadataSchema,text:z.string(),versionHash:Hash}).openapi('CareerSourceSnapshot');
const Preview=z.object({schemaVersion:z.literal(1),source:SnapshotSchema,title:z.string(),employer:z.string().nullable(),warnings:z.array(z.string()),expiresAt:z.string().datetime()}).openapi('CareerSourcePreview');
type PreviewData=z.infer<typeof Preview>;
const Listing=z.object({schemaVersion:z.literal(1),items:z.array(Item),retrievedAt:z.string().datetime(),expiresAt:z.string().datetime()}).openapi('CareerSourceListing');
type ListingData=z.infer<typeof Listing>;
const Draft=z.object({status:z.literal('needs-human-review'),provider:z.string(),source:SnapshotSchema,candidate:AnnouncementCandidate,warnings:z.array(z.string())}).openapi('CareerExtractionReview');
const Status=z.object({schemaVersion:z.literal(1),sourceId:z.literal('sysu-campus'),extractionAvailable:z.boolean(),extractionUnavailableReason:z.string().nullable(),cachedList:Listing.nullable().openapi("NullableCareerSourceListing"),cacheTtlSeconds:z.literal(900),publicationSupported:z.literal(false)}).openapi('CareerSourceStatus');
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
async function sourceCall<T>(fn:()=>Promise<T>):Promise<T>{try{return await fn();}catch(error){if(error instanceof AppError)throw error;throw new AppError(502,'career_source_unavailable','来源拒绝访问、超时或结构发生变化；已停止并冷却 15 分钟');}}
const base='/admin/career-source';
const statusRoute=createRoute({method:'get',path:base,tags:['career-source'],middleware,responses:{200:{content:{'application/json':{schema:Status}},description:'仅缓存及能力，不发出来源请求'},...errors}});
const refreshRoute=createRoute({method:'post',path:`${base}/refresh`,tags:['career-source'],middleware,request:{body:{required:true,content:{'application/json':{schema:z.object({}).strict()}}}},responses:{200:{content:{'application/json':{schema:Listing}},description:'首页公告缓存，15 分钟内复用；无自动翻页'},...errors}});
const previewRoute=createRoute({method:'post',path:`${base}/preview`,tags:['career-source'],middleware,request:{body:{required:true,content:{'application/json':{schema:z.object({id:Id}).strict()}}}},responses:{200:{content:{'application/json':{schema:Preview}},description:'限定公告纯文本及来源版本，15 分钟内复用'},...errors}});
const extractRoute=createRoute({method:'post',path:`${base}/extract`,tags:['career-source'],middleware,request:{body:{required:true,content:{'application/json':{schema:z.object({id:Id,sourceVersionHash:Hash}).strict()}}}},responses:{200:{content:{'application/json':{schema:Draft}},description:'仅待人工审核候选，不写岗位；相同来源版本复用结果'},...errors}});
export function registerCareerSourceRoutes(app:App):void{
  app.openapi(statusRoute,async c=>{const ready=!!await configuredEnv(c.env);return c.json({schemaVersion:1,sourceId:'sysu-campus',extractionAvailable:ready,extractionUnavailableReason:ready?null:'real_model_unconfigured',cachedList:await readCareerCache<ListingData>(c.env,'list'),cacheTtlSeconds:900,publicationSupported:false},200) as never;});
  app.openapi(refreshRoute,async c=>{
    const cached=await readCareerCache<ListingData>(c.env,'list');if(cached)return c.json(cached,200) as never;
    const result=await withCareerLease(c.env,'source',()=>sourceCall(async()=>{
      const existing=await readCareerCache<ListingData>(c.env,'list');if(existing)return existing;
      const items=await parseCareerList(await fetchCareerHtml('/campus/index'));
      const data:ListingData={schemaVersion:1,items,retrievedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+SOURCE_TTL_MS).toISOString()};
      await writeCareerCache(c.env,'list',data);return data;
    }));return c.json(result,200) as never;
  });
  app.openapi(previewRoute,async c=>{
    const {id}=c.req.valid('json');const cached=await readCareerCache<PreviewData>(c.env,`detail:${id}`);if(cached)return c.json(cached,200) as never;
    const result=await withCareerLease(c.env,'source',()=>sourceCall(async()=>{
      const existing=await readCareerCache<PreviewData>(c.env,`detail:${id}`);if(existing)return existing;
      const detail=await parseCareerDetail(await fetchCareerHtml(`/campus/view/id/${id}`),id);
      const source=await createSnapshot({url:detail.url,numericId:id,retrievedAt:new Date().toISOString(),originalDate:detail.originalDate,sourceExpiry:detail.sourceExpiry,captureMethod:'static-html-text',partial:detail.partial},`公告标题：${detail.title}\n${detail.employer?`发布单位：${detail.employer}\n`:''}正文：\n${detail.text}`);
      const data:PreviewData={schemaVersion:1,source,title:detail.title,employer:detail.employer,warnings:detail.warnings,expiresAt:new Date(Date.now()+SOURCE_TTL_MS).toISOString()};
      await writeCareerCache(c.env,`detail:${id}`,data);return data;
    }));return c.json(result,200) as never;
  });
  app.openapi(extractRoute,async c=>{
    const aiEnv=await configuredEnv(c.env);
    if(!aiEnv)throw new AppError(503,'real_model_unconfigured','尚未配置真实模型；mock 不支持公告提取，请先由运维配置并批准模型使用');
    const {id,sourceVersionHash}=c.req.valid('json');
    const getSource=async():Promise<Snapshot>=>{const preview=await readCareerCache<PreviewData>(c.env,`detail:${id}`);if(!preview||preview.source.versionHash!==sourceVersionHash)throw new AppError(409,'source_version_conflict','来源缓存过期或版本变化，请重新预览');return preview.source;};
    await getSource();const key=`draft:${id}:${sourceVersionHash}`;const cached=await readCareerCache<ReviewDraft>(c.env,key);if(cached)return c.json(cached,200) as never;
    const draft=await withCareerLease(c.env,'model',async()=>{
      await getSource();const existing=await readCareerCache<ReviewDraft>(c.env,key);if(existing)return existing;
      await rateLimit(c.env,`career-extract:${id}`,3,3600);
      await rateLimit(c.env,'career-extract:global',10,3600);
      const source=await getSource();let result:ReviewDraft;
      try{result=await extractAnnouncement(source,getAiProvider(aiEnv));}catch{throw new AppError(502,'career_extraction_failed','模型请求或证据校验失败，未产生可用候选');}
      await getSource(); // Never return/store a result for a changed or expired snapshot.
      await writeCareerCache(c.env,key,result);return result;
    });return c.json(draft,200) as never;
  });
}
