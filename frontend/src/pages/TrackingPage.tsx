import { useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, CalendarPlus, MessageSquareText, Trash2 } from 'lucide-react';
import { del, get, patch, post } from '../api/client';
import type { components } from '../api/schema';
import { ActionForm, Badge, DataRows, InlineError, Modal, PageHead, Panel, ResourceNotice, useResource } from '../components';
import type { ActionContext } from '../components';
import { cacheKey, cacheValue, readCached, withOfflineQueue } from '../offline';
import { CreationAttempt, createTrackedApplication } from '../application-creation';

type Application = components['schemas']['Application'];
type ApplicationEvent = components['schemas']['ApplicationEvent'];
type Interview = components['schemas']['Interview'];
type TimeEntry = components['schemas']['TimeEntry'];
type Stats = components['schemas']['EfficiencyStats'];

const STATUSES: { value: Application['status']; label: string }[] = [
  { value: 'preparing', label: '准备中' },
  { value: 'submitted', label: '已投递' },
  { value: 'interviewing', label: '面试中' },
  { value: 'offered', label: '已录用' },
  { value: 'rejected', label: '已拒绝' },
  { value: 'withdrawn', label: '已撤回' },
];

export function TrackingPage({ context }: { context: ActionContext }) {
  const range = useMemo(() => currentRange(), []);
  const [showArchived, setShowArchived] = useState(false);
  const creationAttempt = useRef(new CreationAttempt());
  const applications = useResource<{ items: Application[] }>('/applications', context.refresh, context.userId);
  const archives = useResource<{ items: Application[] }>('/applications?archived=true', context.refresh, context.userId);
  const timeEntries = useResource<{ items: TimeEntry[] }>(`/time-entries?from=${range.from}&to=${range.to}`, context.refresh, context.userId);
  const stats = useResource<Stats>(`/applications/stats?from=${range.from}&to=${range.to}`, context.refresh, context.userId);

  async function createApplication(values: Record<string, string>) {
    return creationAttempt.current.run((creationId) => context.run(() => createTrackedApplication(context.userId, creationId, {
      jobId: null,
      jobTitle: values.jobTitle.trim(),
      company: values.company.trim(),
      notes: values.notes.trim(),
      status: 'preparing',
    }), '投递记录已建立；离线新增已进入同步队列'));
  }

  async function createTimeEntry(values: Record<string, string>) {
    return context.run(() => post('/time-entries', {
      applicationId: values.applicationId || null,
      minutes: Number(values.minutes),
      spentOn: values.spentOn,
      note: values.note.trim() || null,
    }), '实际工时已记录');
  }

  const items = applications.data?.items ?? [];
  const archivedItems = archives.data?.items ?? [];
  const visibleApplications = showArchived ? archives : applications;
  const entries = timeEntries.data?.items ?? [];
  const efficiency = stats.data?.efficiency;

  return <>
    <PageHead kicker="投递跟踪" title="记录每次行动与反馈" description="手动维护投递状态、面试、反馈和工时。效率按所选时间范围的去重面试投递数 ÷ 实际工时 × 10 计算。"/>
    <div className="stats">
      <Stat label="获得面试的投递" value={stats.data?.interviewedCount ?? '—'} note={`${range.from} 至 ${range.to}`}/>
      <Stat label="实际投入" value={stats.data ? `${stats.data.totalHours.toFixed(1)} 小时` : '—'} note="按实际工时汇总"/>
      <Stat label="每 10 小时面试数" value={efficiency == null ? '暂无数据' : efficiency.toFixed(1)} note="零工时不计算效率"/>
      <Stat label="未归档的投递记录" value={items.length} note="归档记录保留在归档列表"/>
    </div>

    <div className="two-col">
      <Panel title="投递记录" description="归档后保留全部记录，可随时恢复">
        <div className="button-row application-tabs" role="group" aria-label="投递记录视图">
          <button className={`btn small ${showArchived ? 'secondary' : 'primary'}`} aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>未归档（{items.length}）</button>
          <button className={`btn small ${showArchived ? 'primary' : 'secondary'}`} aria-pressed={showArchived} onClick={() => setShowArchived(true)}>已归档（{archivedItems.length}）</button>
        </div>
        <ResourceNotice error={visibleApplications.error}/>
        {showArchived && <p className="muted">归档记录仅供查看，关联面试提醒已暂停，关联工时不计入效率统计。恢复后可继续编辑，仅恢复未到期的面试提醒，不补发过期提醒。</p>}
        <DataRows items={showArchived ? archivedItems : items} loading={visibleApplications.loading} empty={showArchived ? '暂无归档记录。归档的投递会保存在这里，可随时恢复。' : '目前没有投递记录。可以先添加职位，之后持续记录状态和反馈。'}>
          {(application) => <ApplicationCard application={application} context={context}/>}
        </DataRows>
      </Panel>

      <Panel title="新增投递和记录工时" description="零工时会显示暂无效率数据">
        <h3>新增投递</h3>
        <ActionForm
          disabled={context.busy}
          label="创建记录"
          onSubmit={createApplication}
          fields={[
            { name: 'jobTitle', label: '岗位名称', required: true },
            { name: 'company', label: '公司名称' },
            { name: 'notes', label: '备注', type: 'textarea', rows: 3 },
          ]}
        />
        <h3>添加实际工时</h3>
        <ActionForm
          disabled={context.busy}
          label="记录工时"
          onSubmit={createTimeEntry}
          fields={[
            { name: 'applicationId', label: '关联投递', options: [
              { value: '', label: '不关联投递' },
              ...items.map((application) => ({ value: application.id, label: `${application.company} · ${application.jobTitle}` })),
            ] },
            { name: 'minutes', label: '投入分钟', type: 'number', required: true, min: '1', max: '1440', step: '1' },
            { name: 'spentOn', label: '日期', type: 'date', required: true, initialValue: range.to },
            { name: 'note', label: '说明' },
          ]}
        />
      </Panel>
    </div>

    <Panel title="实际工时" description={`${range.from} 至 ${range.to} · 保留全部工时记录；关联已归档投递的工时不计入上方效率统计，未关联投递的工时仍计入。`}>
      <ResourceNotice error={timeEntries.error}/>
      <DataRows items={entries} loading={timeEntries.loading} empty="所选时间段还没有工时记录。">
        {(entry) => <div className="time-entry-row">
          <div><b>{entry.spentOn}</b><span>{entry.minutes} 分钟</span><small>{entry.note || '未填写说明'}</small></div>
          <button className="btn small danger" disabled={context.busy} onClick={() => void context.run(() => del(`/time-entries/${entry.id}`), '工时记录已删除')}><Trash2 size={14}/>删除</button>
        </div>}
      </DataRows>
    </Panel>
  </>;
}

