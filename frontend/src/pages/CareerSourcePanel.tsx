import { useEffect, useState, useSyncExternalStore } from 'react';
import { ExternalLink, FileSearch, RefreshCw } from 'lucide-react';
import { get, post } from '../api/client';
import { InlineError, Panel, type ActionContext } from '../components';
import {
  createCareerReviewController, type CareerDraft, type CareerPreview, type CareerReviewState,
} from './career-source-review';
import './career-source-review.css';

export function CareerSourcePanel({ context }: { context: ActionContext }) {
  const [controller] = useState(() => createCareerReviewController({
    status: () => get('/admin/career-source'),
    refresh: () => post('/admin/career-source/refresh', {}),
    preview: body => post('/admin/career-source/preview', body),
    extract: body => post('/admin/career-source/extract', body),
  }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useEffect(() => { void controller.readStatus(); }, [controller]);
  return <CareerSourceReview state={state} disabled={context.busy}
    onReadStatus={() => void controller.readStatus()} onRefresh={() => void controller.refresh()}
    onPreview={id => void controller.preview(id)} onExtract={() => void controller.extract()}/>;
}

export function CareerSourceReview({ state, disabled, onReadStatus, onRefresh, onPreview, onExtract }: {
  state: CareerReviewState; disabled: boolean; onReadStatus: () => void; onRefresh: () => void;
  onPreview: (id: string) => void; onExtract: () => void;
}) {
  const busy = disabled || state.operation !== null;
  const fresh = state.preview && Date.parse(state.preview.expiresAt) > Date.now() && !state.requiresPreview;
  return <Panel title="中大就业网公告" description="读取公开校园招聘公告，生成带原文证据的待审核候选。此入口不创建或发布公共岗位。">
    <div className="career-source-review">
      <p className="muted">只读取首页与手动选择的公告，不自动翻页；缓存保留 15 分钟。来源请求至少间隔 1.1 秒，拒绝访问或结构异常时停止并冷却 15 分钟。</p>
      <div className="button-row">
        <button className="btn secondary" disabled={busy} onClick={onReadStatus}>读取缓存与模型状态</button>
        <button className="btn secondary" disabled={busy} onClick={onRefresh}><RefreshCw size={16}/>{state.operation === 'refresh' ? '读取来源中…' : '获取首页公告'}</button>
      </div>
      <p className="muted" role="status">{state.operation === 'status' ? '正在读取缓存；不会请求学校网站或模型。' : !state.status ? '正在等待读取模型状态；不会自动请求学校网站或模型。' : state.status.extractionAvailable ? '真实模型已配置。只有点击“提取待审核候选”才会调用模型。' : '真实模型未配置或不可用；可预览来源，不生成模拟候选。'}</p>
      {state.error && <InlineError>{state.error}</InlineError>}
      {state.listing ? <>
        <p className="muted">来源读取时间：{state.listing.retrievedAt} · 缓存到期：{state.listing.expiresAt}</p>
        <ul className="career-source-list" aria-label="首页公开公告">
          {state.listing.items.map(item => <li key={item.id}>
            <div><strong>{item.title}</strong>{item.pinned && <span className="badge neutral">置顶</span>}<p>{item.publishedAt} · 公告 {item.id}</p></div>
            <div className="button-row"><a className="btn small secondary" href={item.url} target="_blank" rel="noopener noreferrer">原网页<ExternalLink size={14}/></a>
              <button className="btn small secondary" disabled={busy} onClick={() => onPreview(item.id)}>{state.operation === 'preview' && state.selectedId === item.id ? '预览中…' : '预览来源'}</button></div>
          </li>)}
        </ul>
      </> : <p className="muted">暂无来源缓存。点击“获取首页公告”后选择一条预览。</p>}
      {state.preview && <>
        <CareerSourcePreview preview={state.preview}/>
        <p className="muted">提取只发送这条公开公告正文，使用已保存的真实模型，可能消耗少量额度。每次最多一次请求，无自动重试；同一来源版本有缓存时复用候选。证据校验不是准确性保证，需要逐条人工审核。</p>
        {!fresh && <InlineError>来源缓存已过期或版本变化，请点击这条公告的“预览来源”重新读取。</InlineError>}
        <button className="btn primary" disabled={busy || !state.status?.extractionAvailable || !fresh} onClick={onExtract}><FileSearch size={16}/>{state.operation === 'extract' ? '提取中…' : state.draft ? '读取同版本审核候选' : '提取待审核候选'}</button>
      </>}
      {state.draft && <CareerCandidateReview draft={state.draft}/>}
    </div>
  </Panel>;
}

function CareerSourcePreview({ preview }: { preview: CareerPreview }) {
  const metadata = preview.source.metadata;
  return <section className="career-source-snapshot" aria-label="公告来源预览">
    <h3>{preview.title}</h3>
    <dl className="career-source-metadata">
      <dt>发布单位</dt><dd>{preview.employer ?? '未知'}</dd>
      <dt>原发布日期</dt><dd>{metadata.originalDate ?? '未知'}</dd>
      <dt>网站过期标记</dt><dd>{metadata.sourceExpiry ?? '未知'}（不等同于申请截止日期）</dd>
      <dt>采集时间</dt><dd>{metadata.retrievedAt}</dd>
      <dt>来源版本</dt><dd>{preview.source.versionHash}</dd>
    </dl>
    {metadata.partial && <p className="resource-notice">来源为不完整文本：图片、二维码或嵌入内容未读取；缺失条件必须保持未知。</p>}
    <Warnings warnings={preview.warnings}/>
    <details><summary>展开原始公告纯文本</summary><pre className="career-source-text">{preview.source.text}</pre></details>
  </section>;
}

type Fact = NonNullable<CareerDraft['candidate']['title']>;
type Information = NonNullable<CareerDraft['candidate']['information']>['title'];
function EvidenceFact({ label, fact }: { label: string; fact: Fact | null }) {
  return <div className="career-evidence-fact"><strong>{label}：{fact?.value ?? '未知，需人工核对'}</strong>
    {fact && <details><summary>原文证据 · {fact.evidence.start}–{fact.evidence.end}</summary><pre className="career-source-text">{fact.evidence.quote}</pre></details>}
  </div>;
}
function Warnings({ warnings }: { warnings: string[] }) {
  return warnings.length ? <ul className="career-source-warnings">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null;
}
function EvidenceSlot({ label, information, fallback }: { label: string; information?: Information; fallback?: Fact | Fact[] | null }) {
  const facts = Array.isArray(fallback) ? fallback : fallback ? [fallback] : [];
  const item = information ?? { status: facts.length ? 'known' : 'unknown', facts };
  return <div className="career-evidence-slot">
    <strong>{label}：{item.status === 'unknown' ? '未提供/待核实' : item.status === 'conflict' ? '信息冲突，待核实' : '有原文依据，仍需审核'}</strong>
    {item.facts.length > 0 && <ul>{item.facts.map((fact, index) => <li key={index}><EvidenceFact label={item.status === 'conflict' ? `冲突候选 ${index + 1}` : `条目 ${index + 1}`} fact={fact}/></li>)}</ul>}
  </div>;
}
export function CareerCandidateReview({ draft }: { draft: CareerDraft }) {
  const candidate = draft.candidate;
  return <section className="career-candidate-review" aria-label="待人工审核候选">
    <h3>待人工审核候选</h3><p>模型：{draft.provider} · {candidate.positions.length} 个岗位分组。逐条核对事实、引用与岗位归属；候选未导入或发布到公共岗位库。</p>
    <Warnings warnings={draft.warnings}/>
    <p>固定信息清单：有原文依据才填值；未提供或不确定保留未知，冲突保留原文候选待核实。不会创造字段或事实。</p>
    <h4>公告信息清单</h4>
    <EvidenceSlot label="公告标题" information={candidate.information?.title} fallback={candidate.title}/>
    <EvidenceSlot label="用人单位" information={candidate.information?.employer} fallback={candidate.employer}/>
    <EvidenceSlot label="申请截止日期" information={candidate.information?.applicationDeadline} fallback={candidate.applicationDeadline}/>
    <EvidenceSlot label="招聘总人数" information={candidate.information?.recruitmentCount} fallback={candidate.recruitmentCount}/>
    <EvidenceSlot label="公告薪资待遇" information={candidate.information?.salary} fallback={candidate.salary}/>
    <EvidenceSlot label="申请渠道" information={candidate.information?.applicationChannels} fallback={candidate.applicationChannels}/>
    <EvidenceSlot label="申请材料" information={candidate.information?.requiredMaterials} fallback={candidate.requiredMaterials}/>
    <EvidenceSlot label="公告共同要求" information={candidate.information?.sharedRequirements} fallback={candidate.sharedRequirements}/>
    {candidate.partial && <p className="resource-notice">本候选信息不完整：来源图片未读、未知条目或数组超过展示上限时均需核对完整原网页。</p>}
    {!!candidate.truncatedFields?.length && <Warnings warnings={candidate.truncatedFields.map(field => `${field}：部分内容未展示或未知，请核对原网页`)}/>}
    {!!candidate.missingInformation?.length && <details><summary>缺失或待核实信息（{candidate.missingInformation.length}）</summary><Warnings warnings={candidate.missingInformation}/></details>}
    {!candidate.positions.length && <p>岗位分组：未提供/待核实。图片中的岗位信息未推断。</p>}
    {candidate.positions.map((position, index) => <section className="career-position-review" key={index}>
      <h4>岗位 {index + 1}：{position.information?.title.status === 'conflict' ? '岗位名称冲突，待核实' : position.title?.value ?? '名称未提供/待核实'}</h4>
      <EvidenceSlot label="岗位名称" information={position.information?.title} fallback={position.title}/>
      <EvidenceSlot label="工作地点（可多值）" information={position.information?.locations} fallback={position.locations ?? position.location}/>
      <EvidenceSlot label="学历" information={position.information?.degree} fallback={position.degree}/>
      <EvidenceSlot label="招聘人数" information={position.information?.headcount} fallback={position.headcount}/>
      <EvidenceSlot label="专业要求（可多值）" information={position.information?.majors} fallback={position.majors}/>
      <EvidenceSlot label="岗位薪资待遇" information={position.information?.salary} fallback={position.salary}/>
      <EvidenceSlot label="岗位申请材料" information={position.information?.requiredMaterials} fallback={position.requiredMaterials}/>
      <EvidenceSlot label="岗位要求" information={position.information?.requirements} fallback={position.requirements}/>
      <details><summary>岗位原文分段 · {position.section.start}–{position.section.end}</summary><pre className="career-source-text">{position.section.quote}</pre></details>
    </section>)}
    <h4>歧义与待核对事项</h4>{candidate.ambiguities.length ? <Warnings warnings={candidate.ambiguities}/> : <p>模型未列出歧义，不代表来源准确或信息完整。</p>}
  </section>;
}
