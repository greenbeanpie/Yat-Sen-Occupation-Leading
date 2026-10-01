import { aiFormCapabilities } from './ai-settings-form';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { put } from '../api/client';
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
  return <Panel title="AI 模型配置" description="仅超级管理员可修改。网页配置对后续非演示任务生效；演示账户始终使用 mock。保存不会试调用模型。">
    <ResourceNotice error={settings.error}/>
    {settings.loading && <Loading/>}
    {message && <p className="success-note" role="status">{message}</p>}
    {settings.error && <button className="btn secondary" onClick={() => setRefresh(value => value + 1)}>重新加载 AI 配置</button>}
    {settings.data && <AiSettingsEditor key={`${context.userId}:${settings.data.version}`} settings={settings.data} busy={context.busy}
      onSave={async input => { await put<Settings>('/admin/ai-settings', input); if (!active.current) return; setMessage('AI 配置已保存。未发出测试请求；真实调用仍受密钥状态、模型能力和额度限制。'); setRefresh(value => value + 1); }}
      onReload={() => { setMessage(''); setRefresh(value => value + 1); }}/>} 
  </Panel>;
}

export function AiSettingsEditor({ settings, busy, onSave, onReload }: { settings: Settings; busy: boolean; onSave: (input: Write) => Promise<void>; onReload: () => void }) {
  const [config, setConfig] = useState<Config>(() => structuredClone(settings.config));
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const capabilities = aiFormCapabilities(settings, config);
  const preset = settings.presets.find(item => item.id === config.providerPreset);
  const disabled = saving || busy;
  const destinationChanged = config.providerPreset !== settings.config.providerPreset || config.protocol !== settings.config.protocol || config.baseUrl !== settings.config.baseUrl;
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
    if (config.mode === 'real' && !clearApiKey && !apiKey && (destinationChanged || settings.credentialStatus !== 'stored')) { setError('请为当前供应商、协议和 API 根地址重新输入密钥。'); return; }
    submitting.current = true; setSaving(true); setError('');
    const input: Write = { baseVersion: settings.version, config: { ...config, requestHeaders: Object.fromEntries(Object.entries(config.requestHeaders).filter(([,value]) => value.trim())) }, ...(apiKey ? { apiKey } : {}), ...(clearApiKey ? { clearApiKey: true } : {}) };
    setApiKey('');
    try { await onSave(input); }
    catch (value) { if (active.current) setError(value instanceof Error ? value.message : '保存失败，请重试。'); }
    finally { submitting.current = false; if (active.current) setSaving(false); }
  }
  return <form className="ai-settings-form" onSubmit={event => void save(event)} autoComplete="off">
    <div className="ai-settings-status"><span>版本 {settings.version}</span><span>{credentialLabels[settings.credentialStatus]}</span></div>
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
    <div className="button-row"><button className="btn primary" disabled={disabled || (config.mode === 'real' && (!accepted || (!settings.encryptionAvailable && !clearApiKey)))}>{saving ? '正在加密保存…' : '保存 AI 配置'}</button><button type="button" className="btn secondary" disabled={saving} onClick={() => { setApiKey(''); onReload(); }}>取消修改 / 重新加载</button></div>
  </form>;
}
