import { useEffect, useState } from 'react';
import { del, get, post } from '../api/client';
import { InlineError, Panel } from '../components';
import type { ActionContext } from '../components';

interface Invitation { id: string; expiresAt: string; consumedAt: string | null; revokedAt: string | null }
export function InvitationsPanel({ context }: { context: ActionContext }) {
  const [items, setItems] = useState<Invitation[]>([]);
  const [created, setCreated] = useState<{ invitationCode: string; expiresAt: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    // Administrative data and plaintext invitation codes never enter offline storage.
    get<{ items: Invitation[] }>('/admin/invitations').then(value => {
      if (active) { setItems(value.items); setError(''); }
    }).catch(value => { if (active) setError(value instanceof Error ? value.message : '无法读取邀请码'); });
    return () => { active = false; };
  }, [context.userId, refresh]);
  async function create() {
    setBusy(true); setError(''); setCreated(null);
    try {
      setCreated(await post('/admin/invitations', {}));
      setRefresh(value => value + 1);
    } catch (value) { setError(value instanceof Error ? value.message : '无法创建邀请码'); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true); setError('');
    try { await del(`/admin/invitations/${id}`); setRefresh(value => value + 1); }
    catch (value) { setError(value instanceof Error ? value.message : '无法撤销邀请码'); }
    finally { setBusy(false); }
  }
  return <Panel title="邀请注册" description="每个邀请码只能注册一个学生账户，与邮箱无关。默认 24 小时有效，最近 100 条记录；明文仅创建时显示，离开此页面后无法重取。">
    {error && <InlineError>{error}</InlineError>}
    <button className="btn primary" disabled={busy || context.busy} onClick={() => void create()}>创建邀请码</button>
    {created && <div role="status"><p>请通过可信渠道发送给受邀人：</p><code>{created.invitationCode}</code><p>到期：{new Date(created.expiresAt).toLocaleString()}</p><button className="btn secondary" onClick={() => setCreated(null)}>隐藏明文</button></div>}
    {items.map(item => <div className="button-row" key={item.id}>
      <small>{item.id.slice(0, 8)} · 到期 {new Date(item.expiresAt).toLocaleString()} · {item.consumedAt ? '已使用' : item.revokedAt ? '已撤销' : Date.parse(item.expiresAt) <= Date.now() ? '已过期' : '待使用'}</small>
      {!item.consumedAt && !item.revokedAt && Date.parse(item.expiresAt) > Date.now() && <button className="btn small secondary" disabled={busy} onClick={() => void revoke(item.id)}>撤销</button>}
    </div>)}
  </Panel>;
}
