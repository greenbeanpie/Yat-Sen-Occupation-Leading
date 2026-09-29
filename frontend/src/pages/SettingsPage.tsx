import { useEffect, useState } from 'react';
import { Bell, BellOff, CloudDownload, RefreshCw, Trash2, WifiOff } from 'lucide-react';
import { del, get, post, put } from '../api/client';
import type { components } from '../api/schema';
import { Badge, DataRows, JsonPreview, Loading, PageHead, Panel, ResourceNotice, useResource } from '../components';
import type { ActionContext } from '../components';
import { cacheKey, cacheValue, clearOrphanedOperations, db, listUserConflicts, orphanedOperationCount, queueOperation, removeQueuedOperation, synchronizeUser, type SyncConflict } from '../offline';

type Settings = components['schemas']['UserSettingsResponse'];
type NotificationList = components['schemas']['NotificationListResponse'];
type SyncChanges = components['schemas']['SyncChangesResponse'];
type PushSubscription = components['schemas']['PushSubscription'];

export function SettingsPage({ context, pending }: { context: ActionContext; pending: number }) {
  const settings = useResource<Settings>('/notifications/settings', context.refresh, context.userId);
  const notifications = useResource<NotificationList>('/notifications', context.refresh, context.userId);
  const changes = useResource<SyncChanges>(`/sync/changes?since=${String(0)}&limit=100`, context.refresh, context.userId);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [notifyTaskDue, setNotifyTaskDue] = useState<boolean | null>(null);
  const [notifyInterview, setNotifyInterview] = useState<boolean | null>(null);
  const [timezone, setTimezone] = useState('');
  const [pushId, setPushId] = useState('');
  const [pushMessage, setPushMessage] = useState('');
  const [installAvailable, setInstallAvailable] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState('');
  const [orphanCount, setOrphanCount] = useState(0);

  useEffect(() => {
    void listUserConflicts(context.userId).then(setConflicts);
    void db.cache.get(cacheKey(context.userId, 'pushSubscriptionId')).then((row) => setPushId(String(row?.value ?? '')));
    void db.cache.get(cacheKey(context.userId, 'lastSync')).then((row) => setLastSyncedAt(String(row?.value ?? '')));
    void orphanedOperationCount().then(setOrphanCount);
    const handler = () => setInstallAvailable(true);
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [context.refresh, context.userId]);

  useEffect(() => {
    if (!settings.data) return;
    setNotifyTaskDue(settings.data.notifyTaskDue);
    setNotifyInterview(settings.data.notifyInterview);
    setTimezone(settings.data.timezone);
  }, [settings.data]);

  async function synchronize() {
    setSyncing(true);
    setSyncMessage('');
    try {
      const result = await synchronizeUser(context.userId);
      setConflicts(await listUserConflicts(context.userId));
      setLastSyncedAt(result.lastSyncedAt);
      setSyncMessage(`同步完成：${result.submitted} 项已提交，${result.pending} 项待提交，${result.conflicts} 项需处理。`);
      context.run(async () => undefined, '同步中心已更新');
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '同步失败；本地操作仍保留。');
    } finally {
      setSyncing(false);
    }
  }

  async function chooseServer(conflict: SyncConflict) {
    await removeQueuedOperation(conflict.op.opId);
    setConflicts(await listUserConflicts(context.userId));
    setSyncMessage('已采用服务端版本；本地操作已移除。');
    context.run(async () => undefined, '冲突已处理');
  }

  async function retryLocal(conflict: SyncConflict) {
    const serverVersion = recordVersion(conflict.serverRecord);
    if (serverVersion === null) {
      setSyncMessage('服务端没有可更新的记录版本。请复制本地内容并在页面中重新创建记录。');
      return;
    }
    await queueOperation({
      ...conflict.op,
      opId: undefined,
      baseVersion: serverVersion,
    });
    await db.conflicts.delete(conflict.op.opId);
    setConflicts(await listUserConflicts(context.userId));
    setSyncMessage('本地版本已保留，并使用服务端最新版本号重新排队。再次同步前请核对冲突内容。');
    context.run(async () => undefined, '本地版本已重新排队');
  }

  async function saveSettings() {
    if (notifyTaskDue === null || notifyInterview === null) return;
    await context.run(() => put('/notifications/settings', {
      timezone: timezone.trim() || 'Asia/Shanghai',
      notifyTaskDue,
      notifyInterview,
    }), '提醒设置已保存');
  }

  async function subscribePush() {
    setPushMessage('');
    try {
      if (!('Notification' in window) || !('serviceWorker' in navigator)) {
        throw new Error('当前浏览器不支持通知推送；站内提醒仍可使用。');
      }
      const { publicKey } = await get<components['schemas']['VapidPublicKey']>('/push-subscriptions/vapid-public-key');
      if (!publicKey) throw new Error('服务端未配置 VAPID 公钥；站内提醒仍可使用。');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('通知权限未获准；站内提醒仍可使用。');
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(publicKey).buffer as ArrayBuffer,
      });
      const saved = await post<PushSubscription>('/push-subscriptions', subscription.toJSON());
      setPushId(saved.id);
      await cacheValue(cacheKey(context.userId, 'pushSubscriptionId'), saved.id);
      setPushMessage('浏览器推送已订阅。实际送达取决于浏览器和服务端推送配置。');
    } catch (error) {
      setPushMessage(error instanceof Error ? error.message : '订阅失败。');
    }
  }

  async function unsubscribePush() {
    try {
      if (pushId) await del(`/push-subscriptions/${pushId}`);
      const registration = await navigator.serviceWorker?.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
      await db.cache.delete(cacheKey(context.userId, 'pushSubscriptionId'));
      setPushId('');
      setPushMessage('已取消浏览器推送订阅。');
    } catch (error) {
      setPushMessage(error instanceof Error ? error.message : '取消订阅失败。');
    }
  }

  async function markRead(id: string) {
    await context.run(() => post(`/notifications/${id}/read`), '提醒已标记为已读');
  }

  async function clearLocalQueue() {
    if (!window.confirm('清空本机待同步操作和冲突记录？未同步的本地修改将无法恢复。')) return;
    await db.queue.where('userId').equals(context.userId).delete();
    await db.conflicts.where('userId').equals(context.userId).delete();
    setConflicts([]);
    context.run(async () => undefined, '本机待同步操作已清空');
  }

  async function discardOrphanedOperations() {
    if (!window.confirm('这些操作来自旧版未按账号隔离的本机队列，无法安全确定所属账号。清除后不能恢复。')) return;
    await clearOrphanedOperations();
    setOrphanCount(0);
  }

  return <>
    <PageHead kicker="设置与数据" title="同步、提醒与离线状态" description="应用外壳由 Service Worker 缓存；简历文件和 API 响应不做全量缓存。离线编辑保存在本机，恢复网络后提交。"/>
    <div className="two-col">
      <Panel title="离线同步" description="每次操作有唯一 ID 和基础版本，重复提交不会重复写入">
        <div className="sync-overview">
          <div><strong>{pending}</strong><span>待提交</span></div>
          <div><strong>{conflicts.length}</strong><span>需处理冲突</span></div>
          <div><strong>{Number(changes.data?.cursor ?? 0)}</strong><span>同步游标</span></div>
        </div>
        <button className="btn primary" disabled={syncing} onClick={() => void synchronize()}><RefreshCw size={15} className={syncing ? 'spin' : ''}/>{syncing ? '同步中…' : '立即同步'}</button>
        <p className="muted">最后成功同步：{lastSyncedAt ? new Date(lastSyncedAt).toLocaleString('zh-CN') : '尚无成功记录'}</p>
        {syncMessage && <p className={syncMessage.includes('失败') || syncMessage.includes('拒绝') ? 'inline-error' : 'success-note'} role="status">{syncMessage}</p>}
        <ResourceNotice error={changes.error}/>
        <p className="muted">网络恢复、重新进入前台或点击同步后可以提交；操作回执和冲突版本由服务端返回。</p>
        <button className="btn small danger" onClick={() => void clearLocalQueue()}><Trash2 size={14}/>清空本机操作和冲突</button>
        {orphanCount > 0 && <p className="inline-error" role="status">检测到 {orphanCount} 条旧版离线数据，无法安全识别所属账号；这些数据已阻止同步。<button className="btn small danger" onClick={() => void discardOrphanedOperations()}>清除旧数据</button></p>}
      </Panel>

      <Panel title="提醒设置" description="站内提醒不需要浏览器权限；只有主动开启推送时才请求通知授权">
        <ResourceNotice error={settings.error}/>
        {settings.loading && !settings.data && <Loading/>}
        <label className="field"><span>用户时区</span><input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Asia/Shanghai"/></label>
        <label className="check-row"><input type="checkbox" checked={notifyTaskDue ?? false} onChange={(event) => setNotifyTaskDue(event.target.checked)}/><span>开启任务到期站内提醒</span></label>
        <label className="check-row"><input type="checkbox" checked={notifyInterview ?? false} onChange={(event) => setNotifyInterview(event.target.checked)}/><span>开启面试前站内提醒</span></label>
        <div className="button-row"><button className="btn primary" disabled={context.busy || notifyTaskDue === null || notifyInterview === null} onClick={() => void saveSettings()}>保存提醒设置</button></div>
        <div className="push-controls">
          <button className="btn secondary" disabled={pushId !== ''} onClick={() => void subscribePush()}><Bell size={15}/>开启浏览器推送</button>
          {pushId && <button className="btn secondary" onClick={() => void unsubscribePush()}><BellOff size={15}/>取消推送</button>}
        </div>
        {pushMessage && <p className="muted" role="status">{pushMessage}</p>}
      </Panel>
    </div>

    {conflicts.length > 0 && <Panel title="同步冲突" description="对照两份数据后选择保留服务端，或基于当前服务器版本重新提交本地操作">
      <DataRows items={conflicts.map((conflict) => ({ id: conflict.op.opId, conflict }))} empty="没有冲突。">
        {({ conflict }) => <ConflictCard conflict={conflict} onUseServer={() => void chooseServer(conflict)} onRetryLocal={() => void retryLocal(conflict)}/>}
      </DataRows>
    </Panel>}

    <div className="two-col">
      <Panel title="站内提醒" description={`${notifications.data?.unreadCount ?? '—'} 条未读`}>
        <ResourceNotice error={notifications.error}/>
        <DataRows items={notifications.data?.items ?? []} empty="暂无已发送的站内提醒。">
          {(notice) => <article className="notification-row">
            <div className="row-title">{notice.title}<Badge value={notice.readAt ? '已读' : notice.kind}/></div>
            <p>{notice.body}</p><small>{new Date(notice.fireAt).toLocaleString('zh-CN')}</small>
            {!notice.readAt && <button className="btn small secondary" onClick={() => void markRead(notice.id)}>标记已读</button>}
          </article>}
        </DataRows>
      </Panel>

      <Panel title="增量变更" description="用于显示最近从服务端同步的记录版本">
        <ResourceNotice error={changes.error}/>
        <DataRows items={changes.data?.changes ?? []} empty="尚无同步变更记录。">
          {(change) => <div className="row-main"><div className="row-title">{change.entity} · {change.changeType}<small>版本 {change.version} · {new Date(change.changedAt).toLocaleString('zh-CN')}</small></div></div>}
        </DataRows>
      </Panel>
    </div>

    <Panel title="安装与演示数据">
      <div className="install-row"><CloudDownload size={18}/><div><b>将工作台安装到设备</b><p>使用浏览器菜单中的“安装应用”。当前浏览器是否提供安装条件由其决定。</p></div></div>
      <div className="install-row"><WifiOff size={18}/><div><b>演示数据重置</b><p>当前 OpenAPI 没有重置演示数据接口。可退出并切换演示身份；本机队列可在此清理。</p></div></div>
      {installAvailable && <p className="success-note">浏览器已满足部分安装条件；请从浏览器菜单完成安装。</p>}
      <p className="muted">工作台使用虚构演示身份。浏览器推送需本地 VAPID 配置，Cloudflare 上线后还需 HTTPS。</p>
    </Panel>
  </>;
}

