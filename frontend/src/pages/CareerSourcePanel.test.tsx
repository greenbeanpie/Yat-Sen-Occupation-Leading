import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CareerCandidateReview, CareerSourceReview } from './CareerSourcePanel';
import type { CareerDraft, CareerReviewState } from './career-source-review';
const state: CareerReviewState = { status: null, listing: null, preview: null, draft: null, selectedId: null, operation: null, error: '', requiresPreview: false };
const render = (value = state) => renderToStaticMarkup(<CareerSourceReview state={value} disabled={false}
  onReadStatus={() => {}} onRefresh={() => {}} onPreview={() => {}} onExtract={() => {}}/>);
describe('administrator announcement review presentation', () => {
  it('explains explicit source fetching, model cost, review boundary and honest empty state', () => {
    const html = render(); expect(html).toContain('获取首页公告'); expect(html).toContain('15 分钟'); expect(html).toContain('1.1 秒');
    expect(html).toContain('不创建或发布公共岗位'); expect(html).toContain('不会自动请求学校网站或模型');
    expect(html).not.toContain('提取待审核候选</button>');
  });
  it('renders source and model output as text, with unknown facts and original evidence for human review', () => {
    const draft: CareerDraft = { status: 'needs-human-review', provider: 'fixture-only', source: { metadata: {
      url: 'https://career.sysu.edu.cn/campus/view/id/1', numericId: '1', retrievedAt: '2026-10-01T12:00:00Z', originalDate: null, sourceExpiry: null, captureMethod: 'static-html-text', partial: true }, text: '<script>bad()</script>', versionHash: 'a'.repeat(64) },
      candidate: { schemaVersion: 1, title: { value: '<img onerror=bad()>', evidence: { start: 0, end: 3, quote: '<script>bad()</script>' } }, employer: null, applicationDeadline: null, sharedRequirements: [], positions: [], ambiguities: ['核对岗位范围'] }, warnings: ['仅测试 fixture'] };
    const html = renderToStaticMarkup(<CareerCandidateReview draft={draft}/>);
    expect(html).toContain('&lt;img'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('申请截止日期：未知'); expect(html).toContain('原文证据'); expect(html).toContain('候选未导入或发布');
    expect(html).toContain('核对岗位范围'); expect(html).not.toMatch(/<button[^>]*>.*(?:发布|确认导入)/);
  });
});
