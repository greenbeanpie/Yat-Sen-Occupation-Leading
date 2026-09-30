import type { components } from './api/schema';

/** `student` remains the stored/API value for the general-user role. */
export type UserRole = components['schemas']['ManagedUser']['role'];

export const roleOptions: { value: UserRole; label: string }[] = [
  { value: 'student', label: '一般用户' },
  { value: 'admin', label: '管理员' },
  { value: 'super_admin', label: '超级管理员' },
];

export function roleLabel(role: UserRole | undefined): string {
  return roleOptions.find(option => option.value === role)?.label ?? '一般用户';
}

export function isAdministrativeRole(role: UserRole | undefined): boolean {
  return role === 'admin' || role === 'super_admin';
}

export function canAccessAdmin(user: { role: UserRole; demo?: boolean } | undefined): boolean {
  return Boolean(user && !user.demo && isAdministrativeRole(user.role));
}

export function canAccessTickets(user: { demo?: boolean } | undefined): boolean {
  return Boolean(user && !user.demo);
}

export function canManageUser(actorRole: UserRole, targetRole: UserRole): boolean {
  return actorRole === 'super_admin' || (actorRole === 'admin' && targetRole === 'student');
}
