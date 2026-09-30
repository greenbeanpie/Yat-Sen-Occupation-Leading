import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdminPage } from './AdminPage';
import type { ActionContext } from '../components';
import type { UserRole } from '../roles';

const context: ActionContext = { userId: 'actor', refresh: 0, busy: false, run: async () => true };
const render = (role: UserRole, demo = false) => renderToStaticMarkup(<AdminPage
  context={context}
  user={{ id: 'actor', role, displayName: '管理账户', timezone: 'Asia/Shanghai', demo }}
  onRefreshSession={async () => undefined}
/>);

describe('administration sections', () => {
  it('gives administrators jobs, users, and invitations without system settings', () => {
    const html = render('admin');
    expect(html).toContain('管理中心');
    expect(html).toContain('公共岗位');
    expect(html).toContain('用户管理');
    expect(html).toContain('邀请注册');
    expect(html).not.toContain('系统设置');
  });

  it('shows system settings and role management to super administrators', () => {
    const html = render('super_admin');
    expect(html).toContain('超级管理员');
    expect(html).toContain('系统设置');
    expect(html).toContain('管理所有账户');
    expect(html).toContain('邀请注册');
  });

  it.each<UserRole>(['admin', 'super_admin'])('never exposes real-account sections to demo %s identities', role => {
    const html = render(role, true);
    expect(html).not.toContain('<h2>用户管理</h2>');
    expect(html).not.toContain('<h2>邀请注册</h2>');
    expect(html).not.toContain('<h2>系统设置</h2>');
  });
});
