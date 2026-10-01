import { usePageDialogs } from '../dialogs/usePageDialogs';
import { useEffect, useState } from 'react';
import { RefreshCw, Trash2, WifiOff } from 'lucide-react';
import { post } from '../api/client';
import { getActiveDataSource } from '../api/transport';
import type { components } from '../api/schema';
import { Badge, DataRows, JsonPreview, PageHead, Panel, ResourceNotice, useResource } from '../components';
import type { ActionContext } from '../components';
import { cacheKey, clearOrphanedOperations, db, listUserConflicts, orphanedOperationCount, queueOperation, removeQueuedOperation, synchronizeUser, type SyncConflict } from '../offline';
import { platform } from '../platform';

type SyncChanges = components['schemas']['SyncChangesResponse'];

export function SettingsPage({ context, pending }: { context: ActionContext; pending: number }) {
  const dialogs = usePageDialogs(context.userId);
  const changes = useResource<SyncChanges>(`/sync/changes?since=${String(0)}&limit=100`, context.refresh, context.userId);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState('');
  const [orphanCount, setOrphanCount] = useState(0);
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    void listUserConflicts(context.userId).then(setConflicts);
    void platform.storage.read<string>(cacheKey(context.userId, 'lastSync')).then((value) => setLastSyncedAt(value ? String(value) : ''));
    void orphanedOperationCount().then(setOrphanCount);
  }, [context.refresh, context.userId]);

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

  async function clearLocalQueue() {
    if (!await dialogs.confirm('清空本机待同步操作和冲突记录？未同步的本地修改将无法恢复。')) return;
    await db.queue.where('userId').equals(context.userId).delete();
    await db.conflicts.where('userId').equals(context.userId).delete();
    setConflicts([]);
    context.run(async () => undefined, '本机待同步操作已清空');
  }

  async function discardOrphanedOperations() {
    if (!await dialogs.confirm('这些操作来自旧版未按账号隔离的本机队列，无法安全确定所属账号。清除后不能恢复。')) return;
    await clearOrphanedOperations();
    setOrphanCount(0);
  }

  /** 服务端清空当前身份的业务数据，同时丢弃本机缓存，避免界面继续显示旧数据。 */
  async function resetDemoData() {
    if (!await dialogs.confirm('清空当前演示身份的业务数据？本机缓存和待同步操作也会一并清除，且无法恢复。')) return;
    setResetting(true);
    setResetMessage(null);
    try {
      const result = await post<components['schemas']['DemoResetResponse']>('/demo/reset');
      await db.queue.where('userId').equals(context.userId).delete();
      await db.conflicts.where('userId').equals(context.userId).delete();
      await db.cache.where('key').startsWith(`${context.userId}:`).delete();
      setConflicts([]);
      setLastSyncedAt('');
      setResetMessage({ kind: 'success', text: `已清空服务端 ${result.deletedRows} 条记录，并同步清理本机缓存。` });
      context.run(async () => undefined, '演示数据已重置');
    } catch (error) {
      setResetMessage({ kind: 'error', text: error instanceof Error ? error.message : '重置失败。' });
    } finally {
      setResetting(false);
    }
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


    </div>

    {conflicts.length > 0 && <Panel title="同步冲突" description="对照两份数据后选择保留服务端，或基于当前服务器版本重新提交本地操作">
      <DataRows items={conflicts.map((conflict) => ({ id: conflict.op.opId, conflict }))} empty="没有冲突。">
        {({ conflict }) => <ConflictCard conflict={conflict} onUseServer={() => void chooseServer(conflict)} onRetryLocal={() => void retryLocal(conflict)}/>}
      </DataRows>
    </Panel>}

    <div className="two-col">


      <Panel title="增量变更" description="用于显示最近从服务端同步的记录版本">
        <ResourceNotice error={changes.error}/>
        <DataRows items={changes.data?.changes ?? []} loading={changes.loading} empty="尚无同步变更记录。">
          {(change) => <div className="row-main"><div className="row-title">{change.entity} · {change.changeType}<small>版本 {change.version} · {new Date(change.changedAt).toLocaleString('zh-CN')}</small></div></div>}
        </DataRows>
      </Panel>
    </div>

    <Panel title="演示数据">
      <div className="install-row"><WifiOff size={18}/><div><b>演示数据重置</b><p>清空当前演示身份的画像、经历、私人岗位、投递、计划与同步记录；公共岗位库和其他演示身份不受影响。</p></div></div>
      <div className="button-row">
        <button className="btn small danger" disabled={context.busy || resetting} onClick={() => void resetDemoData()}>
          <Trash2 size={14}/>{resetting ? '正在重置…' : '重置我的演示数据'}
        </button>
      </div>
      {resetMessage && <p className={resetMessage.kind === 'error' ? 'inline-error' : 'success-note'} role="status">{resetMessage.text}</p>}
      <p className="muted">
        当前数据源：{getActiveDataSource() === 'guest' ? '游客临时演示适配器（本标签页，结束即清除）' : getActiveDataSource() === 'demo' ? '内置演示适配器（不请求后端）' : '后端 /api/v1'}。
        工作台使用虚构演示身份。安装和通知权限请使用各自的设置分类。
      </p>
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
