import { requestSettingsLeave } from './dialogs/settings-leave';
import { NotificationControls } from './notifications/NotificationControls';
import { InstallationNotice } from './notifications/InstallationNotice';
import { unsubscribeDevice, deviceSubscriptionId } from './notifications/core';
import { notificationRequest } from './notifications/api';
import { NotificationRuntime } from './notifications/NotificationRuntime';
import { ThemeSelect, ThemeSync } from './ThemeSelect';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import {
  Activity, BriefcaseBusiness, CalendarDays, ChartNoAxesCombined,
  ChevronRight, ClipboardList, Cloud, House, LoaderCircle, LogOut, Menu,
  RefreshCw, Settings, Shield, Ticket, UserRound, X,
} from 'lucide-react';
import { ApiError, get, post, api } from './api/client';
import {
  beginGuestSession, endGuestSession, getActiveDataSource,
  startDemoMode, stopDemoMode, usingDemoOverride,
} from './api/transport';
import { currentGuestUserId, isGuestUserId } from './guest-mode';
import type { components } from './api/schema';
import { ActionContext, Modal, PageHead, Panel, useResource } from './components';
import { queueCount, synchronizeUser } from './offline';
import { platform } from './platform';
import { ProfilePage } from './pages/ProfilePage';
import { JobsPage } from './pages/JobsPage';
import { MatchingPage } from './pages/MatchingPage';
import { PlanningPage } from './pages/PlanningPage';
import { TrackingPage } from './pages/TrackingPage';
import { AdminPage } from './pages/AdminPage';
import { SettingsHub } from './pages/SettingsHub';
import { AccountSettings } from './pages/AccountSettings';
import { SettingsEditGuard } from './pages/SettingsEditGuard';
import { canAccessAdmin, canAccessTickets, roleLabel } from './roles';
import { TicketsPage } from './pages/TicketsPage';
import { TicketDetailPage } from './pages/TicketDetailPage';
import { ticketAccessScope } from './pages/tickets-access';

type Session = components['schemas']['SessionResponse'];

/** 会话缓存键：离线刷新时用最近一次成功的身份继续打开工作台。 */
const SESSION_CACHE_KEY = 'session:last';

const navigation = [
  { to: '/', label: '工作台', icon: House },
  { to: '/profile', label: '画像与证据', icon: UserRound },
  { to: '/personal-profile', label: '个人资料', icon: UserRound },
  { to: '/jobs', label: '岗位库', icon: BriefcaseBusiness },
  { to: '/match', label: '匹配与组合', icon: ChartNoAxesCombined },
  { to: '/plan', label: '计划与改写', icon: CalendarDays },
  { to: '/applications', label: '投递跟踪', icon: ClipboardList },
  { to: '/admin/jobs', label: '公共岗位管理', icon: Shield, admin: true },
  { to: '/tickets', label: '支持工单', icon: Ticket, account: true },
  { to: '/settings', label: '设置', icon: Settings },
];

