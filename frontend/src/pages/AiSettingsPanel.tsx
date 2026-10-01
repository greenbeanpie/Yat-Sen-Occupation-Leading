import { useSettingsDirty } from './settings-dirty';
import { aiDestinationChanged, aiFormCapabilities } from './ai-settings-form';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { get, post, put } from '../api/client';
import { createAiProbeRunner, type AiProbeReport } from './ai-settings-probe';
import type { components } from '../api/schema';
import { InlineError, Loading, Panel, ResourceNotice, type ActionContext } from '../components';
import { useAdminResource } from './admin-resource';

type Settings = components['schemas']['AiSettingsResponse'];
type Config = components['schemas']['AiSettingsConfig'];
type Write = components['schemas']['AiSettingsWrite'];
const protocolLabels: Record<Config['protocol'], string> = { auto: '自动（按供应商 / 模型）', 'chat-completions': 'OpenAI Compatible · Chat Completions', responses: 'Responses', messages: 'Anthropic · Messages', 'generate-content': 'Gemini · GenerateContent' };
const credentialLabels: Record<Settings['credentialStatus'], string> = { environment: '沿用运维环境配置，网页未读取密钥', 'not-required': '模拟模式不会调用真实模型', missing: '未保存密钥，真实调用已禁用', stored: '已加密保存，密钥不会回填', unreadable: '密钥无法解密或绑定已失效，请重新输入' };

export function AiSettingsPanel({ context }: { context: ActionContext }) {
  const [refresh, setRefresh] = useState(0);
  const settings = useAdminResource<Settings>('/admin/ai-settings', context.userId, `${context.refresh}:${refresh}`);
  const [message, setMessage] = useState('');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  return <Panel title="AI 配置 · 统一模型" description="仅超级管理员可修改。网页配置对后续非演示任务生效；演示账户始终使用 mock。保存不会试调用模型。">
    <ResourceNotice error={settings.error}/>
    {settings.loading && <Loading/>}
    {message && <p className="success-note" role="status">{message}</p>}
    {settings.error && <button className="btn secondary" onClick={() => setRefresh(value => value + 1)}>重新加载 AI 配置</button>}
    {settings.data && <AiSettingsEditor key={`${context.userId}:${settings.data.version}`} settings={settings.data} busy={context.busy}
      onSave={async input => { const updated = await put<Settings>('/admin/ai-settings', input); if (!active.current) return updated; setMessage('AI 配置已保存。未发出测试请求；真实调用仍受密钥状态、模型能力和额度限制。'); setRefresh(value => value + 1); return updated; }}
      onReload={() => { setMessage(''); setRefresh(value => value + 1); }}/>} 
  </Panel>;
}

