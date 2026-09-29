import { useState } from 'react';
import { ArrowUpRight, FileSearch, Plus, Trash2 } from 'lucide-react';
import { del, get, pollOperation, post } from '../api/client';
import type { components } from '../api/schema';
import { ActionForm, Badge, DataRows, InlineError, JsonPreview, Loading, Modal, PageHead, Panel, ResourceNotice, useResource } from '../components';
import type { ActionContext } from '../components';
import { cacheKey, cacheValue, readCached, withOfflineQueue } from '../offline';

type Job = components['schemas']['Job'];
type JobList = components['schemas']['JobListResponse'];
type JobDraft = components['schemas']['JobRequirementsDraft'];

export function JobsPage({ context }: { context: ActionContext }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const publicPath = `/jobs?scope=public${search ? `&q=${encodeURIComponent(search)}` : ''}`;
  const privatePath = '/jobs?scope=mine';
  const publicJobs = useResource<JobList>(publicPath, context.refresh, context.userId);
  const privateJobs = useResource<JobList>(privatePath, context.refresh, context.userId);
  const publicItems = publicJobs.data?.items ?? [];
  const privateItems = privateJobs.data?.items ?? [];

  async function createPrivateJob(values: Record<string, string>) {
    const payload = jobPayload(values);
    const localId = crypto.randomUUID();
    return context.run(() => withOfflineQueue(
      () => post('/jobs', payload),
      { userId: context.userId, entity: 'job', entityId: localId, baseVersion: 0, action: 'upsert', payload },
      async () => {
        const now = new Date().toISOString();
        const local: Job = {
          id: localId, version: 0, deleted: false, scope: 'private',
          createdAt: now, updatedAt: now, status: 'draft', jobVersion: 1,
          title: payload.title ?? '', company: payload.company ?? '', location: payload.location ?? null,
          sourceUrl: payload.sourceUrl ?? null, deadlineDate: payload.deadlineDate,
          jdText: payload.jdText ?? '', requirements: [],
        };
        const key = cacheKey(context.userId, `api:${privatePath}`);
        const cached = await readCached<JobList>(key);
        await cacheValue(key, { items: [local, ...(cached?.items ?? [])] });
      },
    ), '私人岗位已保存；离线新增已进入同步队列');
  }

  return <>
    <PageHead
      kicker="岗位探索"
      title="找到值得准备的机会"
      description="查看公开岗位或粘贴私人 JD。列表项中的硬条件和原文引用由服务端岗位详情提供。"
      action={<button className="btn primary" onClick={() => setCreating(true)}><Plus size={16}/>添加私人 JD</button>}
    />
    <Panel title="公共岗位库" description={`${publicItems.length} 条可见岗位`}>
      <form className="search-bar" onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); }}>
        <label className="visually-hidden" htmlFor="job-search">搜索岗位</label>
        <input id="job-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按岗位名称或 JD 搜索"/>
        <button className="btn secondary">搜索</button>
      </form>
      <ResourceNotice error={publicJobs.error}/>
      {publicJobs.loading && !publicJobs.data && <Loading/>}
      <DataRows items={publicItems} empty="公共岗位库暂时没有匹配结果。">
        {(job) => <div className="job-card">
          <div className="row-main">
            <div className="row-title">{job.title}<Badge value={job.status}/></div>
            <p>{job.company || '公司未填写'} · {job.location || '地点未填写'} · 截止 {job.deadlineDate || '未设置'}</p>
            {job.sourceUrl && <a className="source-link" href={job.sourceUrl} target="_blank" rel="noreferrer">查看来源 <ArrowUpRight size={14}/></a>}
          </div>
          <div className="button-row">
            <button className="btn small secondary" onClick={() => setSelected(job.id)}>查看条件</button>
            <button className="btn small primary" disabled={context.busy} onClick={() => void addApplication(job, context)}>加入投递跟踪</button>
          </div>
        </div>}
      </DataRows>
    </Panel>

    <Panel title="私人岗位" description="只对当前演示账号可见；粘贴原始 JD，可选填写来源链接和截止日期">
      <ResourceNotice error={privateJobs.error}/>
      <DataRows items={privateItems} empty="你还没有添加私人岗位。">
        {(job) => <PrivateJobCard job={job} context={context} onOpen={() => setSelected(job.id)}/>}
      </DataRows>
    </Panel>

    {selected && <JobDetail id={selected} context={context} onClose={() => setSelected(null)}/>}
    {creating && <Modal title="添加私人 JD" onClose={() => setCreating(false)}>
      <ActionForm
        disabled={context.busy}
        label="保存岗位"
        onSubmit={async (values) => {
          const saved = await createPrivateJob(values);
          if (saved) setCreating(false);
          return saved;
        }}
        fields={jobFields()}
      />
    </Modal>}
  </>;
}