export default function App() {
  const logoutLock = useRef(false);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [guestMode, setGuestMode] = useState(getActiveDataSource() === 'guest');
  const sessionLoadId = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [conflict, setConflict] = useState<{ message: string; server?: unknown } | null>(null);
  const [pending, setPending] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    if (!mobileOpen) return;
    const mobile = window.matchMedia('(max-width: 700px)');
    if (!mobile.matches) { setMobileOpen(false); return; }
    const resized = () => { if (!mobile.matches) setMobileOpen(false); };
    mobile.addEventListener('change', resized);
    const sidebar = document.querySelector<HTMLElement>('.sidebar');
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => Array.from(sidebar?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? []).filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    controls()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMobileOpen(false); }
      if (event.key !== 'Tab') return;
      const items = controls();
      const first = items[0]; const last = items[items.length - 1];
      if (!first) return;
      if (event.shiftKey && (document.activeElement === first || !sidebar?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !sidebar?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { mobile.removeEventListener('change', resized); document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
  }, [mobileOpen]);

  const reload = useCallback(() => setRefresh((current) => current + 1), []);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('app-notification-scope', { detail: 'yso:' + (guestMode ? 'guest:' : 'account:') + (session?.user?.id ?? 'anonymous') }));
  }, [session?.user?.id, guestMode]);

  useEffect(() => {
    if (!message) return;
    // Do not retain raw server/provider errors or private submitted text in history.
    window.dispatchEvent(new CustomEvent('app-notification', { detail: { kind: message.kind, text: message.kind === 'error' ? '操作未完成，请检查当前表单并重试。未提交内容仍保留。' : '操作已完成。' } }));
  }, [message]);

  useEffect(() => {
    let active = true;
    const loadId = ++sessionLoadId.current;
    const guestAtStart = getActiveDataSource() === 'guest';
    get<Session>('/session')
      .then(async (value) => {
        if (!active || loadId !== sessionLoadId.current) return;
        const expectedGuestUserId = guestAtStart ? currentGuestUserId() : null;
        if (guestAtStart && (!value.authenticated || !value.user || value.user.id !== expectedGuestUserId || !isGuestUserId(value.user.id))) {
          throw new Error('游客临时会话已失效，请重新进入游客体验。');
        }
        setSession(value);
        if (getActiveDataSource() !== 'guest') {
          await platform.storage.write(SESSION_CACHE_KEY, value);
        }
      })
      .catch(async (error: unknown) => {
        // 断网时应继续显示本机数据，而不是把用户挡在登录页外。
        const cached = guestAtStart ? null : await platform.storage.read<Session>(SESSION_CACHE_KEY);
        if (!active || loadId !== sessionLoadId.current) return;
        if (guestAtStart) {
          await endGuestSession();
          setGuestMode(false);
          setSession(null);
          setSessionError(error instanceof Error ? error.message : '游客体验无法启动，请重试。');
          return;
        }
        if (cached?.authenticated) {
          setSession(cached);
          setSessionError('网络不可用，当前使用本机缓存的演示身份。');
        } else {
          setSessionError(error instanceof Error ? error.message : '无法连接服务端');
        }
      })
      .finally(() => active && loadId === sessionLoadId.current && setSessionLoading(false));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!guestMode) return;
    let updating = false;
    const updateReload = () => { updating = true; };
    window.addEventListener('app-update-reload', updateReload);
    const clearGuestOnPageHide = () => {
      if (updating) return;
      // endGuestSession drops sessionStorage synchronously before IndexedDB cleanup.
      void endGuestSession();
    };
    const leaveGuestAfterRestore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      const loadId = ++sessionLoadId.current;
      setGuestMode(false);
      setSession(null);
      setSessionLoading(true);
      setSessionError('游客体验已结束，临时数据已清除。');
      get<Session>('/session')
        .then((value) => {
          if (loadId === sessionLoadId.current) setSession(value);
        })
        .catch((error: unknown) => {
          if (loadId === sessionLoadId.current) setSessionError(error instanceof Error ? error.message : '无法连接服务端');
        })
        .finally(() => {
          if (loadId === sessionLoadId.current) setSessionLoading(false);
        });
    };
    window.addEventListener('pagehide', clearGuestOnPageHide);
    window.addEventListener('pageshow', leaveGuestAfterRestore);
    return () => {
      window.removeEventListener('app-update-reload', updateReload);
      window.removeEventListener('pagehide', clearGuestOnPageHide);
      window.removeEventListener('pageshow', leaveGuestAfterRestore);
    };
  }, [guestMode]);

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
      if (getActiveDataSource() !== 'guest') await platform.storage.write(SESSION_CACHE_KEY, value);
    }, '已进入演示工作台');
  }

  async function registerAccount(input: { username: string; password: string; invitationCode: string; email?: string; displayName?: string }): Promise<boolean> {
    setBusy(true);
    setSessionError('');
    try {
      const value = await post<Session>('/session/register', input);
      setSession(value);
      await platform.storage.write(SESSION_CACHE_KEY, value);
      return true;
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : '注册失败，请重试。');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function credentialLogin(input: { username: string; password: string }): Promise<boolean> {
    setBusy(true);
    setSessionError('');
    try {
      const value = await post<Session>('/session/login', input);
      setSession(value);
      await platform.storage.write(SESSION_CACHE_KEY, value);
      return true;
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : '登录失败，请重试。');
      return false;
    } finally {
      setBusy(false);
    }
  }

  function enterDemoMode() {
    // 切换到内置演示数据源并整页重载：等价于跳转到当前部署的演示模式。
    startDemoMode();
    window.location.assign('/');
  }

  async function continueAsGuest() {
    setBusy(true);
    setSessionLoading(true);
    setSessionError('');
    try {
      const userId = beginGuestSession();
      sessionLoadId.current += 1;
      setSession(null);
      setGuestMode(true);
      await platform.storage.remove(SESSION_CACHE_KEY);
      const value = await get<Session>('/session');
      if (!value.authenticated || !value.user || !isGuestUserId(value.user.id) || value.user.id !== userId) {
        throw new Error('游客临时会话无法启动，请重试。');
      }
      setSession(value);
      setSessionLoading(false);
    } catch (error) {
      await endGuestSession();
      setGuestMode(false);
      setSession(null);
      setSessionLoading(false);
      setSessionError(error instanceof Error ? error.message : '游客体验无法启动，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (logoutLock.current) return;
    logoutLock.current = true;
    try {
      if (!await requestSettingsLeave()) return;
    if (getActiveDataSource() === 'guest') {
      setSession(null);
      setGuestMode(false);
      await endGuestSession();
      try {
        setSession(await get<Session>('/session'));
        setSessionError('');
      } catch (error) {
        setSessionError(error instanceof Error ? error.message : '无法连接服务端');
      }
      setRefresh((current) => current + 1);
      setMessage({ kind: 'success', text: '游客数据已清除' });
      return;
    }
    if (usingDemoOverride()) {
      // 演示模式（临时入口）退出：回到正式后端的登录页。
      try {
        await api('/session', { method: 'DELETE' });
      } catch {
        // 演示适配器不支持登出时直接退出即可。
      }
      stopDemoMode();
      window.location.assign('/');
      return;
    }
    const loggedOut = await run(async () => {
      const subscriptionId = session?.user ? deviceSubscriptionId(session.user.id) : '';
      if (session?.user && !session.user.demo) await unsubscribeDevice(session.user.id,notificationRequest);
      await api('/session', { method: 'DELETE', headers: session?.user ? { ...(subscriptionId ? {'X-Push-Subscription-Id':subscriptionId} : {}), 'X-Notification-Account': session.user.id } : undefined });
      await platform.storage.remove(SESSION_CACHE_KEY);
      // 退出后重新读取会话，登录页需要服务端返回的演示身份列表。
      setSession(await get<Session>('/session'));
      setSessionError('');
      setRefresh((current) => current + 1);
    }, '已退出');
    if (!loggedOut) window.dispatchEvent(new Event('settings-leave-failed'));
    } finally { logoutLock.current = false; }
  }

  async function refreshAccountSession() {
    const value = await get<Session>('/session');
    if (!value.authenticated) { await accountSessionEnded('会话已失效，请重新登录。'); return; }
    setSession(value);
    await platform.storage.write(SESSION_CACHE_KEY, value);
  }

  async function accountSessionEnded(message: string) {
    setSession(null);
    await platform.storage.remove(SESSION_CACHE_KEY);
    setSessionError(message);
  }

  const onTicketSessionChange = useCallback((value: Session) => {
    setSession(value);
    setSessionError(value.authenticated ? '' : '会话已失效，请重新登录。');
    if (value.authenticated) void platform.storage.write(SESSION_CACHE_KEY, value);
    else void platform.storage.remove(SESSION_CACHE_KEY);
  }, []);

  if (sessionLoading) return <div className="app-loading"><LoaderCircle className="spin"/>正在连接工作台…</div>;
  if (!session?.authenticated) {
    return <>
      <LoginScreen
        session={session}
        error={sessionError}
        busy={busy}
        demoSource={getActiveDataSource() === 'demo'}
        onLogin={login}
        onGuest={continueAsGuest}
        onRegister={registerAccount}
        onCredentialLogin={credentialLogin}
        onDemo={enterDemoMode}
      />
    </>;
  }

  const user = session.user ?? undefined;
  const isAdmin = canAccessAdmin(user);
  const ticketsEnabled = canAccessTickets(user);
  const activeDataSource = getActiveDataSource();
  const actionContext: ActionContext = { userId: user?.id ?? '', refresh, busy, run };

  return (
    <div className="app-shell">
      <ThemeSync/><InstallationNotice/>
      <aside id="workbench-navigation" className={`sidebar ${mobileOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">实</div>
          <span><b>实习工作台</b><small>DECISION & ACTION</small></span>
          <button className="icon-btn mobile-close" aria-label="关闭菜单" onClick={() => setMobileOpen(false)}><X size={18}/></button>
        </div>
        {(activeDataSource !== 'http' || user?.demo) && <div className="demo-banner">{(() => {
          if (activeDataSource === 'guest') return '游客体验 · 临时虚构数据';
          if (activeDataSource === 'demo') return usingDemoOverride() ? '演示模式 · 本机虚构数据' : '演示模式 · 虚构数据';
          return '演示站 · 虚构数据';
        })()}</div>}
        <nav aria-label="主导航">
          {navigation.filter((item) => (!item.admin || isAdmin) && (!item.account || ticketsEnabled)).map(({ to, label, icon: Icon }) => (
            <NavLink key={to} end={to === '/'} to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <Icon size={18}/><span>{label}</span>
              {to === '/settings' && pending > 0 && <i className="count">{pending}</i>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="who">
            <span className="avatar">{user?.displayName.slice(0, 1) ?? '演'}</span>
            <span><b>{user?.displayName ?? '演示用户'}</b><small>{roleLabel(user?.role)}身份</small></span>
            <button className="icon-btn" title={activeDataSource === 'guest' ? '结束游客体验并清除数据' : '退出登录'} onClick={() => void logout()}><LogOut size={16}/></button>
          </div>
          <div className="api-indicator"><span className="dot"/>{activeDataSource === 'guest' ? '本标签页临时数据 · 退出或关闭即清除' : activeDataSource === 'demo' ? '内置演示数据源' : '后端会话已连接'}</div>
          <small className="muted">版本 {import.meta.env.VITE_BUILD_ID}</small>
        </div>
      </aside>
      {mobileOpen && <button className="sidebar-scrim" aria-label="关闭菜单" onClick={() => setMobileOpen(false)}/>}

      <main className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label="打开菜单" aria-expanded={mobileOpen} aria-controls="workbench-navigation" onClick={() => setMobileOpen(true)}><Menu size={20}/></button>
          <div className="breadcrumbs">工作台 <span>/</span> {navigation.find((item) => item.to === location.pathname || (item.to === '/tickets' && location.pathname.startsWith('/tickets/')))?.label ?? '页面'}</div>
          <div className="top-actions">
            <NotificationControls/>
            <ThemeSelect/>
            <span className="sync-pill"><Cloud size={15}/>{pending ? `${pending} 项待同步` : '已同步'}</span>
            <button className="icon-btn" title="刷新数据" onClick={reload}><RefreshCw size={17}/></button>
            <span className="avatar mini" title={user?.displayName}>{user?.displayName.slice(0, 1) ?? '演'}</span>
          </div>
        </header>

        <div className="content" aria-live="polite">
          <NotificationRuntime key={session?.user?.id ?? 'anonymous'} userId={session?.user?.id ?? null} enabled={Boolean(session?.authenticated && !session.user?.demo && !guestMode)} settingsUrl="/settings/notifications"/>
          {message?.kind === 'error' && <div role="alert">{message.text}<button className="btn small" onClick={() => setMessage(null)}>关闭</button></div>}
          {busy && <div className="busy-line"><LoaderCircle className="spin" size={15}/>正在处理…</div>}
          <Routes>
            <Route path="/" element={<Dashboard context={actionContext} pending={pending}/>}/>
            <Route path="/profile" element={<ProfilePage context={actionContext}/>}/>
            <Route path="/personal-profile" element={<SettingsEditGuard key={`${user?.id}:${user?.role}`}><PageHead kicker="我的账户" title="个人资料" description="先查看已保存的资料，需要修改时再进入编辑。"/><AccountSettings demo={Boolean(user?.demo) || getActiveDataSource() !== 'http'} onRefreshSession={refreshAccountSession} onSessionEnded={accountSessionEnded}/></SettingsEditGuard>}/>
            <Route path="/jobs" element={<JobsPage context={actionContext}/>}/>
            <Route path="/match" element={<MatchingPage context={actionContext}/>}/>
            <Route path="/plan" element={<PlanningPage context={actionContext}/>}/>
            <Route path="/applications" element={<TrackingPage context={actionContext}/>}/>
            <Route path="/admin" element={<Navigate to="/settings/management" replace/>}/>
            <Route path="/admin/ai-settings" element={<Navigate to="/settings/ai" replace/>}/>
            <Route path="/admin/settings" element={<Navigate to="/settings/management" replace/>}/>
            <Route path="/admin/jobs" element={isAdmin && user ? <AdminPage context={actionContext} user={user}/> : <Navigate to="/" replace/>}/>
            <Route path="/tickets" element={ticketsEnabled && user ? <TicketsPage key={ticketAccessScope(user.id, user.role)} context={actionContext} access={{ userId: user.id, role: user.role, onSessionChange: onTicketSessionChange }}/> : <Navigate to="/" replace/>}/>
            <Route path="/tickets/:id" element={ticketsEnabled && user ? <TicketDetailPage key={ticketAccessScope(user.id, user.role)} context={actionContext} access={{ userId: user.id, role: user.role, onSessionChange: onTicketSessionChange }}/> : <Navigate to="/" replace/>}/>
            <Route path="/settings/:tab?" element={<SettingsHub key={`${user?.id}:${user?.role}`} user={user} context={actionContext} pending={pending} demo={Boolean(user?.demo) || getActiveDataSource() !== 'http'} onRefreshSession={refreshAccountSession} onSessionEnded={accountSessionEnded}/>}/>
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
  demoSource,
  onLogin,
  onGuest,
  onRegister,
  onCredentialLogin,
  onDemo,
}: {
  session: Session | null;
  error: string;
  busy: boolean;
  /** 演示数据源（构建期 VITE_DATA_SOURCE=demo 或运行期临时切换）：仅提供演示身份选择。 */
  demoSource: boolean;
  onLogin: (id: string) => Promise<void>;
  onGuest: () => Promise<void>;
  onRegister: (input: { username: string; password: string; invitationCode: string; email?: string; displayName?: string }) => Promise<boolean>;
  onCredentialLogin: (input: { username: string; password: string }) => Promise<boolean>;
  onDemo: () => void;
}) {
  const users = session?.demoUsers ?? [];
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [invitationCode, setInvitationCode] = useState('');
  const [email, setEmail] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === 'register' && password !== confirm) return;
    if (mode === 'login') {
      await onCredentialLogin({ username: username.trim(), password });
    } else {
      await onRegister({ username: username.trim(), password, invitationCode: invitationCode.trim(), email: email.trim() || undefined, displayName: displayName.trim() || undefined });
    }
  }

  return (
    <main className="login">
      <header className="login-topbar"><ThemeSelect/></header>
      <section className="login-card">
        <div className="brand-mark">实</div>
        <span className="eyebrow">{demoSource ? '演示模式 · 本机虚构数据' : '实习决策与执行工作台'}</span>
        <h1>进入实习工作台</h1>
        <p>{demoSource
          ? '这里是演示模式：数据由本机演示适配器应答，不写入服务端。选择身份即可体验完整流程。'
          : '注册或登录你的账号开始使用；也可以选择演示身份快速体验。'}</p>
        {error && <div className="alert"><Activity size={17}/><span>{error}</span></div>}

        {!demoSource && <p className="muted">仅限受邀注册。用户名不区分大小写。忘记密码请联系邀请人，由管理员独立核验身份后人工处理；选填邮箱未经验证，不能用于找回密码。</p>}
        {!demoSource && <form className="form-grid" onSubmit={(event) => void submit(event)}>
          <label className="field">
            <span>用户名</span>
            <input
              autoComplete="username"
              value={username}
              placeholder="3-32 位字母、数字、下划线或连字符"
              pattern="[a-zA-Z0-9_\-]{3,32}"
              required
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          {mode === 'register' && (
            <label className="field">
              <span>昵称（可选）</span>
              <input value={displayName} maxLength={64} placeholder="默认与用户名相同" onChange={(event) => setDisplayName(event.target.value)}/>
            </label>
          )}
          {mode === 'register' && <>
            <label className="field"><span>一次性邀请码</span><input value={invitationCode} required autoComplete="off" spellCheck={false} minLength={16} maxLength={16} pattern="[A-Za-z0-9_\-]{16}" onChange={event => setInvitationCode(event.target.value)}/></label>
            <label className="field"><span>邮箱（选填，未验证）</span><input type="email" value={email} maxLength={254} autoComplete="email" onChange={event => setEmail(event.target.value)}/></label>
          </>}
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              value={password}
              maxLength={128}
              minLength={mode === 'register' ? 8 : undefined}
              placeholder={mode === 'register' ? '至少 8 位' : ''}
              required
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {mode === 'register' && (
            <label className="field">
              <span>确认密码</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                required
                onChange={(event) => setConfirm(event.target.value)}
              />
              {confirm && confirm !== password && <small className="inline-error">两次输入的密码不一致。</small>}
            </label>
          )}
          <button className="btn primary" disabled={busy}>
            {busy ? '正在处理…' : mode === 'login' ? '登录' : '注册并进入'}
          </button>
        </form>}
        {!demoSource && <small className="muted">
          {mode === 'login' ? (
            <>还没有账号？<a href="#register" onClick={(event) => { event.preventDefault(); setMode('register'); }}>注册新账号</a></>
          ) : (
            <>已有账号？<a href="#login" onClick={(event) => { event.preventDefault(); setMode('login'); }}>去登录</a></>
          )}
        </small>}

        {users.length > 0 && <>
          <small className="muted">或选择演示身份（不是账号密码认证）：</small>
          <div className="login-users">
            {users.map((user) => <button className="user-choice" key={user.id} disabled={busy} onClick={() => void onLogin(user.id)}>
              <span className="avatar">{user.displayName.slice(0, 1)}</span>
              <span><b>{user.displayName}</b><small>演示{roleLabel(user.role)}</small></span>
              <ChevronRight size={18}/>
            </button>)}
          </div>
        </>}
        {import.meta.env.VITE_GUEST_ENABLED !== 'false' && <button className="guest-choice" disabled={busy} onClick={() => void onGuest()}>
          游客访问（完整一般用户体验）<ChevronRight size={18}/>
        </button>}
        {!demoSource && import.meta.env.VITE_LOCAL_DEMO_ENABLED !== 'false' && <button className="guest-choice" disabled={busy} onClick={onDemo}>
          体验演示模式（临时入口，本机虚构数据）<ChevronRight size={18}/>
        </button>}
        <small className="muted">退出游客体验或关闭此标签页后，游客会话和数据会清除。</small>
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
        <div className="button-row"><NavLink className="btn secondary" to="/settings/notifications">打开同步中心 <ChevronRight size={15}/></NavLink></div>
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
