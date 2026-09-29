import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import {
  Activity, BriefcaseBusiness, CalendarDays, ChartNoAxesCombined, CheckCheck,
  ChevronRight, ClipboardList, Cloud, House, LoaderCircle, LogOut, Menu,
  RefreshCw, Settings, Shield, UserRound, X,
} from 'lucide-react';
import { ApiError, get, post, api } from './api/client';
import { dataSource } from './api/transport';
import type { components } from './api/schema';
import { ActionContext, Modal, PageHead, Panel, useResource } from './components';
import { queueCount, synchronizeUser } from './offline';
import { platform } from './platform';
import { registerServiceWorker } from './pwa';
import { ProfilePage } from './pages/ProfilePage';
import { JobsPage } from './pages/JobsPage';
import { MatchingPage } from './pages/MatchingPage';
import { PlanningPage } from './pages/PlanningPage';
import { TrackingPage } from './pages/TrackingPage';
import { AdminPage } from './pages/AdminPage';
import { SettingsPage } from './pages/SettingsPage';

type Session = components['schemas']['SessionResponse'];

const navigation = [
  { to: '/', label: '工作台', icon: House },
  { to: '/profile', label: '画像与证据', icon: UserRound },
  { to: '/jobs', label: '岗位库', icon: BriefcaseBusiness },
  { to: '/match', label: '匹配与组合', icon: ChartNoAxesCombined },
  { to: '/plan', label: '计划与改写', icon: CalendarDays },
  { to: '/applications', label: '投递跟踪', icon: ClipboardList },
  { to: '/admin', label: '管理员岗位', icon: Shield, admin: true },
  { to: '/settings', label: '设置与同步', icon: Settings },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [conflict, setConflict] = useState<{ message: string; server?: unknown } | null>(null);
  const [pending, setPending] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<((reloadPage?: boolean) => Promise<void>) | null>(null);
  const location = useLocation();

  const reload = useCallback(() => setRefresh((current) => current + 1), []);

  useEffect(() => {
    let update: ((reloadPage?: boolean) => Promise<void>) | null = null;
    update = registerServiceWorker({
      onNeedRefresh: () => setPendingUpdate(() => update),
      onOfflineReady: () => setMessage({ kind: 'success', text: '应用外壳已缓存，可以离线打开工作台。' }),
      onError: (error) => console.warn('Service Worker 注册失败', error),
    });
    return () => setPendingUpdate(null);
  }, []);

  useEffect(() => {
    let active = true;
    get<Session>('/session')
      .then((value) => active && setSession(value))
      .catch((error: unknown) => active && setSessionError(error instanceof Error ? error.message : '无法连接服务端'))
      .finally(() => active && setSessionLoading(false));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) {
      setPending(0);
      return;
    }
    void queueCount(userId).then(setPending);
  }, [refresh, session?.user?.id]);

  useEffect(() => {
    const userId = session?.user?.id;
    if (!session?.authenticated || !userId) return;
    let active = true;
    let synchronizing = false;
    const syncWhenOnline = async () => {
      if (!platform.network.isOnline() || synchronizing) return;
      synchronizing = true;
      try {
        const result = await synchronizeUser(userId);
        if (!active) return;
        setPending(result.pending);
        if (result.submitted > 0) setRefresh((current) => current + 1);
      } catch {
        // Keep queued operations available for a later online/focus event.
      } finally {
        synchronizing = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void syncWhenOnline();
    };
    const stopNetworkWatch = platform.network.subscribe((online) => {
      if (online) void syncWhenOnline();
    });
    void syncWhenOnline();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      stopNetworkWatch();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [session?.authenticated, session?.user?.id]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  async function run(operation: () => Promise<unknown>, success = '已完成'): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      await operation();
      setMessage({ kind: 'success', text: success });
      reload();
      window.setTimeout(() => setMessage((current) => current?.text === success ? null : current), 3_500);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict({ message: error.message, server: error.serverRecord });
      } else {
        setMessage({ kind: 'error', text: error instanceof Error ? error.message : '操作失败，请重试。' });
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function login(userId: string) {
    await run(async () => {
      const value = await post<Session>('/session', { userId });
      setSession(value);
      setSessionError('');
    }, '已进入演示工作台');
  }

  async function logout() {
    await run(async () => {
      await api('/session', { method: 'DELETE' });
      // 退出后重新读取会话，登录页需要服务端返回的演示身份列表。
      setSession(await get<Session>('/session'));
      setSessionError('');
      setRefresh((current) => current + 1);
    }, '已退出');
  }

  if (sessionLoading) return <div className="app-loading"><LoaderCircle className="spin"/>正在连接工作台…</div>;
  if (!session?.authenticated) {
    return <>
      {pendingUpdate && <UpdateBanner onUpdate={() => void pendingUpdate(true)}/>}
      <LoginScreen session={session} error={sessionError} busy={busy} onLogin={login}/>
    </>;
  }

  const user = session.user ?? undefined;
  const isAdmin = user?.role === 'admin';
  const actionContext: ActionContext = { userId: user?.id ?? '', refresh, busy, run };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">实</div>
          <span><b>实习工作台</b><small>DECISION & ACTION</small></span>
          <button className="icon-btn mobile-close" aria-label="关闭菜单" onClick={() => setMobileOpen(false)}><X size={18}/></button>
        </div>
        <div className="demo-banner">演示站 · 虚构数据</div>
        <nav aria-label="主导航">
          {navigation.filter((item) => !item.admin || isAdmin).map(({ to, label, icon: Icon }) => (
            <NavLink key={to} end={to === '/'} to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <Icon size={18}/><span>{label}</span>
              {to === '/settings' && pending > 0 && <i className="count">{pending}</i>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="who">
            <span className="avatar">{user?.displayName.slice(0, 1) ?? '演'}</span>
            <span><b>{user?.displayName ?? '演示用户'}</b><small>{isAdmin ? '管理员身份' : '学生身份'}</small></span>
            <button className="icon-btn" title="退出登录" onClick={() => void logout()}><LogOut size={16}/></button>
          </div>
          <div className="api-indicator"><span className="dot"/>{dataSource === 'demo' ? '内置演示数据源' : '后端会话已连接'}</div>
        </div>
      </aside>
      {mobileOpen && <button className="sidebar-scrim" aria-label="关闭菜单" onClick={() => setMobileOpen(false)}/>}

      <main className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label="打开菜单" onClick={() => setMobileOpen(true)}><Menu size={20}/></button>
          <div className="breadcrumbs">工作台 <span>/</span> {navigation.find((item) => item.to === location.pathname)?.label ?? '页面'}</div>
          <div className="top-actions">
            <span className="sync-pill"><Cloud size={15}/>{pending ? `${pending} 项待同步` : '已同步'}</span>
            <button className="icon-btn" title="刷新数据" onClick={reload}><RefreshCw size={17}/></button>
            <span className="avatar mini" title={user?.displayName}>{user?.displayName.slice(0, 1) ?? '演'}</span>
          </div>
        </header>

        <div className="content" aria-live="polite">
          {pendingUpdate && <UpdateBanner onUpdate={() => void pendingUpdate(true)}/>}
          {message && <div className={`toast ${message.kind}`} role="status"><CheckCheck size={16}/>{message.text}</div>}
          {busy && <div className="busy-line"><LoaderCircle className="spin" size={15}/>正在处理…</div>}
          <Routes>
            <Route path="/" element={<Dashboard context={actionContext} pending={pending}/>}/>
            <Route path="/profile" element={<ProfilePage context={actionContext}/>}/>
            <Route path="/jobs" element={<JobsPage context={actionContext}/>}/>
            <Route path="/match" element={<MatchingPage context={actionContext}/>}/>
            <Route path="/plan" element={<PlanningPage context={actionContext}/>}/>
            <Route path="/applications" element={<TrackingPage context={actionContext}/>}/>
            <Route path="/admin" element={isAdmin ? <AdminPage context={actionContext} user={user}/> : <Navigate to="/" replace/>}/>
            <Route path="/settings" element={<SettingsPage context={actionContext} pending={pending}/>}/>
            <Route path="*" element={<Navigate to="/" replace/>}/>
          </Routes>
        </div>
        <footer>分析分数用于解释排序，不代表录取概率。<span>数据由当前演示服务端提供</span></footer>
      </main>
      <MobileNavigation/>

      {conflict && <ConflictDialog
        conflict={conflict}
        onUseServer={() => { setConflict(null); reload(); }}
        onKeepLocal={() => { setConflict(null); setMessage({ kind: 'error', text: '本地表单内容仍保留。请对照服务端版本后重新提交，服务端会再次检查版本。' }); }}
      />}
    </div>
  );
}

function UpdateBanner({ onUpdate }: { onUpdate: () => void }) {
  return <div className="update-banner" role="status">
    <span>工作台有新版本可用</span>
    <button className="btn small primary" onClick={onUpdate}>立即更新</button>
  </div>;
}

function MobileNavigation() {
  const items = navigation.filter((item) => ['/', '/profile', '/jobs', '/match', '/applications'].includes(item.to));
  return <nav className="mobile-bottom-nav" aria-label="常用页面">
    {items.map(({ to, label, icon: Icon }) => <NavLink key={to} end={to === '/'} to={to} className={({ isActive }) => isActive ? 'active' : ''}>
      <Icon size={18}/><span>{label === '画像与证据' ? '画像' : label === '匹配与组合' ? '匹配' : label === '投递跟踪' ? '投递' : label}</span>
    </NavLink>)}
  </nav>;
}

function LoginScreen({
  session,
  error,
  busy,
  onLogin,
}: {
  session: Session | null;
  error: string;
  busy: boolean;
  onLogin: (id: string) => Promise<void>;
}) {
  const users = session?.demoUsers ?? [];
  return (
    <main className="login">
      <section className="login-card">
        <div className="brand-mark">实</div>
        <span className="eyebrow">演示站 · 虚构数据</span>
        <h1>进入实习工作台</h1>
        <p>选择由服务端提供的演示身份。身份和权限以服务端会话为准。</p>
        {error && <div className="alert"><Activity size={17}/><span>{error}</span></div>}
        {users.length > 0 ? (
          <div className="login-users">
            {users.map((user) => <button className="user-choice" key={user.id} disabled={busy} onClick={() => void onLogin(user.id)}>
              <span className="avatar">{user.displayName.slice(0, 1)}</span>
              <span><b>{user.displayName}</b><small>{user.role === 'admin' ? '管理员' : '演示学生'}</small></span>
              <ChevronRight size={18}/>
            </button>)}
          </div>
        ) : (
          <div className="empty login-empty">
            <span>{error ? '无法连接演示服务，请启动后端并刷新。' : '服务端未提供演示身份。'}</span>
          </div>
        )}
        <small className="muted">本环境使用演示账号，不提供真实注册或简历投递。</small>
      </section>
    </main>
  );
}

function Dashboard({ context, pending }: { context: ActionContext; pending: number }) {
  const profile = useResource<components['schemas']['Profile']>('/profile', context.refresh, context.userId);
  const jobs = useResource<components['schemas']['JobListResponse']>('/jobs?scope=public', context.refresh, context.userId);
  const plans = useResource<{ items: components['schemas']['Plan'][] }>('/plans', context.refresh, context.userId);
  const notifications = useResource<components['schemas']['NotificationListResponse']>('/notifications', context.refresh, context.userId);
  const from = new Date();
  from.setDate(1);
  const to = new Date();
  const statsUrl = `/applications/stats?from=${ymd(from)}&to=${ymd(to)}`;
  const stats = useResource<components['schemas']['EfficiencyStats']>(statsUrl, context.refresh, context.userId);

  return <>
    <PageHead kicker="求职进度概览" title="早上好，开始推进下一步" description="从已确认的画像和计划开始，记录每次投递行动与实际投入。"/>
    <div className="stats">
      <StatCard label="目标岗位" value={profile.data?.targetRoles.length ?? '—'} note={profile.data?.targetRoles.join('、') || '尚未设置'}/>
      <StatCard label="公开岗位" value={jobs.data?.items.length ?? '—'} note="当前可见岗位数"/>
      <StatCard label="待确认计划" value={plans.data?.items.filter((plan) => plan.status === 'draft').length ?? '—'} note="草稿确认后任务才生效"/>
      <StatCard label="面试效率" value={stats.data?.efficiency == null ? '暂无数据' : stats.data.efficiency.toFixed(1)} note="每 10 小时获得面试数"/>
    </div>
    <div className="two-col">
      <Panel title="最近计划" description="计划草稿需由你确认后才会安排执行">
        {plans.error && <p className="inline-error">{plans.error}</p>}
        {plans.data?.items.length ? <div className="data-list">{plans.data.items.slice(0, 4).map((plan) => <div className="data-row" key={plan.id}>
          <div className="row-main"><div className="row-title">求职计划 <span className={`badge ${plan.status === 'confirmed' ? 'good' : 'warn'}`}>{plan.status === 'confirmed' ? '已确认' : plan.status}</span></div><small>更新于 {new Date(plan.updatedAt).toLocaleDateString('zh-CN')}</small></div>
        </div>)}</div> : <div className="empty">尚未生成计划。</div>}
      </Panel>
      <Panel title="提醒与同步" description="到期任务和面试提醒都可以在设置中管理">
        <div className="dashboard-metric"><strong>{notifications.data?.unreadCount ?? '—'}</strong><span>条未读站内提醒</span></div>
        <p className="muted">本机等待同步：{pending} 项</p>
        <div className="button-row"><NavLink className="btn secondary" to="/settings">打开同步中心 <ChevronRight size={15}/></NavLink></div>
      </Panel>
    </div>
    <Panel title="下一步" description="一条完整工作流：确认画像 → 选择岗位 → 查看解释 → 建立计划 → 记录投递与工时">
      <div className="next-grid">
        <QuickLink to="/profile" icon={<UserRound/>} title="完善画像与证据" description="确认经历原文与技能引用。"/>
        <QuickLink to="/jobs" icon={<BriefcaseBusiness/>} title="浏览或添加岗位" description="公共岗位和私人 JD 分开管理。"/>
        <QuickLink to="/match" icon={<ChartNoAxesCombined/>} title="生成匹配解释" description="硬条件、分项分数与引用均来自服务端。"/>
        <QuickLink to="/applications" icon={<ClipboardList/>} title="记录投递与工时" description="查看状态历史与实际投入效率。"/>
      </div>
    </Panel>
  </>;
}

function StatCard({ label, value, note }: { label: string; value: ReactNode; note: string }) {
  return <div className="stat-card"><small>{label}</small><strong>{value}</strong><span>{note}</span></div>;
}

function QuickLink({ to, icon, title, description }: { to: string; icon: ReactNode; title: string; description: string }) {
  return <NavLink to={to} className="quick">{icon}<b>{title}</b><small>{description}</small></NavLink>;
}

function ConflictDialog({
  conflict,
  onUseServer,
  onKeepLocal,
}: {
  conflict: { message: string; server?: unknown };
  onUseServer: () => void;
  onKeepLocal: () => void;
}) {
  return <Modal title="记录版本已变化" onClose={onKeepLocal}>
    <p className="conflict-message">{conflict.message}</p>
    <p>服务端保留了当前版本。你可以载入它，或保留表单中的本地编辑并重新核对。</p>
    {conflict.server !== undefined && <pre className="conflict-json">{JSON.stringify(conflict.server, null, 2)}</pre>}
    <div className="button-row end">
      <button className="btn secondary" onClick={onKeepLocal}>保留本地表单</button>
      <button className="btn primary" onClick={onUseServer}>载入服务端版本</button>
    </div>
  </Modal>;
}

function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
