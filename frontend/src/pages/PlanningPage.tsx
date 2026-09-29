import { useState } from 'react';
import { CheckCheck, FileText } from 'lucide-react';
import { get, patch, pollOperation, post } from '../api/client';
import type { components } from '../api/schema';
import { ActionForm, Badge, DataRows, InlineError, JsonPreview, Loading, PageHead, Panel, ResourceNotice, useResource } from '../components';
import type { ActionContext } from '../components';
import { cacheKey, cacheValue, readCached, withOfflineQueue } from '../offline';

type Profile = components['schemas']['Profile'];
type EvidenceBundle = components['schemas']['EvidenceBundle'];
type Portfolio = components['schemas']['Portfolio'];
type Plan = components['schemas']['Plan'];
type PlanDetail = components['schemas']['PlanDetail'];
type PlanTask = components['schemas']['PlanTask'];
type Suggestion = components['schemas']['AdjustmentSuggestion'];
type Rewrite = components['schemas']['Rewrite'];

export function PlanningPage({ context }: { context: ActionContext }) {
  const plans = useResource<{ items: Plan[] }>('/plans', context.refresh, context.userId);
  const portfolios = useResource<{ items: Portfolio[] }>('/portfolios', context.refresh, context.userId);
  const profile = useResource<Profile>('/profile', context.refresh, context.userId);
  const evidence = useResource<EvidenceBundle>('/evidence', context.refresh, context.userId);
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [operation, setOperation] = useState('');
  const [error, setError] = useState('');
  const [rewrite, setRewrite] = useState<Rewrite | null>(null);
  const [rewriteStatus, setRewriteStatus] = useState('');

  const selectedPlan = plans.data?.items.find((plan) => plan.id === selectedPlanId) ?? plans.data?.items[0];
  const portfolioOptions = portfolios.data?.items ?? [];

  async function generatePlan(values: Record<string, string>): Promise<boolean> {
    setError('');
    setOperation('正在生成两周计划…');
    try {
      const accepted = await post<components['schemas']['AcceptedResponse']>('/plans', {
        portfolioId: values.portfolioId,
        clientProfileVersion: profile.data?.version ?? null,
        clientExperienceVersions: (evidence.data?.experiences ?? []).map(({ id, version }) => ({ id, version })),
      });
      const result = await pollOperation(accepted.operationId, (status) => setOperation(operationLabel(status)));
      if (result.resultRef) setSelectedPlanId(result.resultRef);
      setOperation('计划草稿已生成，请先检查任务和排期。');
      context.run(async () => undefined, '计划草稿已生成');
      return true;
    } catch (value) {
      setError(value instanceof Error ? value.message : '计划生成失败');
      setOperation('');
      return false;
    }
  }

  async function generateRewrite(experienceId: string) {
    setRewriteStatus('正在生成改写建议…');
    setError('');
    try {
      const accepted = await post<components['schemas']['AcceptedResponse']>('/rewrites', { experienceId });
      const result = await pollOperation(accepted.operationId, (status) => setRewriteStatus(operationLabel(status)));
      if (!result.resultRef) throw new Error('改写作业完成但未返回结果编号。');
      setRewrite(await get<Rewrite>(`/rewrites/${result.resultRef}`));
      setRewriteStatus('');
    } catch (value) {
      setError(value instanceof Error ? value.message : '简历改写失败');
      setRewriteStatus('');
    }
  }

  return <>
    <PageHead kicker="计划与改写" title="把组合变成两周行动" description="生成结果先作为草稿展示；你确认后才生效。任务改期或超时只产生调整建议，不覆盖已确认计划。"/>
    <Panel title="生成计划草稿" description="需要一个已生成的求职组合">
      {portfolios.error && <ResourceNotice error={portfolios.error}/>}
      {portfolioOptions.length ? <ActionForm
        key={portfolioOptions.map((portfolio) => portfolio.id).join(',')}
        disabled={context.busy || operation !== ''}
        label="生成两周计划"
        onSubmit={generatePlan}
        fields={[{ name: 'portfolioId', label: '选择求职组合', required: true, options: portfolioOptions.map((portfolio) => ({ value: portfolio.id, label: `${portfolio.timeBudgetHours} 小时 · ${portfolio.items.filter((item) => item.selected).length} 个岗位` })) }]}
      /> : <div className="empty">请先在“匹配与组合”页面生成一个包含岗位的求职组合。</div>}
      {operation && <div className="operation-status"><span className="pulse-dot"/>{operation}</div>}
      {error && <InlineError>{error}</InlineError>}
    </Panel>

    <div className="two-col">
      <Panel title="计划版本" description="新计划不会自动替换已经确认的计划">
        <ResourceNotice error={plans.error}/>
        {plans.loading && !plans.data && <Loading/>}
        <DataRows items={plans.data?.items ?? []} empty="还没有计划。选择组合后生成一份草稿。">
          {(plan) => <button className={`plan-select ${selectedPlan?.id === plan.id ? 'selected' : ''}`} onClick={() => setSelectedPlanId(plan.id)}>
            <span><b>两周计划</b><small>{new Date(plan.updatedAt).toLocaleString('zh-CN')}</small></span>
            <Badge value={plan.status}/>
          </button>}
        </DataRows>
      </Panel>
      <Panel title="简历改写建议" description="选择一段经历生成逐条建议；每条必须由你单独采纳">
        <DataRows items={evidence.data?.experiences ?? []} empty="先在画像页录入一段经历。">
          {(experience) => <div className="row-main"><div className="row-title">{experience.title}<span className="muted">· {experience.organization}</span></div>
            <button className="btn small secondary" disabled={context.busy || rewriteStatus !== ''} onClick={() => void generateRewrite(experience.id)}><FileText size={14}/>生成改写</button>
          </div>}
        </DataRows>
        {rewriteStatus && <div className="operation-status"><span className="pulse-dot"/>{rewriteStatus}</div>}
        {rewrite && <RewriteReview rewrite={rewrite} context={context} onRefresh={setRewrite}/>}
      </Panel>
    </div>

    {selectedPlan && <PlanDetailView key={selectedPlan.id} plan={selectedPlan} context={context}/>}
    {!selectedPlan && plans.data?.items.length === 0 && <Panel title="任务和排期"><div className="empty">生成计划后，任务会显示在这里。</div></Panel>}
  </>;
}

