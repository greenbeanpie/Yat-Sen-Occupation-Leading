import { confirmDiscardSettings, useSettingsDirty } from './settings-dirty';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, get, patch, post } from '../api/client';
import { Panel } from '../components';

export function AccountSettings({ section = 'profile', demo, onRefreshSession, onSessionEnded }: {
  section?: 'profile' | 'security'; demo: boolean; onRefreshSession: () => Promise<void>; onSessionEnded: (message: string) => Promise<void>;
}) {
  const [account, setAccount] = useState<{ displayName: string; username: string | null } | null>(null);
  const [name, setName] = useState('');
  const [editingPassword, setEditingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const dirty = Boolean(account && name !== account.displayName) || Boolean(currentPassword || newPassword || confirm);
  useSettingsDirty(dirty);
  useEffect(() => {
    if (demo) return;
    let active = true;
    get<{ displayName: string; username: string | null }>('/session/account')
      .then(value => { if (active) { setAccount(value); setName(value.displayName); } })
      .catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : '账户设置加载失败'); });
    return () => { active = false; };
  }, [demo]);
  function clearPasswords() { setCurrentPassword(''); setNewPassword(''); setConfirm(''); }
  async function submit(event: FormEvent, password: boolean) {
    event.preventDefault();
    if (submitting.current) return;
    if (password && newPassword !== confirm) { setMessage('两次新密码不一致'); return; }
    submitting.current = true; setBusy(true); setMessage('');
    try {
      if (password) {
        await post('/session/password', { currentPassword, newPassword });
        clearPasswords();
        await onSessionEnded('密码已修改，所有设备均已退出，请使用新密码重新登录。');
      } else {
        await patch('/session/account', { displayName: name.trim() });
        setAccount(value => value && { ...value, displayName: name.trim() });
        await onRefreshSession(); setMessage('昵称已保存');
      }
    } catch (error) {
      clearPasswords();
      if (error instanceof ApiError && error.status === 401) await onSessionEnded('会话已失效，请重新登录。');
      else setMessage(error instanceof Error ? error.message : '保存失败，请重试');
    } finally { submitting.current = false; setBusy(false); }
  }
  return <Panel title={section === 'security' ? '账户安全' : '个人资料'} description={section === 'security' ? '管理账户密码' : '查看账户资料与修改昵称'}>
    {demo ? <p className="muted">演示与游客身份不能修改账户信息或密码。请登录个人账户使用此功能。</p> : <>
      {message && <p role="status">{message}</p>}
      {account && <>
        <p className="muted">用户名：{account.username ?? '未设置'}（不可修改）</p>
        {section === 'profile' && <form className="form-grid" onSubmit={event => void submit(event, false)}>
          <label className="field"><span>昵称</span><input required maxLength={64} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
          <div className="button-row"><button className="btn primary" disabled={busy || !name.trim()}>保存昵称</button><button type="button" className="btn secondary" disabled={busy} onClick={() => { if (confirmDiscardSettings(name !== account.displayName)) { setName(account.displayName); setMessage(''); } }}>取消昵称修改</button></div>
        </form>}
        {section === 'security' && (!editingPassword ? <button className="btn secondary" disabled={busy || !account.username} onClick={() => { setEditingPassword(true); setMessage(''); }}>修改密码</button> : <form className="form-grid" onSubmit={event => void submit(event, true)}>
          <p className="muted form-notice">新密码须为 12–128 位，包含大小写字母、数字和符号，且不同于原密码。修改成功后包括当前设备在内的所有会话都会退出。</p>
          <label className="field"><span>原密码</span><input type="password" autoComplete="current-password" required maxLength={128} disabled={busy} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></label>
          <label className="field"><span>新密码</span><input type="password" autoComplete="new-password" required minLength={12} maxLength={128} disabled={busy} value={newPassword} onChange={event => setNewPassword(event.target.value)} /></label>
          <label className="field"><span>确认新密码</span><input type="password" autoComplete="new-password" required maxLength={128} disabled={busy} value={confirm} onChange={event => setConfirm(event.target.value)} /></label>
          <div className="button-row"><button className="btn primary" disabled={busy}>确认修改密码</button><button type="button" className="btn secondary" disabled={busy} onClick={() => { if (confirmDiscardSettings(Boolean(currentPassword || newPassword || confirm))) { clearPasswords(); setEditingPassword(false); setMessage(''); } }}>取消修改密码</button></div>
        </form>)}
      </>}
    </>}
  </Panel>;
}
