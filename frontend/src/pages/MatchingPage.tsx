import { useMemo, useState } from 'react';
import { ArrowRight, ChartNoAxesCombined, Sparkles } from 'lucide-react';
import { get, pollOperation, post, put } from '../api/client';
import type { components } from '../api/schema';
import { ActionForm, Badge, DataRows, InlineError, JsonPreview, Loading, PageHead, Panel, ResourceNotice, useResource } from '../components';
import type { ActionContext } from '../components';

type Job = components['schemas']['Job'];
type MatchSnapshot = components['schemas']['MatchSnapshot'];
type Portfolio = components['schemas']['Portfolio'];
type Profile = components['schemas']['Profile'];
type Evidence = components['schemas']['EvidenceBundle'];

export function MatchingPage({ context }: { context: ActionContext }) {
  const jobsResource = useResource<components['schemas']['JobListResponse']>('/jobs?scope=public', context.refresh, context.userId);
  const privateResource = useResource<components['schemas']['JobListResponse']>('/jobs?scope=mine', context.refresh, context.userId);
  const profile = useResource<Profile>('/profile', context.refresh, context.userId);
  const evidence = useResource<Evidence>('/evidence', context.refresh, context.userId);
  const portfolios = useResource<{ items: Portfolio[] }>('/portfolios', context.refresh, context.userId);
  const jobs = useMemo(() => [...(jobsResource.data?.items ?? []), ...(privateResource.data?.items ?? [])], [jobsResource.data, privateResource.data]);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [match, setMatch] = useState<MatchSnapshot | null>(null);
  const [operationStatus, setOperationStatus] = useState('');
  const [error, setError] = useState('');
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [pins, setPins] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);

  async function createMatch() {
    if (!selectedJobId) return;
    setError('');
    setMatch(null);
    setOperationStatus('正在排队…');
    try {
      const response = await post<components['schemas']['AcceptedResponse']>('/matches', {
        jobId: selectedJobId,
        clientProfileVersion: profile.data?.version ?? null,
        clientExperienceVersions: (evidence.data?.experiences ?? []).map(({ id, version }) => ({ id, version })),
      });
      const operation = await pollOperation(response.operationId, setOperationStatus);
      const snapshot = operation.resultRef
        ? await get<MatchSnapshot>(`/matches/${operation.resultRef}`)
        : (await get<{ items: MatchSnapshot[] }>(`/matches?jobId=${encodeURIComponent(selectedJobId)}`)).items[0];
      if (!snapshot) throw new Error('分析完成但没有返回匹配快照，请刷新后重试。');
      setMatch(snapshot);
      setOperationStatus('分析已完成');
      context.run(async () => undefined, '匹配解释已更新');
    } catch (value) {
      setError(value instanceof Error ? value.message : '匹配分析失败');
      setOperationStatus('');
    }
  }

  async function savePortfolio(values: Record<string, string>) {
    const timeBudgetHours = Number(values.timeBudgetHours);
    const body = { timeBudgetHours, pinnedJobIds: pins, removedJobIds: removed, asOfDate: today() };
    const saved = portfolio
      ? await context.run(() => put<Portfolio>(`/portfolios/${portfolio.id}`, body), '求职组合已更新')
      : await context.run(() => post<Portfolio>('/portfolios', body), '求职组合已生成');
    if (saved) {
      try {
        const latest = portfolio
          ? await get<Portfolio>(`/portfolios/${portfolio.id}`)
          : (await get<{ items: Portfolio[] }>('/portfolios')).items[0];
        setPortfolio(latest ?? null);
      } catch {
        setPortfolio(null);
      }
    }
    return saved;
  }

  const selectedPortfolio = portfolio ?? portfolios.data?.items[0] ?? null;
  const selectedPortfolioJobs = selectedPortfolio?.items.map((item) => ({
    ...item,
    job: jobs.find((job) => job.id === item.jobId),
  })) ?? [];

  return <>
    <PageHead kicker="匹配与组合" title="看清条件、差距和准备成本" description="规则分数用于解释排序，不代表录取概率。硬条件未知会保留为待核实，不自动当作满足。"/>
    <Panel title="生成匹配解释" description="分析开始前会检查画像和经历版本；有未同步修改时服务端要求先同步">
      <ResourceNotice error={jobsResource.error || privateResource.error || profile.error || evidence.error}/>
      {(jobsResource.loading || privateResource.loading || profile.loading || evidence.loading) && !jobs.length && <Loading/>}
      <div className="match-controls">
        <label className="field grow"><span>选择岗位</span>
          <select value={selectedJobId} onChange={(event) => setSelectedJobId(event.target.value)}>
            <option value="">请选择公开或私人岗位</option>
            {jobs.map((job) => <option value={job.id} key={job.id}>{job.title} · {job.company || (job.scope === 'private' ? '私人岗位' : '')}</option>)}
          </select>
        </label>
        <button className="btn primary" disabled={!selectedJobId || context.busy || operationStatus !== ''} onClick={() => void createMatch()}>
          <Sparkles size={16}/>开始分析
        </button>
      </div>
      {operationStatus && <div className="operation-status"><span className="pulse-dot"/>{operationStatus}</div>}
      {error && <InlineError>{error}</InlineError>}
      {match && <MatchExplanation snapshot={match} job={jobs.find((job) => job.id === match.jobId)}/>}
    </Panel>

    <Panel title="最近分析" description="从每个岗位详情读取最新快照">
      {jobs.length ? <div className="match-history-grid">{jobs.map((job) => <RecentMatch key={job.id} job={job} onOpen={(snapshot) => setMatch(snapshot)}/>)}</div> : <div className="empty">请先添加或浏览岗位。</div>}
    </Panel>

    <Panel title="求职组合" description="用每周可投入时间筛选岗位；固定、移除或替换后重新计算，不会自动增加预算">
      <ActionForm
        disabled={context.busy}
        label={selectedPortfolio ? '更新组合' : '生成组合'}
        onSubmit={savePortfolio}
        fields={[{ name: 'timeBudgetHours', label: '每周准备预算（小时）', type: 'number', min: '0.5', max: '200', step: '0.5', required: true, initialValue: String(selectedPortfolio?.timeBudgetHours ?? profile.data?.weeklyTimeBudgetHours ?? 8) }]}
      />
      {selectedPortfolio && <>
        <div className="portfolio-summary"><b>组合预算：{selectedPortfolio.timeBudgetHours} 小时</b><span>{selectedPortfolio.items.filter((item) => item.selected).length} 个岗位入选</span></div>
        <DataRows items={selectedPortfolioJobs} empty="当前组合没有岗位。先为岗位生成匹配分析。">
          {(item) => <div className="portfolio-row">
            <div className="row-main">
              <div className="row-title">{item.job?.title ?? item.jobId}<Badge value={item.selected ? 'selected' : item.excludedReason ?? 'excluded'}/></div>
              <p>{item.job?.company} · 匹配 {item.score} · 准备 {item.prepHours ?? '未估算'} 小时</p>
              {item.excludedReason && <small>{item.excludedReason}</small>}
            </div>
            <div className="button-row">
              <button className={`btn small ${pins.includes(item.jobId) ? 'primary' : 'secondary'}`} onClick={() => setPins((all) => all.includes(item.jobId) ? all.filter((id) => id !== item.jobId) : [...all, item.jobId])}>{pins.includes(item.jobId) ? '已固定' : '固定岗位'}</button>
              <button className="btn small secondary" onClick={() => setRemoved((all) => all.includes(item.jobId) ? all.filter((id) => id !== item.jobId) : [...all, item.jobId])}>{removed.includes(item.jobId) ? '撤销移除' : '移出组合'}</button>
            </div>
          </div>}
        </DataRows>
        <div className="button-row"><span className="muted">更改固定/移除选择后，点击“更新组合”重新运行预算筛选。</span></div>
      </>}
      {portfolios.error && <ResourceNotice error={portfolios.error}/>}
    </Panel>
  </>;
}