function PlanDetailView({ plan, context }: { plan: Plan; context: ActionContext }) {
  const resource = useResource<PlanDetail>(`/plans/${plan.id}`, context.refresh, context.userId);
  const suggestions = useResource<{ items: Suggestion[] }>(`/plans/${plan.id}/suggestions`, context.refresh, context.userId);
  const detail = resource.data;
  const tasks = detail?.tasks ?? [];

  return <Panel
    title="两周任务与排期"
    description={`计划状态：${plan.status === 'confirmed' ? '已确认' : plan.status === 'draft' ? '待确认草稿' : '已被新计划替代'}`}
    action={plan.status === 'draft' ? <button className="btn primary" disabled={context.busy} onClick={() => void context.run(() => post(`/plans/${plan.id}/confirm`), '计划已确认，任务开始生效')}><CheckCheck size={16}/>确认计划</button> : null}
  >
    <ResourceNotice error={resource.error}/>
    {resource.loading && !detail && <Loading/>}
    <DataRows items={tasks} empty={plan.status === 'draft' ? '草稿还没有任务，模型可能未返回可用结果。' : '计划中没有任务。'}>
      {(task) => <TaskCard task={task} planId={plan.id} confirmed={plan.status === 'confirmed'} context={context}/>}
    </DataRows>
    <section className="suggestions">
      <h3>计划调整建议</h3>
      <ResourceNotice error={suggestions.error}/>
      <DataRows items={suggestions.data?.items ?? []} empty="还没有需要处理的建议。">
        {(suggestion) => <article className="suggestion-card">
          <div className="row-title">{suggestion.summary}<Badge value={suggestion.status}/></div>
          <small>触发来源：{suggestion.trigger}</small>
          {suggestion.status === 'pending' && <div className="button-row">
            <button className="btn small primary" disabled={context.busy} onClick={() => void context.run(() => post(`/suggestions/${suggestion.id}/resolve`, { action: 'accept' }), '已采纳调整建议')}>采纳</button>
            <button className="btn small secondary" disabled={context.busy} onClick={() => void context.run(() => post(`/suggestions/${suggestion.id}/resolve`, { action: 'reject' }), '已拒绝调整建议')}>拒绝</button>
          </div>}
          {suggestion.proposal !== undefined && suggestion.proposal !== null && <JsonPreview value={suggestion.proposal}/>}
        </article>}
      </DataRows>
    </section>
  </Panel>;
}

