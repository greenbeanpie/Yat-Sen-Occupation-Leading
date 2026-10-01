import type { components } from '../api/schema';
import { canAccessAdmin } from '../roles';

type User = NonNullable<components['schemas']['SessionResponse']['user']>;
export function settingsTabs(user: User | undefined, demo: boolean) {
  return [
    ...(!demo ? [{ id: 'security', label: '账户安全' }] : []),
    { id: 'appearance', label: '外观' },
    { id: 'installation', label: '安装应用' },
    { id: 'notifications', label: '推送与通知' },
    { id: 'sync', label: '离线同步' },
    ...(!demo && canAccessAdmin(user) ? [{ id: 'management', label: '管理' }] : []),
    ...(!demo && canAccessAdmin(user) && user?.role === 'super_admin' ? [{ id: 'ai', label: 'AI 配置' }] : []),
  ];
}