function MatchExplanation({ snapshot, job }: { snapshot: MatchSnapshot; job?: Job }) {
  const explanation = snapshot.explanation as {
    summary?: string;
    advantages?: { text: string; quotes: { text: string; location?: string | null }[] }[];
    gaps?: { text: string; quotes: { text: string; location?: string | null }[] }[];
    prepSuggestions?: { text: string; quotes: { text: string; location?: string | null }[] }[];
    rejectedQuotes?: number;
  } | null | undefined;
  return <section className="match-result">
    <header className="result-heading"><div><h3>{job?.title ?? '匹配快照'}</h3><Badge value={snapshot.status}/></div><small>规则版本 {snapshot.ruleVersion} · 更新于 {new Date(snapshot.updatedAt).toLocaleString('zh-CN')}</small></header>
    {snapshot.error && <InlineError>{snapshot.error}</InlineError>}
    {snapshot.status === 'stale' && <p className="warning-note">画像或经历已变化，此快照过期。请重新运行分析。</p>}
    {snapshot.status === 'ready' && <>
      <p className="match-summary">{explanation?.summary || '服务端未提供文字摘要。'}</p>
      <div className="score-grid">
        <Score label="技能覆盖" value={snapshot.scores.skillCoverage}/>
        <Score label="已确认经历证据" value={snapshot.scores.evidenceCoverage}/>
        <Score label="岗位与偏好" value={snapshot.scores.preference}/>
        <Score label="总分" value={snapshot.scores.total}/>
      </div>
      <p className="muted">{snapshot.scores.coverageNote}</p>
      <h4>硬条件</h4>
      {snapshot.hardConditions.length ? <ul className="condition-list">{snapshot.hardConditions.map((condition, index) => <li key={`${condition.kind}-${index}`}>
        <span><b>{condition.kind}</b>：{condition.requirement}{condition.note && <small>{condition.note}</small>}</span><Badge value={condition.status}/>
      </li>)}</ul> : <p className="empty small-empty">尚未确认岗位硬条件。未知条件不会按满足处理。</p>}
      <div className="two-col explanation-columns">
        <ExplanationList title="优势" items={explanation?.advantages ?? []}/>
        <ExplanationList title="差距与准备建议" items={[...(explanation?.gaps ?? []), ...(explanation?.prepSuggestions ?? [])]}/>
      </div>
      <h4>引用依据</h4>
      {snapshot.quotes.length ? <ul className="quote-list">{snapshot.quotes.map((quote, index) => <li key={`${quote.source}-${quote.text}-${index}`}><blockquote>{quote.text}</blockquote><small>{quote.source}{quote.location ? ` · ${quote.location}` : ''}</small></li>)}</ul> : <p className="muted">没有经核验的引文。解释文字不会被展示为引用。</p>}
      {(explanation?.rejectedQuotes ?? 0) > 0 && <p className="muted">服务端剔除了 {explanation?.rejectedQuotes} 条无法验证的模型引用。</p>}
    </>}
    {snapshot.status !== 'ready' && <JsonPreview value={snapshot}/ >}
  </section>;
}

