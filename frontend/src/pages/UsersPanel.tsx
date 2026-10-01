import { useConfirmDiscardSettings, useSettingsDirty } from './settings-dirty';
import { useRef, useState, type FormEvent } from 'react';
import { patch, put } from '../api/client';
import type { components } from '../api/schema';
import { DataRows, InlineError, Modal, Panel, ResourceNotice, type ActionContext } from '../components';
import { canManageUser, roleLabel, roleOptions, type UserRole } from '../roles';
import { useAdminResource } from './admin-resource';

export type ManagedUser = components['schemas']['ManagedUser'];

type UserAction = { user: ManagedUser; kind: 'name' | 'role' | 'status' };

export function UsersPanel({ context, role, onRefreshSession }: {
  context: ActionContext;
  role: UserRole;
  onRefreshSession: () => Promise<void>;
}) {
  const [refresh, setRefresh] = useState(0);
  const users = useAdminResource<{ items: ManagedUser[] }>('/admin/users', context.userId, `${context.refresh}:${refresh}`);
  const [action, setAction] = useState<UserAction | null>(null);
  const confirmDiscardSettings = useConfirmDiscardSettings(`${context.userId}:${action?.user.id ?? ""}`);
  const [name, setName] = useState('');
  const [nextRole, setNextRole] = useState<UserRole>('student');
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const submitting = useRef(false);
  const dirty = Boolean(action && ((action.kind === 'name' && name !== action.user.displayName) || (action.kind === 'role' && nextRole !== action.user.role)));
  useSettingsDirty(dirty);
  async function cancel() { if (!submitting.current && await confirmDiscardSettings(dirty)) setAction(null); }
  const superAdmin = role === 'super_admin';
  const query = search.trim().toLocaleLowerCase();
  const items = (users.data?.items ?? []).filter(user => canManageUser(role, user.role))
    .filter(user => `${user.username ?? ''} ${user.displayName}`.toLocaleLowerCase().includes(query));

  function open(user: ManagedUser, kind: UserAction['kind']) {
    setAction({ user, kind }); setName(user.displayName); setNextRole(user.role); setError(''); setMessage('');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!action || submitting.current || !canManageUser(role, action.user.role)) return;
    if (action.kind === 'role' && !superAdmin) return;
    if (action.kind === 'status' && action.user.id === context.userId) return;
    submitting.current = true; setSaving(true); setError('');
    try {
      if (action.kind === 'role') {
        await put(`/admin/users/${action.user.id}/role`, { role: nextRole });
      } else {
        await patch(`/admin/users/${action.user.id}`, action.kind === 'name'
          ? { displayName: name.trim() }
          : { disabled: !action.user.disabled });
      }
      setMessage(action.kind === 'role' ? '用户角色已更新' : action.kind === 'name' ? '用户昵称已更新' : action.user.disabled ? '账户已启用' : '账户已停用');
      setAction(null);
      setRefresh(value => value + 1);
      if (action.user.id === context.userId) await onRefreshSession();
    } catch (value) {
      setError(value instanceof Error ? value.message : '用户信息保存失败，请重试。');
    } finally { submitting.current = false; setSaving(false); }
  }

  return <Panel title="用户管理" description={superAdmin
    ? '管理所有账户的昵称、启用状态与角色。仅超级管理员可以分配角色。'
    : '管理一般用户的昵称和启用状态。管理员账户与角色分配由超级管理员管理。'}>
    <ResourceNotice error={users.error}/>
    {users.error && <button className="btn small secondary" onClick={() => setRefresh(value => value + 1)}>重新加载用户</button>}
    {message && <p className="success-note" role="status">{message}</p>}
    {!action && error && <InlineError>{error}</InlineError>}
    <label className="field admin-user-search"><span>搜索用户</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="用户名或昵称"/></label>
    <DataRows items={items} loading={users.loading} empty={query ? '没有匹配的用户。' : '暂无可管理的用户。'}>
      {user => <UserManagementRow user={user} currentUserId={context.userId} actorRole={role} busy={saving || context.busy} onAction={kind => open(user, kind)}/>}
    </DataRows>
    {action && <Modal title={action.kind === 'name' ? '编辑用户昵称' : action.kind === 'role' ? '调整用户角色' : action.user.disabled ? '启用账户' : '停用账户'} onClose={cancel}>
      <p>{action.user.displayName} · {action.user.username ?? '未设置用户名'}</p>
      <form className="form-grid" onSubmit={event => void submit(event)}>
        {action.kind === 'name' && <label className="field"><span>昵称</span><input required maxLength={64} value={name} disabled={saving} onChange={event => setName(event.target.value)}/></label>}
        {action.kind === 'role' && <>
          <p className="muted form-notice">当前角色：{roleLabel(action.user.role)}。更改后该账户的管理权限将立即调整，页面可在刷新后显示最新角色。</p>
          <label className="field"><span>新角色</span><select value={nextRole} disabled={saving} onChange={event => setNextRole(event.target.value as UserRole)}>{roleOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          {action.user.id === context.userId && <p className="inline-error form-notice">这是你当前使用的账户。降低角色后，你将失去相应管理权限。</p>}
        </>}
        {action.kind === 'status' && <p className="muted form-notice">{action.user.disabled ? '启用后，该账户可重新登录。' : '停用后，该账户将无法登录，已有会话会失效。已有业务数据会保留。'}</p>}
        {error && <div className="form-notice"><InlineError>{error}</InlineError></div>}
        <div className="button-row form-notice">
          <button className={`btn ${action.kind === 'status' && !action.user.disabled ? 'danger' : 'primary'}`} disabled={saving || context.busy || (action.kind === 'name' && (!name.trim() || name.trim() === action.user.displayName)) || (action.kind === 'role' && nextRole === action.user.role)}>{saving ? '正在保存…' : action.kind === 'status' ? action.user.disabled ? '确认启用' : '确认停用' : '保存修改'}</button>
          <button className="btn secondary" type="button" disabled={saving} onClick={cancel}>取消</button>
        </div>
      </form>
    </Modal>}
  </Panel>;
}

export function UserManagementRow({ user, currentUserId, actorRole, busy, onAction }: {
  user: ManagedUser;
  currentUserId: string;
  actorRole: UserRole;
  busy: boolean;
  onAction: (kind: UserAction['kind']) => void;
}) {
  const canEdit = canManageUser(actorRole, user.role);
  return <article className="admin-user-row">
    <div className="row-main">
      <div className="row-title">{user.displayName}<span className="badge neutral">{roleLabel(user.role)}</span><span className={`badge ${user.disabled ? 'bad' : 'good'}`}>{user.disabled ? '已停用' : '已启用'}</span></div>
      <small>{user.username ?? '未设置用户名'}{user.id === currentUserId ? ' · 当前账户' : ''}</small>
    </div>
    {canEdit && <div className="button-row">
      <button className="btn small secondary" disabled={busy} onClick={() => onAction('name')}>编辑昵称</button>
      {actorRole === 'super_admin' && <button className="btn small secondary" disabled={busy} onClick={() => onAction('role')}>调整角色</button>}
      {user.id !== currentUserId && <button className={`btn small ${user.disabled ? 'secondary' : 'danger'}`} disabled={busy} onClick={() => onAction('status')}>{user.disabled ? '启用账户' : '停用账户'}</button>}
    </div>}
  </article>;
}
