import { useCallback, useEffect, useState } from 'react';
import { Navigate, NavLink, useBlocker, useParams } from 'react-router-dom';
import type { components } from '../api/schema';
import { PageHead, Panel, type ActionContext } from '../components';
import { ThemeSelect } from '../ThemeSelect';
import { AccountSettings } from './AccountSettings';
import { SettingsPage } from './SettingsPage';
import { UsersPanel } from './UsersPanel';
import { InvitationsPanel } from './InvitationsPanel';
import { SystemSettingsPanel } from './SystemSettingsPanel';
import { AiSettingsPanel } from './AiSettingsPanel';
import { SettingsDirtyContext, confirmDiscardSettings } from './settings-dirty';
import { settingsTabs } from './settings-tabs';

export function SettingsHub({ context, user, pending, demo, onRefreshSession, onSessionEnded }: {
  context: ActionContext; user: NonNullable<components['schemas']['SessionResponse']['user']> | undefined;
  pending: number; demo: boolean; onRefreshSession: () => Promise<void>; onSessionEnded: (message: string) => Promise<void>;
}) {
  const { tab } = useParams();
  const tabs = settingsTabs(user, demo);
  const [dirtyForms, setDirtyForms] = useState<Set<string>>(() => new Set());
  const setDirty = useCallback((id: string, dirty: boolean) => setDirtyForms(current => {
    if (current.has(id) === dirty) return current;
    const next = new Set(current);
    if (dirty) next.add(id); else next.delete(id);
    return next;
  }), []);
  const dirty = dirtyForms.size > 0;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty &&
    `${currentLocation.pathname}${currentLocation.search}${currentLocation.hash}` !== `${nextLocation.pathname}${nextLocation.search}${nextLocation.hash}`);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (confirmDiscardSettings(true)) blocker.proceed(); else blocker.reset();
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return;
    let confirmedUpdate = false;
    const update = () => { confirmedUpdate = true; };
    const warn = (event: BeforeUnloadEvent) => { if (!confirmedUpdate) { event.preventDefault(); event.returnValue = ''; } };
    const leave = (event: Event) => { if (!confirmDiscardSettings(true)) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    window.addEventListener('settings-before-leave', leave);
    window.addEventListener('app-update-reload', update);
    return () => {
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('settings-before-leave', leave);
      window.removeEventListener('app-update-reload', update);
    };
  }, [dirty]);

  if (!tab || !tabs.some(item => item.id === tab)) return <Navigate to="/settings/profile" replace/>;
  return <SettingsDirtyContext.Provider value={setDirty}>
    <PageHead kicker="账户与偏好" title="设置" description="管理个人资料、账户安全及可用的全局设置。"/>
    <nav className="settings-tabs" aria-label="设置分类">
      {tabs.map(item => <NavLink key={item.id} to={`/settings/${item.id}`} className={({ isActive }) => `btn ${isActive ? 'primary' : 'secondary'}`}>{item.label}</NavLink>)}
    </nav>
    <section key={tab} aria-label={tabs.find(item => item.id === tab)?.label}>
      {(tab === 'profile' || tab === 'security') && <AccountSettings section={tab} demo={demo} onRefreshSession={onRefreshSession} onSessionEnded={onSessionEnded}/>}
      {tab === 'notifications' && <><Panel title="外观"><ThemeSelect/></Panel><SettingsPage context={context} pending={pending}/></>}
      {tab === 'management' && user && <><UsersPanel context={context} role={user.role} onRefreshSession={onRefreshSession}/><InvitationsPanel context={context}/>{user.role === 'super_admin' && <SystemSettingsPanel context={context}/>}</>}
      {tab === 'ai' && <AiSettingsPanel context={context}/>}
    </section>
  </SettingsDirtyContext.Provider>;
}
