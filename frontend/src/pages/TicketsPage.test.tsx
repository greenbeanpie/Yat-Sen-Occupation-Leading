import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '../components';
import { TicketsPage, TicketStatusBadge } from './TicketsPage';
import { TicketConversation, TicketDetailPage } from './TicketDetailPage';
import { useTicketDetail, useTicketList, type TicketDetail } from './tickets-data';

vi.mock('./tickets-data', async () => ({
  ...await vi.importActual('./tickets-data'),
  useTicketDetail: vi.fn(),
  useTicketList: vi.fn(),
}));

const context: ActionContext = { userId: 'actor', refresh: 0, busy: false, run: async () => true };
const ticket: TicketDetail = { id: 'ticket-1', subject: '无法打开岗位页面', status: 'pending', createdAt: '2026-09-30T10:00:00Z', updatedAt: '2026-09-30T10:00:00Z', messagesNextCursor: null, messages: [
  { id: 'message-1', body: '<script>alert("test")</script>\n第二行', authorName: '用户 <img>', isStaff: false, createdAt: '2026-09-30T10:00:00Z' },
  { id: 'message-2', body: '请提供复现步骤', authorName: '支持管理员', isStaff: true, createdAt: '2026-09-30T10:10:00Z' },
] };
const detailState = (data: TicketDetail | null = ticket) => ({ data, loading: false, loadingOlder: false, error: '', loadOlder: async () => undefined, replace: () => undefined });
const renderDetail = (staff: boolean) => renderToStaticMarkup(<StaticRouter location="/tickets/ticket-1"><Routes><Route path="/tickets/:id" element={<TicketDetailPage context={context} staff={staff}/>}/></Routes></StaticRouter>);

beforeEach(() => {
  vi.mocked(useTicketDetail).mockReturnValue(detailState());
  vi.mocked(useTicketList).mockReturnValue({ data: { items: [], nextCursor: null }, loading: false, loadingMore: false, error: '', loadMore: async () => undefined });
});

describe('ticket presentation and privacy', () => {
  it('renders message bodies and author names strictly as escaped plain text', () => {
    const html = renderToStaticMarkup(<TicketConversation messages={ticket.messages}/>);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('用户 &lt;img&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img>');
    expect(html).toContain('管理员回复');
    expect(html).toContain('用户留言');
  });

  it('shows Chinese status badges', () => {
    expect(renderToStaticMarkup(<TicketStatusBadge status="closed"/>)).toContain('已关闭');
    expect(renderToStaticMarkup(<TicketStatusBadge status="resolved"/>)).toContain('badge good');
  });

  it('does not show status-editing controls to general users', () => {
    const html = renderDetail(false);
    expect(html).toContain('回复内容');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('保存状态');
    expect(html).toContain('密码、API 密钥或支付凭据');
  });

  it('offers status changes and reopening to staff', () => {
    const html = renderDetail(true);
    expect(html).toContain('更新工单状态');
    expect(html).toContain('保存状态');
    expect(html).toContain('重新选择其他状态可继续处理');
  });

  it('disables reply input when the ticket is closed', () => {
    vi.mocked(useTicketDetail).mockReturnValue(detailState({ ...ticket, status: 'closed' }));
    const html = renderDetail(false);
    expect(html).toMatch(/<textarea[^>]+disabled=""/);
    expect(html).toContain('工单已关闭，暂时不能回复');
  });

  it('offers older-message pagination without claiming all messages are loaded', () => {
    vi.mocked(useTicketDetail).mockReturnValue(detailState({ ...ticket, messagesNextCursor: 'older' }));
    const html = renderDetail(false);
    expect(html).toContain('加载更早消息');
    expect(html).toContain('当前显示部分消息');
    expect(html).not.toContain('已显示全部消息');
  });

  it('keeps permission errors distinct from an empty ticket', () => {
    vi.mocked(useTicketDetail).mockReturnValue({ ...detailState(null), error: '无权查看该工单' });
    const html = renderDetail(false);
    expect(html).toContain('无权查看该工单');
    expect(html).toContain('重新加载详情');
    expect(html).not.toContain('回复内容');
  });

  it('shows explicit loading, empty, and paginated list states', () => {
    const render = () => renderToStaticMarkup(<StaticRouter location="/tickets"><TicketsPage context={context} staff={false}/></StaticRouter>);
    expect(render()).toContain('还没有工单');
    vi.mocked(useTicketList).mockReturnValue({ data: null, loading: true, loadingMore: false, error: '', loadMore: async () => undefined });
    expect(render()).toContain('正在加载');
    expect(render()).not.toContain('还没有工单');
    vi.mocked(useTicketList).mockReturnValue({ data: { items: [ticket], nextCursor: 'next' }, loading: false, loadingMore: false, error: '', loadMore: async () => undefined });
    expect(render()).toContain('加载更多工单');
    expect(render()).toContain('/tickets/ticket-1');
  });
});
