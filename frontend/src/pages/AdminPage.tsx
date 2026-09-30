import { useEffect, useState } from 'react';
import { FileSearch, Pencil, Plus, Send, Archive } from 'lucide-react';
import { get, pollOperation, post, put } from '../api/client';
import type { components } from '../api/schema';
import { ActionForm, Badge, DataRows, InlineError, JsonPreview, Loading, Modal, PageHead, Panel, ResourceNotice, useResource } from '../components';
import type { ActionContext } from '../components';

type Job = components['schemas']['Job'];
type JobDraft = components['schemas']['JobRequirementsDraft'];
type AdminUser = NonNullable<components['schemas']['SessionResponse']['user']>;

export function AdminPage({ context, user }: { context: ActionContext; user?: AdminUser }) {
  const jobs = useResource<components['schemas']['JobListResponse']>('/admin/jobs', context.refresh, context.userId);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Job | null>(null);

  async function create(values: Record<string, string>) {
    const success = await context.run(() => post('/admin/jobs', payload(values)), '公共岗位草稿已创建');
    if (success) setCreating(false);
    return success;
  }

  return <>
    <PageHead
      kicker="管理员岗位库"
      title="维护公共岗位"
      description={`当前身份：${user?.displayName ?? '管理员'}。草稿经解析确认后发布，公共岗位仅在发布后对学生可见。`}
      action={<button className="btn primary" onClick={() => setCreating(true)}><Plus size={16}/>新增公共岗位</button>}
    />
    <Panel title="公共岗位" description="支持编辑 JD、解析并确认要求、发布、下架或归档">
      <ResourceNotice error={jobs.error}/>
      {jobs.loading && !jobs.data && <Loading/>}
      <DataRows items={jobs.data?.items ?? []} empty="公共岗位库尚无记录。">
        {(job) => <AdminJobCard job={job} context={context} onEdit={() => setEditing(job)}/>}
      </DataRows>
    </Panel>
    {creating && <Modal title="新增公共岗位" onClose={() => setCreating(false)}>
      <ActionForm disabled={context.busy} label="创建草稿" onSubmit={create} fields={jobFields()}/>
    </Modal>}
    {editing && <Modal title="编辑公共岗位" onClose={() => setEditing(null)}>
      <p className="muted">保存时提交版本号；JD 改动会使原岗位要求失效，需要重新解析并确认。</p>
      <ActionForm
        key={`${editing.id}:${editing.version}`}
        disabled={context.busy}
        label="保存修改"
        onSubmit={async (values) => {
          const success = await context.run(() => put(`/admin/jobs/${editing.id}`, { ...payload(values), baseVersion: editing.version }), '岗位已更新');
          if (success) setEditing(null);
          return success;
        }}
        fields={jobFields(editing)}
      />
    </Modal>}
  </>;
}

