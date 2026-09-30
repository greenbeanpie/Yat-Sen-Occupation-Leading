import { useEffect, useRef, useState, type FormEvent } from 'react';
import { put } from '../api/client';
import type { components } from '../api/schema';
import { InlineError, Loading, Panel, ResourceNotice, type ActionContext } from '../components';
import { useAdminResource } from './admin-resource';

type SystemSettings = components['schemas']['SystemSettings'];

export function SystemSettingsPanel({ context }: { context: ActionContext }) {
  const [refresh, setRefresh] = useState(0);
  const settings = useAdminResource<SystemSettings>('/admin/settings', context.userId, `${context.refresh}:${refresh}`);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const submitting = useRef(false);
  useEffect(() => {
    if (settings.data) setEnabled(settings.data.registrationEnabled);
  }, [settings.data]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !settings.data) return;
    submitting.current = true; setSaving(true); setError(''); setMessage('');
    try {
      await put('/admin/settings', { registrationEnabled: enabled });
      setMessage(enabled ? '已开放受邀注册，注册仍需有效邀请码。' : '已暂停新账户注册，已有账户仍可登录。');
      setRefresh(value => value + 1);
    } catch (value) { setError(value instanceof Error ? value.message : '系统设置保存失败，请重试。'); }
    finally { submitting.current = false; setSaving(false); }
  }

  return <Panel title="系统设置" description="仅超级管理员可修改。注册开关控制新账户注册，不影响已有账户登录，也不取消邀请码要求。">
    <ResourceNotice error={settings.error}/>
    {settings.error && <button className="btn small secondary" onClick={() => setRefresh(value => value + 1)}>重新加载设置</button>}
    {settings.loading && <Loading/>}
    {message && <p className="success-note" role="status">{message}</p>}
    {error && <InlineError>{error}</InlineError>}
    {settings.data && <form onSubmit={event => void save(event)}>
      <label className="admin-registration-toggle"><input type="checkbox" checked={enabled} disabled={saving || context.busy} onChange={event => setEnabled(event.target.checked)}/><span>允许受邀注册新账户</span></label>
      <p className="muted">当前状态：{settings.data.registrationEnabled ? '受邀注册已开放' : '新账户注册已暂停'}</p>
      <button className="btn primary" disabled={saving || context.busy || enabled === settings.data.registrationEnabled}>{saving ? '正在保存…' : '保存注册设置'}</button>
    </form>}
  </Panel>;
}
