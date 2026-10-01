import { describe,expect,it,vi } from 'vitest';
import { createApp } from '../src/app';
import { getMf, loginRealAdmin, request, STUDENT, loginAs } from './helpers';
import { ticketNotificationStatements } from '../src/application/ticket-notifications';
import { cronTick,createReminder } from '../src/application/reminders';
import type { Env } from '../src/env';
import { base64url,decodeBase64url,encryptPush,sendWebPush } from '../src/infra/push';
const PUBLIC='BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const D='yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const receiver={p256dh:'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',auth:'BTBZMqHH6r4Tts7J_aSIgg'};
function jwk() {const pub=decodeBase64url(PUBLIC);return {kty:'EC',crv:'P-256',x:base64url(pub.slice(1,33)),y:base64url(pub.slice(33)),d:D};}
async function environment() {const {mf}=await getMf();return {DB:await mf.getD1Database('DB'),DOCS:await mf.getR2Bucket('DOCS') as unknown as R2Bucket,AI_PROVIDER:'mock',AI_BASE_URL:'',AI_MODEL:'',DEMO_ENABLED:'true',SESSION_SECRET:'test-secret-with-at-least-32-bytes-long',CORS_ORIGIN:'http://yso.test',VAPID_PUBLIC_KEY:PUBLIC,VAPID_PRIVATE_KEY:base64url(new TextEncoder().encode(JSON.stringify(jwk()))),VAPID_SUBJECT:'https://app.example'} as Env;}
const headers=(cookie:string)=>({'Content-Type':'application/json',Cookie:cookie,Origin:'http://yso.test'});
async function actor(role='student') {const cookie=await loginRealAdmin();const response=await request(cookie,'/session');const {user}=await response.json<{user:{id:string}}>();const env=await environment();await env.DB.prepare('UPDATE users SET access_role=?1 WHERE id=?2').bind(role,user.id).run();return {cookie,id:user.id,env};}
describe('notification delivery and lifecycle',()=>{
 it('preserves history and enforces own read/dismiss plus current staff access',async()=>{
  const owner=await actor(),staff=await actor('admin'),other=await actor();
  const ticket=await request(owner.cookie,'/tickets',{method:'POST',headers:headers(owner.cookie),body:JSON.stringify({subject:'Private title',body:'Private request'})});const {id}=await ticket.json<{id:string}>();
  await request(staff.cookie,`/tickets/${id}/messages`,{method:'POST',headers:headers(staff.cookie),body:JSON.stringify({body:'Private response'})});
  const feed=await (await request(owner.cookie,'/notifications')).json<{items:{id:string;title:string;body:string}[]}>();expect(feed.items).toHaveLength(1);expect(JSON.stringify(feed)).not.toMatch(/Private/);
  const notification=feed.items[0]!;
  expect((await request(other.cookie,`/notifications/${notification.id}/read`,{method:'POST',headers:headers(other.cookie)})).status).toBe(404);
  expect((await request(owner.cookie,`/notifications/${notification.id}/dismiss`,{method:'POST',headers:headers(owner.cookie)})).status).toBe(200);
  const saved=await (await request(owner.cookie,'/notifications')).json<{items:{dismissedAt:string}[];unreadCount:number}>();expect(saved.items).toHaveLength(1);expect(saved.items[0]!.dismissedAt).toBeTruthy();expect(saved.unreadCount).toBe(0);
  const twice=await ticketNotificationStatements(owner.env,id,staff.id,'same-event','ticket_reply');await owner.env.DB.batch(twice);await owner.env.DB.batch(twice);
  expect((await owner.env.DB.prepare("SELECT COUNT(*) AS n FROM reminders WHERE user_id=?1 AND dedupe_key='same-event'").bind(owner.id).first<{n:number}>())!.n).toBe(1);
  await staff.env.DB.prepare("UPDATE users SET access_role='student' WHERE id=?1").bind(staff.id).run();expect((await (await request(staff.cookie,'/notifications')).json<{items:unknown[]}>()).items).toHaveLength(0);
 });
 it('defaults delivery on, applies choices, rejects missing Origin and keeps preferences per account',async()=>{
  const one=await actor(),two=await actor();
  expect(await (await request(one.cookie,'/notifications/settings')).json()).toMatchObject({inAppEnabled:true,pushEnabled:true});
  expect((await request(one.cookie,'/notifications/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({pushEnabled:false})})).status).toBe(403);
  expect((await request(one.cookie,'/notifications/settings',{method:'PUT',headers:{...headers(one.cookie),'X-Notification-Account':two.id},body:JSON.stringify({pushEnabled:false})})).status).toBe(409);
  const changed=await request(one.cookie,'/notifications/settings',{method:'PUT',headers:headers(one.cookie),body:JSON.stringify({inAppEnabled:false,pushEnabled:false})});expect(await changed.json()).toMatchObject({inAppEnabled:false,pushEnabled:false});
  expect(await (await request(two.cookie,'/notifications/settings')).json()).toMatchObject({inAppEnabled:true,pushEnabled:true});
 });
 it('binds each device endpoint to one account/live session and revokes on logout',async()=>{
  const one=await actor(),two=await actor();const app=createApp();const body={endpoint:'https://fcm.googleapis.com/send/fixture',keys:receiver};
  const call=(cookie:string,path:string,method='GET',body?:unknown)=>app.request('/api/v1'+path,{method,headers:headers(cookie),body:body===undefined?undefined:JSON.stringify(body)},one.env);
  const first=await call(one.cookie,'/notifications/push/subscriptions','POST',body);expect(first.status).toBe(201);const sub=await first.json<{id:string}>();
  expect((await call(two.cookie,'/notifications/push/subscriptions','POST',body)).status).toBe(409);
  expect(await (await call(two.cookie,'/notifications/push/lookup','POST',{endpoint:body.endpoint})).json()).toEqual({id:null});
  expect((await call(two.cookie,`/notifications/push/subscriptions/${sub.id}`,'DELETE')).status).toBe(204);
  expect(await (await call(one.cookie,'/notifications/push/lookup','POST',{endpoint:body.endpoint})).json()).toEqual({id:sub.id});
  expect((await call(one.cookie,'/notifications/push/subscriptions','POST',{...body,endpoint:'https://fcm.googleapis.com.evil.example/x'})).status).toBe(422);
  const exit=await app.request('/api/v1/session',{method:'DELETE',headers:{...headers(one.cookie),'X-Push-Subscription-Id':sub.id}},one.env);expect(exit.status).toBe(204);
  expect(await one.env.DB.prepare('SELECT status,deleted FROM push_subscriptions WHERE id=?1').bind(sub.id).first()).toMatchObject({status:'expired',deleted:1});
 });
 it('does not dispatch against expired sessions or treat unconfigured sender as delivered',async()=>{
  const env=await environment();await loginAs(STUDENT);const session=await env.DB.prepare('SELECT id FROM sessions WHERE user_id=?1').bind(STUDENT).first<{id:string}>();const now=new Date().toISOString();
  await createReminder(env,STUDENT,{entity:'task',entityId:crypto.randomUUID(),entityVersion:1,kind:'task_due',fireAt:now,title:'private'});
  await env.DB.prepare('INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,created_at,updated_at,session_id) VALUES(?1,?2,?3,?4,?5,?6,?6,?7)').bind(crypto.randomUUID(),STUDENT,'https://fcm.googleapis.com/a',receiver.p256dh,receiver.auth,now,session!.id).run();
  await env.DB.prepare('DELETE FROM sessions WHERE id=?1').bind(session!.id).run();const sender=vi.fn(async()=>({ok:true,statusCode:201}));expect((await cronTick(env,now,sender)).sentPush).toBe(0);expect(sender).not.toHaveBeenCalled();
 });
 it('matches RFC8291 published ciphertext and verifies WebCrypto raw VAPID signature',async()=>{
  const pub=decodeBase64url(PUBLIC);const privateKey=await crypto.subtle.importKey('jwk',jwk(),{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);const publicKey=await crypto.subtle.importKey('raw',pub,{name:'ECDH',namedCurve:'P-256'},true,[]);
  const ciphertext=await encryptPush(new TextEncoder().encode('When I grow up, I want to be a watermelon'),receiver,{keyPair:{privateKey,publicKey},salt:decodeBase64url('DGv6ra1nlYgDCS1FRnbzlw')});
  expect(base64url(ciphertext)).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  const env=await environment();const mock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(null,{status:201}));try {
   const result=await sendWebPush(env,{endpoint:'https://fcm.googleapis.com/send/fixture',...receiver},JSON.stringify({title:'更新',body:'查看应用',data:{userId:'user',notificationId:crypto.randomUUID(),url:'/plan'}}));expect(result.ok).toBe(true);
   const init=mock.mock.calls[0]![1]!;expect(init.redirect).toBe('manual');const authorization=new Headers(init.headers).get('Authorization')!;const jwt=authorization.match(/^vapid t=([^,]+)/)![1]!;const [head,claims,sig]=jwt.split('.');expect(decodeBase64url(sig!)).toHaveLength(64);
   const key=await crypto.subtle.importKey('raw',pub,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);expect(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,decodeBase64url(sig!),new TextEncoder().encode(`${head}.${claims}`))).toBe(true);
  }finally{mock.mockRestore();}
 });
});
