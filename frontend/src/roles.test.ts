import { describe, expect, it } from 'vitest';
import { canAccessAdmin, canAccessTickets, canManageUser, isAdministrativeRole, roleLabel, type UserRole } from './roles';

describe('three-role permissions', () => {
  it.each<[UserRole, string]>([
    ['student', '一般用户'], ['admin', '管理员'], ['super_admin', '超级管理员'],
  ])('labels %s without changing its stored role value', (role, label) => {
    expect(roleLabel(role)).toBe(label);
  });

  it.each<[UserRole, boolean]>([
    ['student', false], ['admin', true], ['super_admin', true],
  ])('allows the correct business-admin access for %s', (role, expected) => {
    expect(isAdministrativeRole(role)).toBe(expected);
    expect(canAccessAdmin({ role, demo: false })).toBe(expected);
    expect(canAccessAdmin({ role, demo: true })).toBe(false);
  });

  it('keeps unauthenticated users out of administration', () => {
    expect(canAccessAdmin(undefined)).toBe(false);
  });
  it('offers support tickets to real accounts and blocks guests and demo identities', () => {
    expect(canAccessTickets({ demo: false })).toBe(true);
    expect(canAccessTickets({ demo: true })).toBe(false);
    expect(canAccessTickets(undefined)).toBe(false);
  });

  it.each<UserRole>(['student', 'admin', 'super_admin'])('limits account management for %s', target => {
    expect(canManageUser('student', target)).toBe(false);
    expect(canManageUser('admin', target)).toBe(target === 'student');
    expect(canManageUser('super_admin', target)).toBe(true);
  });
});
