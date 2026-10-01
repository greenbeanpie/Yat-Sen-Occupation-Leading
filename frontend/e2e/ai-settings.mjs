// Isolated cloud-browser UI verification: all APIs intercepted, only synthetic keys.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { BASE_URL, chromiumExecutable, loadPlaywright } from './playwright-runtime.mjs';
import { aiSettingsFixture } from './ai-settings-fixture.mjs';
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath:chromiumExecutable(),headless:true });
const errors=[];
const page=await browser.newPage({viewport:{width:1280,height:1000}});
page.on('pageerror',error=>errors.push(error.message));
let settings=aiSettingsFixture(), rejectSave=false;
const writes=[];
await page.route('**/api/v1/**',async route=>{
 const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1','');
 const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 if(path==='/session')return json({authenticated:true,user:{id:'owner',displayName:'测试超级管理员',role:'super_admin',demo:false,timezone:'UTC'},capabilities:{push:false,offline:true,demoMode:false}});
 if(path==='/admin/ai-settings'){
  if(request.method()==='PUT'){
   const body=request.postDataJSON();writes.push(body);
   await new Promise(resolve=>setTimeout(resolve,150));
   if(rejectSave)return json({error:{code:'version_conflict',message:'模型配置已更新，请重新加载后再保存'}},409);
   settings={...settings,version:settings.version+1,config:body.config,credentialStatus:body.clearApiKey?'missing':'stored'};
  }
  return json(settings);
 }
 if(path==='/admin/settings')return json({registrationEnabled:true});
 if(path==='/profile')return json({targetRoles:[]});
 if(path==='/applications/stats')return json({efficiency:null});
 return json({items:[],changes:[],results:[],unreadCount:0,nextCursor:null});
});
try{
 await page.goto(`${BASE_URL}/admin`,{waitUntil:'networkidle'});
 await page.getByRole('heading',{name:'AI 模型配置',exact:true}).waitFor();
 await page.getByLabel('配置来源',{exact:true}).selectOption('real');
 await page.getByLabel('供应商预设',{exact:true}).selectOption('openai');
 await page.getByLabel('思考强度',{exact:true}).selectOption('high');
 assert.equal(await page.getByLabel('Temperature',{exact:true}).count(),0);
 const protocols=await page.getByLabel('请求协议（可独立选择）',{exact:true}).locator('option').allTextContents();
 assert(protocols.some(value=>value==='Responses'));assert(protocols.some(value=>value.includes('OpenAI Compatible')));assert(protocols.some(value=>value.includes('Anthropic')));
 await page.getByLabel('供应商预设',{exact:true}).selectOption('opencode-go');
 await page.getByText('OpenCode Go 专用请求头',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('思考强度',{exact:true}).count(),0);
 await page.getByLabel('请求协议（可独立选择）',{exact:true}).selectOption('chat-completions');
 await page.getByLabel('User-Agent（真实应用身份）',{exact:true}).fill('YatSenOccupationLeading/1.1');
 await page.getByLabel('当前目标服务 API key',{exact:true}).fill('synthetic-browser-fixture-key');
 await page.getByRole('checkbox',{name:/我已核对目标服务/}).check();
 await page.getByRole('button',{name:'保存 AI 配置',exact:true}).evaluate(button=>{button.click();button.click();});
 await page.getByText('已加密保存，密钥不会回填',{exact:true}).waitFor();
 assert.equal(writes.length,1);assert.equal(writes[0].config.protocol,'chat-completions');assert.equal(writes[0].config.goUserAgent,'YatSenOccupationLeading/1.1');
 assert.equal(await page.locator('input[type=password]').inputValue(),'');
 await page.reload({waitUntil:'networkidle'});
 assert.equal(await page.getByLabel('供应商预设',{exact:true}).inputValue(),'opencode-go');
 assert.equal(await page.getByLabel('请求协议（可独立选择）',{exact:true}).inputValue(),'chat-completions');
 assert.equal(await page.locator('input[type=password]').inputValue(),'');
 console.log('PASS protocol selection, Go headers, one save despite double submit, reload and password redaction');
 // Changing destination may not reuse the saved key even in UI.
 await page.getByLabel('API 根地址',{exact:true}).fill('https://opencode.ai/other/v1');
 await page.getByRole('checkbox',{name:/我已核对目标服务/}).check();
 await page.getByRole('button',{name:'保存 AI 配置',exact:true}).click();
 await page.getByText('请为当前供应商、协议和 API 根地址重新输入密钥。',{exact:true}).waitFor();
 assert.equal(writes.length,1);
 await page.getByRole('button',{name:'取消修改 / 重新加载',exact:true}).click();
 await page.getByLabel('API 根地址',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('API 根地址',{exact:true}).inputValue(),'');
 // Conflict retains an error and reload cancels edits without extra writes.
 rejectSave=true;
 await page.getByLabel('最大输出 tokens（按供应商协议）',{exact:true}).fill('2048');
 await page.getByRole('checkbox',{name:/我已核对目标服务/}).check();
 await page.getByRole('button',{name:'保存 AI 配置',exact:true}).click();
 await page.getByText('模型配置已更新，请重新加载后再保存',{exact:true}).waitFor();
 assert.equal(writes.length,2);
 await page.getByRole('button',{name:'取消修改 / 重新加载',exact:true}).click();
 await page.getByLabel('最大输出 tokens（按供应商协议）',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('最大输出 tokens（按供应商协议）',{exact:true}).inputValue(),'4096');
 console.log('PASS destination requires key re-entry, cancel and conflict recovery');
 await mkdir('e2e-results',{recursive:true});
 const form=page.locator('.ai-settings-form');
 await form.screenshot({path:'e2e-results/ai-settings-desktop.png'});
 await page.setViewportSize({width:390,height:844});
 await form.scrollIntoViewIfNeeded();
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mobile horizontal overflow');
 await form.screenshot({path:'e2e-results/ai-settings-mobile.png'});
 await page.getByRole('link',{name:'工作台',exact:true}).click();
 await page.goBack({waitUntil:'networkidle'});
 await page.getByRole('heading',{name:'AI 模型配置',exact:true}).waitFor();
 assert.equal(await page.locator('input[type=password]').inputValue(),'');
 assert.deepEqual(errors,[]);
 console.log('PASS desktop/mobile layout, navigation/back and no browser runtime errors');
}finally{await browser.close();}
