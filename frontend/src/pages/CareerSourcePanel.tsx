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
function EvidenceFact({ label, fact }: { label: string; fact: Fact | null }) {
  return <div className="career-evidence-fact"><strong>{label}：{fact?.value ?? '未知，需人工核对'}</strong>
    {fact && <details><summary>原文证据 · {fact.evidence.start}–{fact.evidence.end}</summary><pre className="career-source-text">{fact.evidence.quote}</pre></details>}
  </div>;
}
function Warnings({ warnings }: { warnings: string[] }) {
  return warnings.length ? <ul className="career-source-warnings">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null;
}
export function CareerCandidateReview({ draft }: { draft: CareerDraft }) {
  const candidate = draft.candidate;
  return <section className="career-candidate-review" aria-label="待人工审核候选">
    <h3>待人工审核候选</h3><p>模型：{draft.provider} · {candidate.positions.length} 个岗位分组。逐条核对事实、引用与岗位归属；候选未导入或发布到公共岗位库。</p>
    <Warnings warnings={draft.warnings}/>
    <EvidenceFact label="公告标题" fact={candidate.title}/><EvidenceFact label="用人单位" fact={candidate.employer}/><EvidenceFact label="申请截止日期" fact={candidate.applicationDeadline}/>
    <h4>公告共同要求</h4>{candidate.sharedRequirements.length ? candidate.sharedRequirements.map((fact, index) => <EvidenceFact key={index} label={`共同要求 ${index + 1}`} fact={fact}/>) : <p>没有已提取的共同要求，不能据此断言没有要求。</p>}
    {candidate.positions.map((position, index) => <section className="career-position-review" key={index}>
      <h4>岗位 {index + 1}：{position.title.value}</h4><EvidenceFact label="岗位名称" fact={position.title}/><EvidenceFact label="工作地点" fact={position.location}/><EvidenceFact label="学历" fact={position.degree}/>
      {position.requirements?.length ? position.requirements.map((fact, requirement) => <EvidenceFact key={requirement} label={`岗位要求 ${requirement + 1}`} fact={fact}/>) : <p>岗位要求未知或未提取，需核对完整原网页。</p>}
      <details><summary>岗位原文分段 · {position.section.start}–{position.section.end}</summary><pre className="career-source-text">{position.section.quote}</pre></details>
    </section>)}
    <h4>歧义与待核对事项</h4>{candidate.ambiguities.length ? <Warnings warnings={candidate.ambiguities}/> : <p>模型未列出歧义，不代表来源准确或信息完整。</p>}
  </section>;
}