function TaskCard({ task, planId, confirmed, context }: { task: PlanTask; planId: string; confirmed: boolean; context: ActionContext }) {
  async function update(values: Record<string, string>) {
    const payload = {
      title: values.title.trim(),
      ...(values.scheduledDate ? { scheduledDate: values.scheduledDate } : {}),
      estimateHours: values.estimateHours ? Number(values.estimateHours) : null,
      actualHours: values.actualHours ? Number(values.actualHours) : null,
      status: values.status,
    };
    return context.run(() => withOfflineQueue(
      () => patch(`/tasks/${task.id}`, { ...payload, baseVersion: task.version }),
      { userId: context.userId, entity: 'task', entityId: task.id, baseVersion: task.version, action: 'upsert', payload },
      async () => {
        const path = `/plans/${planId}`;
        const key = cacheKey(context.userId, `api:${path}`);
        const cached = await readCached<PlanDetail>(key);
        if (cached) await cacheValue(key, {
          ...cached,
          tasks: cached.tasks.map((row) => row.id === task.id ? { ...row, ...payload, version: row.version + 1 } : row),
        });
      },
    ), '任务已更新；离线修改已进入同步队列');
  }

  return <article className="task-card">
    <div className="task-heading">
      <div><div className="row-title">{task.title}<Badge value={task.status}/></div><p>{task.description}</p></div>
      <div className="task-date">{task.scheduledDate ? new Date(`${task.scheduledDate}T00:00:00`).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '未排期'}</div>
    </div>
    {(task.gap || task.jobId) && <small>{task.gap || `关联岗位 ${task.jobId}`}</small>}
    <div className="task-hours"><span>预计 {task.estimateHours ?? '未估算'} 小时</span><span>实际 {task.actualHours ?? '未记录'} 小时</span></div>
    <ActionForm
      compact
      disabled={!confirmed || context.busy}
      label="保存任务"
      onSubmit={update}
      fields={[
        { name: 'title', label: '任务', required: true, initialValue: task.title },
        { name: 'scheduledDate', label: '安排日期', type: 'date', initialValue: task.scheduledDate ?? '' },
        { name: 'estimateHours', label: '预计小时', type: 'number', min: '0.5', step: '0.5', initialValue: task.estimateHours == null ? '' : String(task.estimateHours) },
        { name: 'actualHours', label: '实际小时', type: 'number', min: '0', step: '0.25', initialValue: task.actualHours == null ? '' : String(task.actualHours) },
        { name: 'status', label: '状态', options: [
          { value: 'pending', label: '待开始' }, { value: 'in_progress', label: '进行中' },
          { value: 'done', label: '已完成' }, { value: 'cancelled', label: '已取消' },
        ], initialValue: task.status },
      ]}
    />
    {!confirmed && <p className="muted">先确认计划，任务修改才会生效。</p>}
  </article>;
}

function RewriteReview({ rewrite, context, onRefresh }: { rewrite: Rewrite; context: ActionContext; onRefresh: (value: Rewrite | null) => void }) {
  if (rewrite.status !== 'ready') return <div className="rewrite-status"><Badge value={rewrite.status}/>{rewrite.error && <InlineError>{rewrite.error}</InlineError>}</div>;
  return <div className="rewrite-review">
    <div className="row-title">改写对照 <Badge value={rewrite.status}/></div>
    {rewrite.items.map((item) => <article className="rewrite-item" key={item.id}>
      <div className="rewrite-columns"><div><small>原文</small><blockquote>{item.originalQuote}</blockquote></div><div><small>建议</small><blockquote>{item.suggestion}</blockquote></div></div>
      <p>{item.rationale}</p>
      {!item.quoteVerified && <p className="warning-note">该建议的原文无法核验，不能采纳。</p>}
      <div className="button-row"><Badge value={item.status}/>
        {item.status === 'pending' && <>
          <button className="btn small primary" disabled={context.busy || !item.quoteVerified} onClick={() => void resolveItem(rewrite, item.id, 'accept', context, onRefresh)}>采纳此条</button>
          <button className="btn small secondary" disabled={context.busy} onClick={() => void resolveItem(rewrite, item.id, 'reject', context, onRefresh)}>拒绝</button>
        </>}
      </div>
    </article>)}
  </div>;
}

async function resolveItem(rewrite: Rewrite, itemId: string, action: 'accept' | 'reject', context: ActionContext, onRefresh: (value: Rewrite | null) => void) {
  const result = await context.run(
    () => post<Rewrite>(`/rewrites/${rewrite.id}/items/${itemId}/resolve`, { action }),
    action === 'accept' ? '已采纳此条改写' : '已拒绝此条改写',
  );
  if (result) {
    try { onRefresh(await get<Rewrite>(`/rewrites/${rewrite.id}`)); } catch { onRefresh(null); }
  }
}

function operationLabel(status: string) {
  switch (status) {
    case 'queued': return '作业已排队…';
    case 'running': return '服务端处理中…';
    case 'succeeded': return '处理完成';
    case 'failed': return '处理失败';
    default: return '正在处理…';
  }
}
