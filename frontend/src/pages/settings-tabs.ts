import type { components } from '../api/schema';
import { canAccessAdmin } from '../roles';

type User = NonNullable<components['schemas']['SessionResponse']['user']>;
export function settingsTabs(user: User | undefined, demo: boolean) {
  return [
    { id: 'profile', label: '个人资料' },
    ...(!demo ? [{ id: 'security', label: '账户安全' }] : []),
    { id: 'notifications', label: '外观与通知' },
    ...(!demo && canAccessAdmin(user) ? [{ id: 'management', label: '管理' }] : []),
    ...(!demo && canAccessAdmin(user) && user?.role === 'super_admin' ? [{ id: 'ai', label: 'AI 配置' }] : []),
  ];
}
