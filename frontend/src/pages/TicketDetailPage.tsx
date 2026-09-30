import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, patch, post } from '../api/client';
import { InlineError, Loading, PageHead, Panel, ResourceNotice, type ActionContext } from '../components';
import { TicketStatusBadge } from './TicketsPage';
import { ticketStatuses, useTicketDetail, type TicketDetail, type TicketStatus } from './tickets-data';
import { isAdministrativeRole } from '../roles';
import { ticketAccessScope, type TicketAccess } from './tickets-access';

export function TicketDetailPage({ context, access }: { context: ActionContext; access: TicketAccess }) {
  const { id = '' } = useParams();
  // Keying the body also clears unsent drafts when navigating between accounts/tickets.
  return <TicketThread key={`${ticketAccessScope(access.userId, access.role)}:${id}`} id={id} context={context} access={access}/>;
}

function TicketThread({ id, context, access }: { id: string; context: ActionContext; access: TicketAccess }) {
  const [refresh, setRefresh] = useState(0);
  const resource = useTicketDetail(access, id, context.refresh + refresh);
  const staff = isAdministrativeRole(access.role);
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<TicketStatus>('pending');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (resource.data) setStatus(resource.data.status); }, [resource.data]);

  async function submit(event: FormEvent, statusChange: boolean) {
    event.preventDefault();
    if (submitting.current || !resource.data || (statusChange && !staff)) return;
    if (!statusChange && (!body.trim() || resource.data.status === 'closed')) return;
    submitting.current = true; setSaving(true); setError(''); setMessage('');
    try {
      const updated = statusChange
        ? await patch<TicketDetail>(`/tickets/${encodeURIComponent(id)}/status`, { status })
        : await post<TicketDetail>(`/tickets/${encodeURIComponent(id)}/messages`, { body: body.trim() });
      if (!mounted.current) return;
      if (!await resource.replace(updated)) return;
      if (!statusChange) setBody('');
      setMessage(statusChange ? '工单状态已更新' : '回复已发送');
    } catch (value) {
      if (!mounted.current) return;
      setError(value instanceof Error ? value.message : '提交失败，请重试。');
      if (value instanceof ApiError && [401, 403, 404, 409].includes(value.status)) setRefresh(current => current + 1);
    } finally { submitting.current = false; if (mounted.current) setSaving(false); }
  }

  return <>
    <Link className="btn secondary ticket-back" to="/tickets">← 返回工单列表</Link>
    <PageHead kicker="支持工单" title={resource.data?.subject ?? '工单详情'} description={resource.data ? `创建于 ${new Date(resource.data.createdAt).toLocaleString('zh-CN')} · 更新于 ${new Date(resource.data.updatedAt).toLocaleString('zh-CN')}` : '在线读取当前账户有权限查看的工单。'}/>
    <ResourceNotice error={resource.error}/>
    {resource.error && <button className="btn secondary" onClick={() => setRefresh(value => value + 1)}>重新加载详情</button>}
    {resource.loading && <Loading label="正在读取工单…"/>}
    {error && <InlineError>{error}</InlineError>}
    {message && <p className="success-note" role="status">{message}</p>}
    {resource.data && <>
      <Panel title="当前状态" action={<TicketStatusBadge status={resource.data.status}/>}>
        {staff ? <form className="ticket-status-form" onSubmit={event => void submit(event, true)}>
          <label className="field"><span>更新工单状态</span><select value={status} disabled={saving || context.busy} onChange={event => setStatus(event.target.value as TicketStatus)}>{ticketStatuses.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <button className="btn primary" disabled={saving || context.busy || status === resource.data.status}>保存状态</button>
          <p className="muted">关闭后暂停回复；重新选择其他状态可继续处理。</p>
        </form> : <p className="muted">管理员会根据处理进展更新工单状态。</p>}
      </Panel>
      <Panel title="沟通记录" description={resource.data.messagesNextCursor ? '当前显示部分消息，可加载更早记录。消息按时间从早到晚排列。' : '已显示全部消息，按时间从早到晚排列。'}>
        {resource.data.messagesNextCursor && <button className="btn secondary" disabled={resource.loadingOlder || saving} onClick={() => void resource.loadOlder()}>{resource.loadingOlder ? '正在加载…' : '加载更早消息'}</button>}
        <TicketConversation messages={resource.data.messages}/>
      </Panel>
      <Panel title="回复工单" description="回复以纯文字发送，仅工单所属用户和管理员可见。">
        {resource.data.status === 'closed' && <p className="resource-notice">工单已关闭，暂时不能回复。管理员可重新打开工单。</p>}
        <form className="form-grid" onSubmit={event => void submit(event, false)}>
          <label className="field"><span>回复内容</span><textarea required rows={5} maxLength={5000} value={body} disabled={saving || context.busy || resource.data.status === 'closed'} onChange={event => setBody(event.target.value)}/><small>{body.length}/5000 · 请勿发送密码、API 密钥或支付凭据</small></label>
          <div className="button-row form-notice"><button className="btn primary" disabled={saving || context.busy || resource.data.status === 'closed' || !body.trim()}>{saving ? '正在提交…' : '发送回复'}</button></div>
        </form>
      </Panel>
    </>}
  </>;
}

export function TicketConversation({ messages }: { messages: TicketDetail['messages'] }) {
  return <ol className="ticket-messages">{messages.map(item => <li className={`ticket-message${item.isStaff ? ' staff' : ''}`} key={item.id}>
    <div className="row-title">{item.authorName}<span className={`badge ${item.isStaff ? 'good' : 'neutral'}`}>{item.isStaff ? '管理员回复' : '用户留言'}</span></div>
    <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN')}</time>
    <p className="ticket-message-body">{item.body}</p>
  </li>)}</ol>;
}
