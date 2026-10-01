import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdminPage } from './AdminPage';
import type { ActionContext } from '../components';
import type { UserRole } from '../roles';

const context: ActionContext = { userId: 'actor', refresh: 0, busy: false, run: async () => true };
const render = (role: UserRole, demo = false) => renderToStaticMarkup(<AdminPage
  context={context}
  user={{ id: 'actor', role, displayName: '管理账户', timezone: 'Asia/Shanghai', demo }}
/>);

describe('public job administration remains separate from global settings', () => {
  it.each<UserRole>(['admin', 'super_admin'])('keeps business operations for %s without duplicate global settings', role => {
    const html = render(role);
    expect(html).toContain('公共岗位');
    expect(html).not.toContain('<h2>用户管理</h2>');
    expect(html).not.toContain('<h2>邀请注册</h2>');
    expect(html).not.toContain('<h2>系统设置</h2>');
    expect(html).not.toContain('AI 模型配置');
  });
});
