import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { components } from '../api/schema';
import { AiSettingsEditor } from './AiSettingsPanel';
import { aiDestinationChanged, aiFormCapabilities } from './ai-settings-form';
type Settings = components['schemas']['AiSettingsResponse'];
const fixture: Settings = { version:0,credentialStatus:'missing',updatedAt:null,encryptionAvailable:true,allowedHosts:['api.openai.com','opencode.ai'],
 config:{mode:'real',providerPreset:'openai',protocol:'auto',baseUrl:'',model:'gpt-5',reasoningEffort:'default',thinkingBudget:null,temperature:null,topP:null,maxOutputTokens:4096,timeoutMs:60000,maxAttempts:3,requestHeaders:{},goUserAgent:'YatSenOccupationLeading/1.0'},
 presets:[{id:'openai',label:'OpenAI',baseUrl:'https://api.openai.com/v1',models:[{id:'gpt-5',protocol:'responses',temperature:false,topP:false,samplingWithNoneOnly:false,reasoningEfforts:['minimal','low','medium','high']}]},{id:'opencode-go',label:'OpenCode Go',baseUrl:'https://opencode.ai/zen/go/v1',models:[{id:'glm-5.3',protocol:'chat-completions',temperature:false,topP:false,samplingWithNoneOnly:false,reasoningEfforts:[]}]}],
};
const render=(settings=fixture)=>renderToStaticMarkup(<AiSettingsEditor settings={settings} busy={false} onSave={async()=>{}} onReload={()=>{}}/>);
describe('AI web settings form',()=>{
 it('offers an explicit saved-only test and private diagnostic reader without coupling save to probe results',()=>{
  const html=render();expect(html).toContain('测试已保存配置');expect(html).toContain('可能消耗少量额度');expect(html).toContain('本次测试超时不代表配置无效');expect(html).toContain('读取最新诊断日志');expect(html).toContain('1,000,000 UTF-8 字节');expect(html).toContain('测试失败不阻止保存');
 });
 it.each(['deepseek-flash','deepseek-v4-pro'])('renders all native DeepSeek effort options for %s',model=>{
  const native={...fixture,config:{...fixture.config,providerPreset:'deepseek' as const,model},presets:[...fixture.presets,{id:'deepseek' as const,label:'DeepSeek',baseUrl:'https://api.deepseek.com',models:[{id:model,protocol:'chat-completions' as const,temperature:false,topP:true,samplingWithNoneOnly:true,reasoningEfforts:['none','low','high','max']}]}]};
  const html=render(native);for(const effort of ['none','low','high','max'])expect(html).toContain(`value="${effort}"`);
  expect(aiFormCapabilities(native,native.config).reasoningEfforts).toEqual(['none','low','high','max']);
 });
 it('explains the shared text-only model without inventing advanced routes',()=>{
  const html=render();expect(html).toContain('统一模型：文档解析');expect(html).toContain('招聘公告提取共用');expect(html).toContain('当前仅支持文本输入');expect(html).toContain('不会自动改用其他端点');
 });
 it('offers independent protocols, redacted password and supported effort only',()=>{
  const html=render();expect(html).toContain('Responses');expect(html).toContain('OpenAI Compatible');expect(html).toContain('Anthropic');expect(html).toContain('思考强度');expect(html).not.toContain('<span>Temperature</span>');expect(html).toContain('type="password"');expect(html).toContain('autoComplete="new-password"');expect(html).not.toContain('value="secret');
 });
 it('separates Go identity headers and hides unverified reasoning knobs',()=>{
  const html=render({...fixture,config:{...fixture.config,providerPreset:'opencode-go',model:'glm-5.3'}});expect(html).toContain('OpenCode Go 专用请求头');expect(html).toContain('YatSenOccupationLeading/1.0');expect(html).toContain('x-opencode-session');expect(html).not.toContain('<span>思考强度</span>');expect(html).not.toContain('<span>Temperature</span>');
 });
 it('requires re-entry for an effective auto-protocol change and treats equivalent roots alike',()=>{
  const current={...fixture,config:{...fixture.config,providerPreset:'opencode-go' as const,model:'glm-5.3'}};
  current.presets=current.presets.map(preset=>preset.id==='opencode-go'?{...preset,models:[...preset.models,{id:'minimax-m3',protocol:'messages' as const,temperature:false,topP:false,samplingWithNoneOnly:false,reasoningEfforts:[]}]}:preset);
  expect(aiDestinationChanged(current,{...current.config,model:'minimax-m3'})).toBe(true);
  expect(aiDestinationChanged(current,{...current.config,baseUrl:'https://opencode.ai/zen/go/v1/'})).toBe(false);
 });
 it('warns and disables real-key save when encryption root is unavailable',()=>{
  const html=render({...fixture,encryptionAvailable:false});expect(html).toContain('安全加密根未配置');expect(html).toMatch(/<button[^>]*disabled=""[^>]*>保存 AI 配置/);
 });
 it('does not show secret-entry controls in environment/mock modes',()=>{
  for(const mode of ['environment','mock'] as const){const html=render({...fixture,config:{...fixture.config,mode}});expect(html).not.toContain('type="password"');expect(html).not.toContain('思考强度');}
 });
 it('treats unknown vendor model capabilities conservatively and custom protocol sampling explicitly',()=>{
  expect(aiFormCapabilities(fixture,{...fixture.config,model:'unknown'})).toMatchObject({temperature:false,topP:false,reasoningEfforts:[]});
  expect(aiFormCapabilities(fixture,{...fixture.config,providerPreset:'custom',model:'custom-model'})).toMatchObject({temperature:true,topP:true,reasoningEfforts:[]});
 });
});
