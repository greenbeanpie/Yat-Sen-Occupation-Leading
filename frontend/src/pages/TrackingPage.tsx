import { useMemo, useState } from 'react';
import { CalendarPlus, MessageSquareText, Trash2 } from 'lucide-react';
import { del, get, patch, post } from '../api/client';
import type { components } from '../api/schema';
import { ActionForm, Badge, DataRows, InlineError, PageHead, Panel, ResourceNotice, useResource } from '../components';
import type { ActionContext } from '../components';
import { cacheKey, cacheValue, readCached, withOfflineQueue } from '../offline';

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
  const applications = useResource<{ items: Application[] }>('/applications', context.refresh, context.userId);
  const timeEntries = useResource<{ items: TimeEntry[] }>(`/time-entries?from=${range.from}&to=${range.to}`, context.refresh, context.userId);
  const stats = useResource<Stats>(`/applications/stats?from=${range.from}&to=${range.to}`, context.refresh, context.userId);

  async function createApplication(values: Record<string, string>) {
    const payload = {
      jobId: null,
      jobTitle: values.jobTitle.trim(),
      company: values.company.trim(),
      notes: values.notes.trim(),
      status: 'preparing',
    };
    const localId = crypto.randomUUID();
    return context.run(() => withOfflineQueue(
      () => post('/applications', payload),
      { userId: context.userId, entity: 'application', entityId: localId, baseVersion: 0, action: 'upsert', payload },
      async () => {
        const now = new Date().toISOString();
        const local: Application = {
          id: localId, version: 0, deleted: false, userId: context.userId, createdAt: now, updatedAt: now,
          jobTitle: payload.jobTitle, company: payload.company,
          status: 'preparing', notes: payload.notes,
        };
        const key = cacheKey(context.userId, 'api:/applications');
        const cached = await readCached<{ items: Application[] }>(key);
        await cacheValue(key, { items: [local, ...(cached?.items ?? [])] });
      },
    ), '投递记录已建立；离线新增已进入同步队列');
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
  const entries = timeEntries.data?.items ?? [];
  const efficiency = stats.data?.efficiency;

  return <>
    <PageHead kicker="投递跟踪" title="记录每次行动与反馈" description="手动维护投递状态、面试、反馈和工时。效率按所选时间范围的去重面试投递数 ÷ 实际工时 × 10 计算。"/>
    <div className="stats">
      <Stat label="获得面试的投递" value={stats.data?.interviewedCount ?? '—'} note={`${range.from} 至 ${range.to}`}/>
      <Stat label="实际投入" value={stats.data ? `${stats.data.totalHours.toFixed(1)} 小时` : '—'} note="按实际工时汇总"/>
      <Stat label="每 10 小时面试数" value={efficiency == null ? '暂无数据' : efficiency.toFixed(1)} note="零工时不计算效率"/>
      <Stat label="投递记录" value={items.length} note="包含准备中与已投递"/>
    </div>

    <div className="two-col">
      <Panel title="投递记录" description="状态变化由服务端状态机校验并保留历史">
        <ResourceNotice error={applications.error}/>

        <DataRows items={items} loading={applications.loading} empty="目前没有投递记录。可以先添加职位，之后持续记录状态和反馈。">
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

    <Panel title="实际工时" description={`${range.from} 至 ${range.to}`}>
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

function ApplicationCard({ application, context }: { application: Application; context: ActionContext }) {
  const [showEvents, setShowEvents] = useState(false);
  const [events, setEvents] = useState<ApplicationEvent[]>([]);
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [error, setError] = useState('');
  const [when, setWhen] = useState('');
  const [stage, setStage] = useState('初试');
  const [location, setLocation] = useState('');

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
    if (status === application.status) return;
    await context.run(() => post(`/applications/${application.id}/events`, { type: 'status_change', toStatus: status }), '投递状态已更新');
  }

  async function scheduleInterview() {
    if (!when) return;
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
    return context.run(() => post(`/applications/${application.id}/events`, { type: 'feedback', note: values.feedback.trim() }), '反馈已记录');
  }

  return <article className="application-card">
    <div className="row-title">{application.jobTitle}<Badge value={application.status}/></div>
    <p>{application.company || '公司未填写'}</p>
    <ActionForm
      compact
      disabled={context.busy}
      label="保存备注"
      onSubmit={saveNotes}
      fields={[{ name: 'notes', label: '投递备注', type: 'textarea', rows: 2, initialValue: application.notes }]}
    />
    <div className="button-row">
      <label className="inline-field"><span>投递状态</span><select value={application.status} onChange={(event) => void changeStatus(event.target.value as Application['status'])}>
        {STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
      </select></label>
      <button className="btn small secondary" onClick={() => void loadHistory()}><MessageSquareText size={14}/>{showEvents ? '隐藏历史' : '状态历史 / 面试'}</button>
    </div>
    <div className="interview-form">
      <label className="field"><span>面试阶段</span><input value={stage} onChange={(event) => setStage(event.target.value)} placeholder="初试、复试…"/></label>
      <label className="field"><span>面试时间</span><input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)}/></label>
      <label className="field"><span>地点或链接</span><input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="可选"/></label>
      <button className="btn small secondary" disabled={!when || context.busy} onClick={() => void scheduleInterview()}><CalendarPlus size={14}/>安排面试</button>
    </div>
    <ActionForm compact disabled={context.busy} label="记录反馈" onSubmit={addFeedback} fields={[{ name: 'feedback', label: '反馈内容', required: true, placeholder: '记录面试或投递反馈' }]}/>
    {error && <InlineError>{error}</InlineError>}
    {showEvents && <div className="history-grid">
      <section><h4>状态与反馈历史</h4>{events.length ? <ol className="event-list">{events.map((event) => <li key={event.id}>
        <span>{new Date(event.occurredAt).toLocaleString('zh-CN')}</span><b>{event.type === 'status_change' ? `${labelOf(event.fromStatus)} → ${labelOf(event.toStatus)}` : event.type === 'feedback' ? '反馈' : event.type}</b>{event.note && <p>{event.note}</p>}
      </li>)}</ol> : <p className="muted">暂无历史。</p>}</section>
      <section><h4>面试安排</h4>{interviews.length ? <ol className="event-list">{interviews.map((interview) => <li key={interview.id}>
        <b>{interview.stage}</b><span>{new Date(interview.scheduledAt).toLocaleString('zh-CN')}</span>{interview.locationOrLink && <small>{interview.locationOrLink}</small>}
        <InterviewResult interview={interview} context={context}/>
      </li>)}</ol> : <p className="muted">暂无面试安排。</p>}</section>
    </div>}
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