export function AiSettingsEditor({ settings, busy, onSave, onReload }: { settings: Settings; busy: boolean; onSave: (input: Write) => Promise<Settings|void>; onReload: () => void }) {
  const [savedSettings, setSavedSettings] = useState(settings);
  const [config, setConfig] = useState<Config>(() => structuredClone(settings.config));
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testReport, setTestReport] = useState<AiProbeReport|null>(null);
  const [testError, setTestError] = useState('');
  const probe = useRef(createAiProbeRunner(body=>post<AiProbeReport>('/admin/ai-settings/test',body)));
  const [logs, setLogs] = useState<components['schemas']['AiDiagnosticsResponse']|null>(null);
  const [logsError, setLogsError] = useState('');
  const [loadingLogs, setLoadingLogs] = useState(false);
  const submitting = useRef(false);
  useSettingsDirty(JSON.stringify(config) !== JSON.stringify(settings.config) || Boolean(apiKey) || clearApiKey);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const capabilities = aiFormCapabilities(savedSettings, config);
  const preset = savedSettings.presets.find(item => item.id === config.providerPreset);
  const disabled = saving || busy || testing;
  const destinationChanged = aiDestinationChanged(savedSettings, config);
  async function readLogs(beforeSeq?: number) {
    if (loadingLogs) return;
    setLoadingLogs(true); setLogsError('');
    try { const next = await get<components['schemas']['AiDiagnosticsResponse']>(`/admin/ai-settings/logs${beforeSeq?`?beforeSeq=${beforeSeq}`:''}`); if(active.current)setLogs(current=>beforeSeq&&current?{...next,items:[...current.items,...next.items]}:next); }
    catch(value){if(active.current)setLogsError(value instanceof Error?value.message:'读取诊断日志失败，请稍后重试');}
    finally{if(active.current)setLoadingLogs(false);}
  }
  async function testSaved() {
    if (submitting.current || busy || probe.current.pending) return;
    setTesting(true); setTestReport(null); setTestError('');
    try { const report = await probe.current.run(savedSettings.version); if(active.current)setTestReport(report); }
    catch(value){if(active.current)setTestError(value instanceof Error?value.message:'测试请求未完成，请检查服务状态');}
    finally{if(active.current){setTesting(false);void readLogs();}}
  }
  function update(values: Partial<Config>) { setConfig(current => ({ ...current, ...values })); setAccepted(false); }
  function changePreset(value: Config['providerPreset']) {
    const next = settings.presets.find(item => item.id === value);
    update({ providerPreset: value, protocol: 'auto', baseUrl: '', model: next?.models[0]?.id ?? '', reasoningEffort: 'default', thinkingBudget: null, temperature: null, topP: null, requestHeaders: {} });
    setApiKey(''); setClearApiKey(false);
  }
  function changeModel(value: string) { update({ model: value, reasoningEffort: 'default', thinkingBudget: null, temperature: null, topP: null }); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || disabled || (config.mode === 'real' && !accepted)) return;
    if (config.mode === 'real' && !clearApiKey && !apiKey && (destinationChanged || savedSettings.credentialStatus !== 'stored')) { setError('请为当前供应商、协议和 API 根地址重新输入密钥。'); return; }
    submitting.current = true; setSaving(true); setError('');
    const input: Write = { baseVersion: savedSettings.version, config: { ...config, requestHeaders: Object.fromEntries(Object.entries(config.requestHeaders).filter(([,value]) => value.trim())) }, ...(apiKey ? { apiKey } : {}), ...(clearApiKey ? { clearApiKey: true } : {}) };
    setApiKey('');
    try { const updated = await onSave(input); if(active.current&&updated){setSavedSettings(updated);setConfig(updated.config);setClearApiKey(false);setTestReport(null);} }
    catch (value) { if (active.current) setError(value instanceof Error ? value.message : '保存失败，请重试。'); }
    finally { submitting.current = false; if (active.current) setSaving(false); }
  }
  return <form className="ai-settings-form" onSubmit={event => void save(event)} autoComplete="off">
    <p className="muted">统一模型：文档解析、岗位要求提取、匹配分析、行动计划、简历改写和招聘公告提取共用这一套端点、协议、模型及参数。每次操作读取已保存配置；演示账户仍使用 mock。</p>
    <p className="muted">当前仅支持文本输入，不提供图像识别或图像模型路由。能力不足或调用失败时不会自动改用其他端点；请由管理员核对所选模型的能力。</p>
    <div className="ai-settings-status"><span>版本 {savedSettings.version}</span><span>{credentialLabels[savedSettings.credentialStatus]}</span></div>
    <label className="field"><span>配置来源</span><select value={config.mode} disabled={disabled} onChange={event => update({ mode: event.target.value as Config['mode'] })}>
      <option value="environment">沿用部署环境配置</option><option value="mock">仅模拟（mock）</option><option value="real">网页真实模型配置</option>
    </select></label>
    {config.mode === 'environment' && <p className="muted">保留原有环境配置与密钥。切换到网页真实模型时，需要自行输入新的目标服务密钥，不会自动沿用部署密钥。</p>}
    {config.mode === 'real' && <>
      <div className="form-grid">
        <label className="field"><span>供应商预设</span><select value={config.providerPreset} disabled={disabled} onChange={event => changePreset(event.target.value as Config['providerPreset'])}>{settings.presets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="field"><span>请求协议（可独立选择）</span><select value={config.protocol} disabled={disabled} onChange={event => update({ protocol: event.target.value as Config['protocol'], temperature: null, topP: null })}>{Object.entries(protocolLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field full"><span>API 根地址</span><input type="url" value={config.baseUrl} placeholder={preset?.baseUrl || 'https://your-approved-gateway/v1'} disabled={disabled} maxLength={500} onChange={event => update({ baseUrl: event.target.value })}/><small>留空使用预设根地址；不含 /responses、/messages 或 /chat/completions。自定义域名需运维加入 AI_ALLOWED_HOSTS。</small></label>
        <label className="field full"><span>模型 ID</span><input value={config.model} list="ai-model-presets" required maxLength={200} disabled={disabled} onChange={event => changeModel(event.target.value)}/><datalist id="ai-model-presets">{preset?.models.map(model => <option key={model.id} value={model.id}/>)}</datalist><small>可手动输入模型；未核对的供应商模型不提供推理/采样选项。自定义协议允许标准采样，需自行核对服务兼容性。未知 Go/Zen 模型必须手动选择协议。</small></label>
        {capabilities.reasoningEfforts.length > 0 && <label className="field"><span>思考强度</span><select value={config.reasoningEffort} disabled={disabled} onChange={event => update({ reasoningEffort: event.target.value as Config['reasoningEffort'], temperature: null, topP: null })}><option value="default">供应商默认（不发送该参数）</option>{capabilities.reasoningEfforts.map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
        {capabilities.thinkingBudget && <label className="field"><span>思考 token 预算（Gemini 2.5）</span><input type="number" min={config.model === 'gemini-2.5-pro' ? 128 : 0} max={config.maxOutputTokens - 1} step={1} value={config.thinkingBudget ?? ''} disabled={disabled} placeholder="供应商默认" onChange={event => update({ thinkingBudget: event.target.value === '' ? null : Number(event.target.value) })}/></label>}
        {capabilities.temperature && <label className="field"><span>Temperature</span><input type="number" min={0} max={config.protocol === 'messages' ? 1 : 2} step="0.1" value={config.temperature ?? ''} disabled={disabled} placeholder="默认" onChange={event => update({ temperature: event.target.value === '' ? null : Number(event.target.value) })}/></label>}
        {capabilities.topP && <label className="field"><span>Top P</span><input type="number" min={config.providerPreset === 'deepseek' ? 0.95 : 0} max={1} step="0.01" value={config.topP ?? ''} disabled={disabled} placeholder="默认" onChange={event => update({ topP: event.target.value === '' ? null : Number(event.target.value) })}/></label>}
        <label className="field"><span>最大输出 tokens（按供应商协议）</span><input type="number" min={1} max={4096} step={1} required value={config.maxOutputTokens} disabled={disabled} onChange={event => update({ maxOutputTokens: Number(event.target.value) })}/></label>
        <label className="field"><span>超时（毫秒）</span><input type="number" min={1000} max={60000} step={1000} required value={config.timeoutMs} disabled={disabled} onChange={event => update({ timeoutMs: Number(event.target.value) })}/></label>
        <label className="field"><span>最大请求次数（含首次）</span><input type="number" min={1} max={3} step={1} required value={config.maxAttempts} disabled={disabled} onChange={event => update({ maxAttempts: Number(event.target.value) })}/></label>
      </div>
      {!capabilities.reasoningEfforts.length && !capabilities.thinkingBudget && <p className="muted">此供应商/模型没有已验证的思考控制，使用供应商默认。任务自身更严格的限制仍有效；输出 token 上限不等于金额上限，部分服务另计思考 token。</p>}
      {config.providerPreset === 'opencode-go' && <fieldset className="ai-settings-headers"><legend>OpenCode Go 专用请求头</legend>
        <p className="muted">Go 面向 coding agents。已知用途风险不等于厂商确认此业务符合套餐；不伪装官方客户端、不自动切换其他余额。</p>
        <label className="field"><span>User-Agent（真实应用身份）</span><input value={config.goUserAgent} pattern="YatSenOccupationLeading/[A-Za-z0-9._-]{1,32}" required disabled={disabled} onChange={event => update({ goUserAgent: event.target.value })}/></label>
        <p className="muted">x-opencode-session：每个独立会话自动生成，同一会话及重试保持稳定。认证头由系统生成，不能覆盖 Authorization、Cookie 或 Host。</p>
      </fieldset>}
      {config.providerPreset === 'openrouter' && <fieldset className="ai-settings-headers"><legend>OpenRouter 公开应用归属（可选）</legend>
        <div className="form-grid"><label className="field"><span>HTTP-Referer</span><input type="url" value={config.requestHeaders['HTTP-Referer'] ?? ''} placeholder="https://your-public-app" disabled={disabled} onChange={event => update({ requestHeaders: { ...config.requestHeaders, 'HTTP-Referer': event.target.value } })}/></label>
        <label className="field"><span>X-OpenRouter-Title</span><input maxLength={200} value={config.requestHeaders['X-OpenRouter-Title'] ?? ''} disabled={disabled} onChange={event => update({ requestHeaders: { ...config.requestHeaders, 'X-OpenRouter-Title': event.target.value } })}/></label></div>
      </fieldset>}
      <fieldset className="ai-settings-headers"><legend>服务密钥</legend>
        <p className="muted">仅在 HTTPS 下提交到本站后端，加密后保存在数据库。读取配置不返回密钥。更换供应商、协议或根地址须重新输入；部署根密钥轮换后也可能需要重填。</p>
        {!settings.encryptionAvailable && <InlineError>安全加密根未配置，暂不能保存真实模型密钥。请联系运维，不会以明文保存。</InlineError>}
        <label className="field"><span>{destinationChanged || settings.credentialStatus !== 'stored' ? '当前目标服务 API key' : '更换 API key（留空保留）'}</span><input type="password" autoComplete="new-password" name="ai-provider-key" value={apiKey} disabled={disabled || clearApiKey || !settings.encryptionAvailable} minLength={8} maxLength={4096} onChange={event => { setApiKey(event.target.value); setAccepted(false); }}/></label>
        <label className="admin-registration-toggle"><input type="checkbox" checked={clearApiKey} disabled={disabled} onChange={event => { setClearApiKey(event.target.checked); setApiKey(''); setAccepted(false); }}/><span>清除网页保存的密钥，禁用网页真实调用</span></label>
      </fieldset>
      <label className="admin-registration-toggle"><input type="checkbox" required checked={accepted} disabled={disabled} onChange={event => setAccepted(event.target.checked)}/><span>我已核对目标服务、密钥和使用费用；保存后允许后续非演示任务发送相关业务内容</span></label>
    </>}
    {error && <InlineError>{error}</InlineError>}
    <div className="button-row"><button className="btn primary" disabled={disabled || (config.mode === 'real' && (!accepted || (!settings.encryptionAvailable && !clearApiKey)))}>{saving ? '正在加密保存…' : '保存 AI 配置'}</button><button type="button" className="btn secondary" disabled={disabled} onClick={() => void testSaved()}>{testing?'正在测试已保存配置…':'测试已保存配置'}</button><button type="button" className="btn secondary" disabled={saving||testing} onClick={() => { setApiKey(''); onReload(); }}>取消修改 / 重新加载</button></div>
    <p className="muted">测试仅使用已保存的版本 {savedSettings.version}，不会保存或发送本页未保存修改、密钥输入和个人资料。一次模型请求，使用已保存的超时与输出上限（最高 4096 tokens），可能消耗少量额度；不会自动重试。仅验证连接与基本文本响应，测试失败不阻止保存，本次测试超时不代表配置无效。</p>
    {testError&&<InlineError>{testError}</InlineError>}
    {testReport&&<div role="status"><p>{testReport.status==='passed'?'连接与基本响应测试通过':testReport.status==='not_run'?'未发起真实模型测试':'本次测试未通过'} · 配置版本 {testReport.version}</p><p>本次上限：{testReport.limits.timeoutMs/1000} 秒 / {testReport.limits.maxOutputTokens} 输出 tokens / 1 次请求</p>{testReport.error&&<p>{testReport.error.message}</p>}{testReport.checks.map(check=><p key={check.name}>{check.detail}</p>)}</div>}
    <details><summary>服务端 AI 诊断日志（仅超级管理员）</summary><p className="muted">仅记录请求编号、阶段、耗时、HTTP 状态和固定错误代码，不记录密钥、请求正文、模型答复或个人资料。最多保留最近 1000 条且 1,000,000 UTF-8 字节。</p><button type="button" className="btn secondary" disabled={loadingLogs} onClick={()=>void readLogs()}>{loadingLogs?'正在读取…':'读取最新诊断日志'}</button>{logsError&&<InlineError>{logsError}</InlineError>}{logs&&<><p>保留 {logs.retainedCount} 条 / {logs.retainedBytes} 字节</p><ul>{logs.items.map(item=><li key={item.seq}>{item.event.time} · {item.event.requestId} · {item.event.stage} · {item.event.code} · {item.event.elapsedMs}ms · HTTP {item.event.httpStatus??'未收到'} · {item.event.provider}/{item.event.model}/{item.event.protocol}</li>)}</ul>{!logs.items.length&&<p>暂无诊断日志。请主动点击测试或执行已授权的 AI 操作后再刷新。</p>}{logs.nextBeforeSeq&&<button type="button" className="btn secondary" disabled={loadingLogs} onClick={()=>void readLogs(logs.nextBeforeSeq!)}>读取较早记录</button>}</>}</details>
  </form>;
}