function ConflictCard({ conflict, onUseServer, onRetryLocal }: { conflict: SyncConflict; onUseServer: () => void; onRetryLocal: () => void }) {
  const serverVersion = recordVersion(conflict.serverRecord);
  return <article className="conflict-card">
    <div className="row-title">{conflict.op.entity} · {conflict.op.entityId}<Badge value={conflict.status}/></div>
    <p>{conflict.message} 本地基线版本：{conflict.op.baseVersion} · 服务端版本：{serverVersion ?? '记录不存在'}</p>
    <div className="conflict-columns"><div><b>本地修改</b><JsonPreview value={conflict.op.payload}/></div><div><b>服务端记录</b><JsonPreview value={conflict.serverRecord}/></div></div>
    <div className="button-row"><button className="btn secondary" onClick={onUseServer}>采用服务端版本</button>
      {serverVersion !== null && conflict.status === 'conflict' && <button className="btn primary" onClick={onRetryLocal}>保留并重新提交本地修改</button>}
    </div>
  </article>;
}

function recordVersion(record: unknown): number | null {
  if (!record || typeof record !== 'object') return null;
  const version = (record as { version?: unknown }).version;
  return typeof version === 'number' ? version : null;
}

function decodeVapidKey(key: string): Uint8Array {
  const normalized = key.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const bytes = atob(normalized + padding);
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}
