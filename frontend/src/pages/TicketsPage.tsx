import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { post } from '../api/client';
import { DataRows, InlineError, Modal, PageHead, Panel, ResourceNotice, type ActionContext } from '../components';
import { ticketStatusLabel, useTicketList, type TicketDetail, type TicketStatus } from './tickets-data';
import { isAdministrativeRole } from '../roles';
import type { TicketAccess } from './tickets-access';

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  const color = status === 'resolved' ? 'good' : status === 'closed' ? 'neutral' : 'warn';
  return <span className={`badge ${color}`}>{ticketStatusLabel(status)}</span>;
}

export function TicketsPage({ context, access }: { context: ActionContext; access: TicketAccess }) {
  const [refresh, setRefresh] = useState(0);
  const list = useTicketList(access, context.refresh + refresh);
  const staff = isAdministrativeRole(access.role);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  return <>
    <PageHead kicker="问题与反馈" title={staff ? '全部支持工单' : '我的支持工单'} description={staff ? '查看用户反馈、回复问题并跟进处理状态。工单只在线读取。' : '提交使用问题并查看管理员回复。你只能查看自己的工单，内容不会保存到离线缓存。'} action={<button className="btn primary" onClick={() => setCreating(true)}><Plus size={16}/>新建工单</button>}/>
    <Panel title="工单列表" description="按创建时间从新到旧排列，每次加载 20 条">
      <ResourceNotice error={list.error}/>
      {list.error && <button className="btn small secondary" onClick={() => setRefresh(value => value + 1)}>重新加载工单</button>}
      {!list.error || list.data ? <DataRows items={list.data?.items ?? []} loading={list.loading} empty="还没有工单。遇到问题时，可以在这里提交并跟进。">
        {ticket => <Link className="ticket-list-row" to={`/tickets/${encodeURIComponent(ticket.id)}`}>
          <div className="row-main"><div className="row-title">{ticket.subject}<TicketStatusBadge status={ticket.status}/></div><small>创建：{new Date(ticket.createdAt).toLocaleString('zh-CN')} · 更新：{new Date(ticket.updatedAt).toLocaleString('zh-CN')}</small></div>
          <span className="ticket-open">查看工单 →</span>
        </Link>}
      </DataRows> : null}
      {list.data?.nextCursor && <div className="button-row"><button className="btn secondary" disabled={list.loadingMore} onClick={() => void list.loadMore()}>{list.loadingMore ? '正在加载…' : '加载更多工单'}</button><small className="muted">已显示 {list.data.items.length} 条</small></div>}
    </Panel>
    {creating && <CreateTicketDialog busy={context.busy} onClose={() => setCreating(false)} onCreated={ticket => { setCreating(false); navigate(`/tickets/${encodeURIComponent(ticket.id)}`); }}/>}
  </>;
}

function CreateTicketDialog({ busy, onClose, onCreated }: { busy: boolean; onClose: () => void; onCreated: (ticket: TicketDetail) => void }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !subject.trim() || !body.trim()) return;
    submitting.current = true; setSaving(true); setError('');
    try {
      const ticket = await post<TicketDetail>('/tickets', { subject: subject.trim(), body: body.trim() });
      if (mounted.current) onCreated(ticket);
    }
    catch (value) { if (mounted.current) setError(value instanceof Error ? value.message : '工单提交失败，请重试。'); }
    finally { submitting.current = false; if (mounted.current) setSaving(false); }
  }
  return <Modal title="新建支持工单" onClose={() => { if (!submitting.current) onClose(); }}>
    <form className="form-grid" onSubmit={event => void submit(event)}>
      <p className="muted form-notice">请说明遇到的问题和复现步骤。仅支持纯文字，请勿填写密码、API 密钥或支付凭据。</p>
      <label className="field form-notice"><span>工单标题</span><input required maxLength={160} value={subject} disabled={saving || busy} onChange={event => setSubject(event.target.value)}/><small>{subject.length}/160</small></label>
      <label className="field"><span>问题描述</span><textarea required rows={7} maxLength={5000} value={body} disabled={saving || busy} onChange={event => setBody(event.target.value)}/><small>{body.length}/5000</small></label>
      {error && <div className="form-notice"><InlineError>{error}</InlineError></div>}
      <div className="button-row form-notice"><button className="btn primary" disabled={saving || busy || !subject.trim() || !body.trim()}>{saving ? '正在提交…' : '提交工单'}</button><button type="button" className="btn secondary" disabled={saving} onClick={onClose}>取消</button></div>
    </form>
  </Modal>;
}