function ExplanationList({ title, items }: { title: string; items: { text: string; quotes: { text: string }[] }[] }) {
  return <section className="explanation-list"><h4>{title}</h4>{items.length ? <ul>{items.map((item, index) => <li key={`${item.text}-${index}`}>
    <p>{item.text}</p>{item.quotes.length > 0 && <small>已核验引用：{item.quotes.map((quote) => quote.text).join('；')}</small>}
  </li>)}</ul> : <p className="muted">暂无内容。</p>}</section>;
}

function Score({ label, value }: { label: string; value: number | null | undefined }) {
  return <div className="score-card"><small>{label}</small><strong>{value == null ? '未填写' : `${Math.round(value)} / 100`}</strong>{value != null && <div className="score-track"><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }}/></div>}</div>;
}

function RecentMatch({ job, onOpen }: { job: Job; onOpen: (snapshot: MatchSnapshot) => void }) {
  const [snapshot, setSnapshot] = useState<MatchSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function open() {
    setLoading(true);
    setError('');
    try {
      const result = await get<{ items: MatchSnapshot[] }>(`/matches?jobId=${encodeURIComponent(job.id)}`);
      const latest = result.items[0];
      setSnapshot(latest ?? null);
      if (latest) onOpen(latest);
      else setError('尚未生成分析');
    } catch (value) {
      setError(value instanceof Error ? value.message : '读取失败');
    } finally {
      setLoading(false);
    }
  }
  return <button className="match-history-card" onClick={() => void open()} disabled={loading}>
    <span className="history-icon"><ChartNoAxesCombined size={17}/></span>
    <span><b>{job.title}</b><small>{snapshot ? `总分 ${snapshot.scores.total}` : error || job.company}</small></span>
    {loading ? <Loading label="读取"/> : <ArrowRight size={16}/>}
  </button>;
}

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
