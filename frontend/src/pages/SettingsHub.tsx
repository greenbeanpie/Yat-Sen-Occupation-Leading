import { Navigate, NavLink, useParams } from 'react-router-dom';
import type { components } from '../api/schema';
import { PageHead, Panel, type ActionContext } from '../components';
import { ThemeSelect } from '../ThemeSelect';
import { AccountSettings } from './AccountSettings';
import { SettingsPage } from './SettingsPage';
import { UsersPanel } from './UsersPanel';
import { InvitationsPanel } from './InvitationsPanel';
import { SystemSettingsPanel } from './SystemSettingsPanel';
import { AiSettingsPanel } from './AiSettingsPanel';
import { SettingsEditGuard } from './SettingsEditGuard';
import { settingsTabs } from './settings-tabs';

export function SettingsHub({ context, user, pending, demo, onRefreshSession, onSessionEnded }: {
  context: ActionContext; user: NonNullable<components['schemas']['SessionResponse']['user']> | undefined;
  pending: number; demo: boolean; onRefreshSession: () => Promise<void>; onSessionEnded: (message: string) => Promise<void>;
}) {
  const { tab } = useParams();
  const tabs = settingsTabs(user, demo);

  if (tab === 'profile') return <Navigate to="/personal-profile" replace/>;
  if (!tab || !tabs.some(item => item.id === tab)) return <Navigate to={`/settings/${tabs[0].id}`} replace/>;
  return <SettingsEditGuard>
    <PageHead kicker="账户与偏好" title="设置" description="管理账户安全、外观与通知及可用的全局设置。"/>
    <nav className="settings-tabs" aria-label="设置分类">
      {tabs.map(item => <NavLink key={item.id} to={`/settings/${item.id}`} className={({ isActive }) => `btn ${isActive ? 'primary' : 'secondary'}`}>{item.label}</NavLink>)}
    </nav>
    <section key={tab} aria-label={tabs.find(item => item.id === tab)?.label}>
      {tab === 'security' && <AccountSettings section="security" demo={demo} onRefreshSession={onRefreshSession} onSessionEnded={onSessionEnded}/>}
      {tab === 'notifications' && <><Panel title="外观" description="主题偏好与顶栏保持一致"><ThemeSelect variant="field"/></Panel><SettingsPage context={context} pending={pending}/></>}
      {tab === 'management' && user && <><UsersPanel context={context} role={user.role} onRefreshSession={onRefreshSession}/><InvitationsPanel context={context}/>{user.role === 'super_admin' && <SystemSettingsPanel context={context}/>}</>}
      {tab === 'ai' && <AiSettingsPanel context={context}/>}
    </section>
  </SettingsEditGuard>;
}