export function ApplicationCard({ application, context }: { application: Application; context: ActionContext }) {
  const [showEvents, setShowEvents] = useState(false);
  const [events, setEvents] = useState<ApplicationEvent[]>([]);
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [error, setError] = useState('');
  const [when, setWhen] = useState('');
  const [stage, setStage] = useState('初试');
  const [location, setLocation] = useState('');
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archiveError, setArchiveError] = useState('');
  const [archivePending, setArchivePending] = useState(false);
  const archiveLock = useRef(false);
  const archived = application.deleted;

  async function changeArchive() {
    if (archiveLock.current) return;
    archiveLock.current = true;
    setArchivePending(true);
    setArchiveError('');
    try {
      const saved = await context.run(async () => {
        try {
          if (archived) await post(`/applications/${application.id}/restore`, { baseVersion: application.version });
          else await del(`/applications/${application.id}`);
        } catch (value) {
          setArchiveError(value instanceof Error ? value.message : `${archived ? '恢复' : '归档'}失败，请重试`);
          throw value;
        }
      }, archived ? '投递记录已恢复；仅恢复未到期的面试提醒' : '投递记录已归档，可在已归档列表恢复');
      if (saved) setConfirmingArchive(false);
    } finally {
      archiveLock.current = false;
      setArchivePending(false);
    }
  }

  async function loadHistory() {
    const open = !showEvents;
    setShowEvents(open);
    if (!open) return;
    try {
      const [eventResult, interviewResult] = await Promise.all([
        get<{ items: ApplicationEvent[] }>(`/applications/${application.id}/events`),
        get<{ items: Interview[] }>(`/applications/${application.id}/interviews`),
      ]);
      setEvents(eventResult.items);
      setInterviews(interviewResult.items);
      setError('');
    } catch (value) {
      setError(value instanceof Error ? value.message : '读取投递历史失败');
    }
  }

  async function changeStatus(status: Application['status']) {
    if (archived || status === application.status) return;
    await context.run(() => post(`/applications/${application.id}/events`, { type: 'status_change', toStatus: status }), '投递状态已更新');
  }

  async function scheduleInterview() {
    if (archived || !when) return;
    const scheduledAt = new Date(when).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const result = await context.run(() => post(`/applications/${application.id}/interviews`, {
      stage: stage.trim() || '面试',
      scheduledAt,
      locationOrLink: location.trim() || null,
    }), '面试已安排；到期提醒按用户设置执行');
    if (result) {
      setWhen('');
      if (showEvents) await loadHistory();
    }
  }

  async function saveNotes(values: Record<string, string>) {
    if (archived) return false;
    const payload = { notes: values.notes.trim() };
    return context.run(() => withOfflineQueue(
      () => patch(`/applications/${application.id}`, { ...payload, baseVersion: application.version }),
      { userId: context.userId, entity: 'application', entityId: application.id, baseVersion: application.version, action: 'upsert', payload },
      async () => {
        const key = cacheKey(context.userId, 'api:/applications');
        const cached = await readCached<{ items: Application[] }>(key);
        if (cached) await cacheValue(key, { items: cached.items.map((item) => item.id === application.id ? { ...item, ...payload, version: item.version + 1 } : item) });
      },
    ), '备注已保存；离线修改已进入同步队列');
  }

  async function addFeedback(values: Record<string, string>) {
    if (archived) return false;
    return context.run(() => post(`/applications/${application.id}/events`, { type: 'feedback', note: values.feedback.trim() }), '反馈已记录');
  }

  return <article className="application-card" aria-label={`${application.jobTitle}${archived ? '（已归档）' : ''}`}>
    <div className="row-title">{application.jobTitle}<Badge value={application.status}/>{archived && <span className="badge neutral">已归档</span>}</div>
    <p>{application.company || '公司未填写'}</p>
    {archived ? <p className="archived-notes">{application.notes || '未填写备注'}</p> : <ActionForm
      compact
      disabled={context.busy}
      label="保存备注"
      onSubmit={saveNotes}
      fields={[{ name: 'notes', label: '投递备注', type: 'textarea', rows: 2, initialValue: application.notes }]}
    />}
    <div className="button-row">
      {!archived && <label className="inline-field"><span>投递状态</span><select disabled={context.busy} value={application.status} onChange={(event) => void changeStatus(event.target.value as Application['status'])}>
        {STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
      </select></label>}
      <button className="btn small secondary" onClick={() => void loadHistory()}><MessageSquareText size={14}/>{showEvents ? '隐藏历史' : '状态历史 / 面试'}</button>
      {archived
        ? <button className="btn small primary" disabled={context.busy || archivePending} onClick={() => void changeArchive()}><ArchiveRestore size={14}/>{archivePending ? '正在恢复…' : '恢复投递'}</button>
        : <button className="btn small secondary" disabled={context.busy || archivePending} onClick={() => { setArchiveError(''); setConfirmingArchive(true); }}><Archive size={14}/>归档</button>}
    </div>
    {archived && archiveError && <InlineError>{archiveError}</InlineError>}
    {!archived && <><div className="interview-form">
      <label className="field"><span>面试阶段</span><input value={stage} onChange={(event) => setStage(event.target.value)} placeholder="初试、复试…"/></label>
      <label className="field"><span>面试时间</span><input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)}/></label>
      <label className="field"><span>地点或链接</span><input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="可选"/></label>
      <button className="btn small secondary" disabled={!when || context.busy} onClick={() => void scheduleInterview()}><CalendarPlus size={14}/>安排面试</button>
    </div>
    <ActionForm compact disabled={context.busy} label="记录反馈" onSubmit={addFeedback} fields={[{ name: 'feedback', label: '反馈内容', required: true, placeholder: '记录面试或投递反馈' }]}/></>}
    {error && <InlineError>{error}</InlineError>}
    {showEvents && <div className="history-grid">
      <section><h4>状态与反馈历史</h4>{events.length ? <ol className="event-list">{events.map((event) => <li key={event.id}>
        <span>{new Date(event.occurredAt).toLocaleString('zh-CN')}</span><b>{event.type === 'status_change' ? `${labelOf(event.fromStatus)} → ${labelOf(event.toStatus)}` : event.type === 'feedback' ? '反馈' : event.type}</b>{event.note && <p>{event.note}</p>}
      </li>)}</ol> : <p className="muted">暂无历史。</p>}</section>
      <section><h4>面试安排</h4>{interviews.length ? <ol className="event-list">{interviews.map((interview) => <li key={interview.id}>
        <b>{interview.stage}</b><span>{new Date(interview.scheduledAt).toLocaleString('zh-CN')}</span>{interview.locationOrLink && <small>{interview.locationOrLink}</small>}
        {archived ? <p>结果：{interview.result === 'passed' ? '通过' : interview.result === 'failed' ? '未通过' : '待定'}{interview.feedback && ` · ${interview.feedback}`}</p> : <InterviewResult interview={interview} context={context}/>}
      </li>)}</ol> : <p className="muted">暂无面试安排。</p>}</section>
    </div>}
    {confirmingArchive && <Modal title="归档这条投递？" onClose={() => { if (!archivePending) setConfirmingArchive(false); }}>
      <p>“{application.jobTitle}”会移到已归档列表。备注、状态历史、面试与工时都会保留，可随时恢复。</p>
      <p>归档后停止该投递的面试提醒，关联面试和工时不计入效率统计。恢复后仅恢复未到期的面试提醒，不补发过期提醒。</p>
      {archiveError && <InlineError>{archiveError}</InlineError>}
      <div className="button-row end">
        <button className="btn secondary" disabled={archivePending} onClick={() => setConfirmingArchive(false)}>取消</button>
        <button className="btn primary" disabled={context.busy || archivePending} onClick={() => void changeArchive()}>{archivePending ? '正在归档…' : '确认归档'}</button>
      </div>
    </Modal>}
  </article>;
}

function InterviewResult({ interview, context }: { interview: Interview; context: ActionContext }) {
  const [result, setResult] = useState<Interview['result']>(interview.result);
  const [feedback, setFeedback] = useState(interview.feedback ?? '');
  return <div className="interview-result">
    <select aria-label="面试结果" value={result} onChange={(event) => setResult(event.target.value as Interview['result'])}>
      <option value="pending">待定</option><option value="passed">通过</option><option value="failed">未通过</option>
    </select>
    <input aria-label="面试反馈" value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="面试反馈"/>
    <button className="btn small secondary" disabled={context.busy} onClick={() => void context.run(() => patch(`/interviews/${interview.id}`, { result, feedback: feedback.trim() || null, baseVersion: interview.version }), '面试结果已更新')}>保存结果</button>
  </div>;
}

function Stat({ label, value, note }: { label: string; value: string | number; note: string }) {
  return <div className="stat-card"><small>{label}</small><strong>{value}</strong><span>{note}</span></div>;
}

function labelOf(value: string | null | undefined) {
  return STATUSES.find((status) => status.value === value)?.label ?? '—';
}

function currentRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: ymd(first), to: ymd(now) };
}

function ymd(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
