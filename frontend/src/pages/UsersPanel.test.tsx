import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UserManagementRow, type ManagedUser } from './UsersPanel';
import type { UserRole } from '../roles';

const user: ManagedUser = { id: 'user-1', username: 'alice', displayName: 'Alice', role: 'student', disabled: false };
const render = (actorRole: UserRole, target = user, currentUserId = 'actor') => renderToStaticMarkup(
  <UserManagementRow user={target} actorRole={actorRole} currentUserId={currentUserId} busy={false} onAction={() => undefined}/>,
);

describe('user administration controls', () => {
  it('lets administrators manage general users without a role-changing control', () => {
    const html = render('admin');
    expect(html).toContain('一般用户');
    expect(html).toContain('编辑昵称');
    expect(html).toContain('停用账户');
    expect(html).not.toContain('调整角色');
  });

  it.each<UserRole>(['admin', 'super_admin'])('hides privileged target controls from ordinary administrators for %s', role => {
    const html = render('admin', { ...user, role });
    expect(html).not.toContain('编辑昵称');
    expect(html).not.toContain('停用账户');
    expect(html).not.toContain('调整角色');
  });

  it.each<UserRole>(['student', 'admin', 'super_admin'])('lets super administrators manage the %s role', role => {
    const html = render('super_admin', { ...user, role });
    expect(html).toContain('编辑昵称');
    expect(html).toContain('调整角色');
  });

  it('never offers self-disable and identifies the current account', () => {
    const html = render('super_admin', { ...user, role: 'super_admin' }, user.id);
    expect(html).toContain('当前账户');
    expect(html).not.toContain('停用账户');
  });

  it('shows reactivation for a disabled account', () => {
    const html = render('admin', { ...user, disabled: true });
    expect(html).toContain('已停用');
    expect(html).toContain('启用账户');
  });
});