function AdminJobCard({ job, context, onEdit }: { job: Job; context: ActionContext; onEdit: () => void }) {
  const [draft, setDraft] = useState<JobDraft | null>(null);
  const [error, setError] = useState('');
  const [parsing, setParsing] = useState(false);
  // 列表接口不回填 requirements（由查询方按需填充），用详情接口补齐计数。
  const [confirmedCount, setConfirmedCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setConfirmedCount(null);
    get<Job>(`/jobs/${job.id}`)
      .then((detail) => { if (alive) setConfirmedCount(detail.requirements?.length ?? 0); })
      .catch(() => { /* 计数仅为展示，详情不可达时保持列表默认值 */ });
    return () => { alive = false; };
  }, [job.id, job.updatedAt]);

  async function parseRequirements() {
    setError('');
    setParsing(true);
    try {
      const accepted = await post<components['schemas']['AcceptedResponse']>(`/jobs/${job.id}/parse-requirements`);
      await pollOperation(accepted.operationId);
      setDraft(await get<JobDraft>(`/jobs/${job.id}/requirements-draft`));
    } catch (value) {
      setError(value instanceof Error ? value.message : '岗位要求解析失败');
    } finally {
      setParsing(false);
    }
  }

  async function confirmRequirements() {
    const success = await context.run(() => post(`/jobs/${job.id}/requirements/confirm`), '岗位要求已确认');
    if (success) setDraft(null);
  }

  async function publish(action: 'publish' | 'unpublish' | 'archive') {
    const label = action === 'publish' ? '岗位已发布' : action === 'archive' ? '岗位已归档' : '岗位已下架';
    await context.run(() => post(`/admin/jobs/${job.id}/publish`, { action }), label);
  }

  return <article className="admin-job">
    <div className="admin-job-head">
      <div><div className="row-title">{job.title}<Badge value={job.status}/></div><p>{job.company || '公司未填写'} · {job.location || '地点未填写'} · 截止 {job.deadlineDate || '未设置'}</p><small>{confirmedCount == null ? '—' : confirmedCount} 项已确认条件 · JD 版本 {job.jobVersion}</small></div>
      <div className="button-row">
        <button className="btn small secondary" disabled={context.busy} onClick={onEdit}><Pencil size={14}/>编辑</button>
        <button className="btn small secondary" disabled={context.busy || parsing || !job.jdText} onClick={() => void parseRequirements()}><FileSearch size={14}/>{parsing ? '解析中…' : '解析要求'}</button>
        {job.status === 'published'
          ? <button className="btn small secondary" disabled={context.busy} onClick={() => void publish('unpublish')}>下架</button>
          : <button className="btn small primary" disabled={context.busy} onClick={() => void publish('publish')}><Send size={14}/>发布</button>}
        {job.status !== 'archived' && <button className="btn small secondary" disabled={context.busy} onClick={() => void publish('archive')}><Archive size={14}/>归档</button>}
      </div>
    </div>
    {error && <InlineError>{error}</InlineError>}
    {draft && <div className="draft-review">
      <div className="row-title">要求解析草稿 <Badge value={draft.status}/></div>
      <p>逐条检查候选及 JD 原文引用；确认后才会参与学生的硬条件判断。</p>
      <JsonPreview value={draft.candidates}/>
      <button className="btn primary" disabled={context.busy || draft.status !== 'ready'} onClick={() => void confirmRequirements()}>确认岗位要求</button>
    </div>}
  </article>;
}

function jobFields(job?: Job) {
  return [
    { name: 'title', label: '岗位名称', required: true, initialValue: job?.title ?? '' },
    { name: 'company', label: '公司名称', initialValue: job?.company ?? '' },
    { name: 'location', label: '工作地点', initialValue: job?.location ?? '' },
    { name: 'deadlineDate', label: '截止日期', type: 'date', initialValue: job?.deadlineDate ?? '' },
    { name: 'sourceUrl', label: '来源链接', type: 'url', initialValue: job?.sourceUrl ?? '' },
    { name: 'degreeRequirement', label: '学历要求', options: [
      { value: '', label: '未设置' }, { value: 'none', label: '不限' }, { value: 'associate', label: '大专' },
      { value: 'bachelor', label: '本科' }, { value: 'master', label: '硕士' }, { value: 'phd', label: '博士' },
    ], initialValue: job?.degreeRequirement ?? '' },
    { name: 'graduationYearFrom', label: '毕业年份下限', type: 'number', min: '2000', max: '2100', initialValue: job?.graduationYearFrom == null ? '' : String(job.graduationYearFrom) },
    { name: 'graduationYearTo', label: '毕业年份上限', type: 'number', min: '2000', max: '2100', initialValue: job?.graduationYearTo == null ? '' : String(job.graduationYearTo) },
    { name: 'jdText', label: 'JD 原文', type: 'textarea', rows: 9, required: true, initialValue: job?.jdText ?? '' },
  ];
}

function payload(values: Record<string, string>) {
  return {
    title: values.title.trim(),
    company: values.company.trim(),
    location: values.location.trim() || null,
    sourceUrl: values.sourceUrl.trim() || null,
    deadlineDate: values.deadlineDate || null,
    degreeRequirement: values.degreeRequirement || null,
    graduationYearFrom: values.graduationYearFrom ? Number(values.graduationYearFrom) : null,
    graduationYearTo: values.graduationYearTo ? Number(values.graduationYearTo) : null,
    jdText: values.jdText.trim(),
  };
}