function PrivateJobCard({ job, context, onOpen }: { job: Job; context: ActionContext; onOpen: () => void }) {
  const [draft, setDraft] = useState<JobDraft | null>(null);
  const [error, setError] = useState('');

  async function parseRequirements() {
    setError('');
    try {
      const accepted = await post<components['schemas']['AcceptedResponse']>(`/jobs/${job.id}/parse-requirements`);
      await pollOperation(accepted.operationId);
      setDraft(await get<JobDraft>(`/jobs/${job.id}/requirements-draft`));
    } catch (value) {
      setError(value instanceof Error ? value.message : '岗位解析失败');
    }
  }

  async function confirmDraft() {
    const saved = await context.run(() => post(`/jobs/${job.id}/requirements/confirm`), '已确认岗位要求');
    if (saved) setDraft(null);
  }

  return <article className="job-card private-job-card">
    <div className="row-main">
      <div className="row-title">{job.title}<Badge value={job.status}/></div>
      <p>{job.company || '公司未填写'} · {job.location || '地点未填写'} · 截止 {job.deadlineDate || '未设置'}</p>
      <small>{job.sourceUrl || '私人岗位'}</small>
      <div className="button-row">
        <button className="btn small secondary" onClick={onOpen}>查看 JD 与条件</button>
        <button className="btn small secondary" disabled={context.busy || job.jdText.length === 0} onClick={() => void parseRequirements()}><FileSearch size={14}/>解析要求</button>
        <button className="btn small danger" disabled={context.busy} onClick={() => void context.run(() => del(`/jobs/${job.id}`), '私人岗位已删除')}><Trash2 size={14}/>删除</button>
      </div>
      {error && <InlineError>{error}</InlineError>}
      {draft && <div className="draft-review">
        <div className="row-title">候选岗位要求 <Badge value={draft.status}/></div>
        <p>核对每项要求及其 JD 引文。确认后才会用于硬条件判断。</p>
        <JsonPreview value={draft.candidates}/>
        <button className="btn primary" disabled={context.busy || draft.status !== 'ready'} onClick={() => void confirmDraft()}>确认这些要求</button>
      </div>}
    </div>
  </article>;
}

function JobDetail({ id, context, onClose }: { id: string; context: ActionContext; onClose: () => void }) {
  const job = useResource<Job>(`/jobs/${id}`, context.refresh, context.userId);
  return <Modal title="岗位详情" onClose={onClose}>
    <ResourceNotice error={job.error}/>
    {job.loading && !job.data ? <Loading/> : job.data ? <>
      <div className="detail-title"><h3>{job.data.title}</h3><Badge value={job.data.status}/></div>
      <p>{job.data.company || '公司未填写'} · {job.data.location || '地点未填写'}</p>
      {job.data.sourceUrl && <a className="source-link" href={job.data.sourceUrl} target="_blank" rel="noreferrer">岗位来源 <ArrowUpRight size={14}/></a>}
      <h4>已确认岗位条件</h4>
      {job.data.requirements.length ? <ul className="requirement-list">{job.data.requirements.map((requirement, index) => <li key={`${requirement.kind}-${index}`}>
        <b>{requirement.kind}</b><span>{requirement.value}</span>{requirement.quote && <blockquote>{requirement.quote}</blockquote>}
      </li>)}</ul> : <p className="empty small-empty">没有已确认条件。私人岗位需先解析并确认要求。</p>}
      <h4>JD 原文</h4>
      <pre className="jd-text">{job.data.jdText || '未提供 JD 原文。'}</pre>
      <div className="button-row"><button className="btn primary" onClick={() => void addApplication(job.data!, context)}>加入投递跟踪</button></div>
    </> : null}
  </Modal>;
}

function jobFields() {
  return [
    { name: 'title', label: '岗位名称', required: true },
    { name: 'company', label: '公司名称' },
    { name: 'location', label: '工作地点' },
    { name: 'deadlineDate', label: '截止日期', type: 'date' },
    { name: 'sourceUrl', label: '来源链接', type: 'url' },
    { name: 'jdText', label: 'JD 原文', type: 'textarea', rows: 8, required: true },
  ];
}

function jobPayload(values: Record<string, string>) {
  return {
    title: values.title.trim(),
    company: values.company.trim(),
    location: values.location.trim() || null,
    deadlineDate: values.deadlineDate || null,
    sourceUrl: values.sourceUrl.trim() || null,
    jdText: values.jdText.trim(),
  };
}

async function addApplication(job: Job, context: ActionContext) {
  return context.run(() => post('/applications', {
    jobId: job.id,
    jobTitle: job.title,
    company: job.company,
    status: 'preparing',
    notes: '',
  }), '已加入投递跟踪');
}
