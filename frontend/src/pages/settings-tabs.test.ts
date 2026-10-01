import { describe, expect, it, vi } from 'vitest';
import { settingsTabs } from './settings-tabs';
import { confirmDiscardSettings } from './settings-dirty';

describe('settings category access', () => {
  const user = { id: 'fixture', displayName: 'Fixture', timezone: 'UTC', demo: false, role: 'student' as const };
  it('excludes every administrative category for ordinary users', () => {
    expect(settingsTabs(user, false).map(tab => tab.id)).toEqual(['profile', 'security', 'notifications']);
  });
  it('separates administrator and super administrator capabilities', () => {
    expect(settingsTabs({ ...user, role: 'admin' }, false).map(tab => tab.id)).toContain('management');
    expect(settingsTabs({ ...user, role: 'admin' }, false).map(tab => tab.id)).not.toContain('ai');
    expect(settingsTabs({ ...user, role: 'super_admin' }, false).map(tab => tab.id)).toContain('ai');
  });
  it('never offers real-account security or administration to demo or guest sessions', () => {
    expect(settingsTabs({ ...user, role: 'super_admin', demo: true }, true).map(tab => tab.id)).toEqual(['profile', 'notifications']);
    expect(settingsTabs(undefined, true).map(tab => tab.id)).toEqual(['profile', 'notifications']);
  });
  it('requires affirmative confirmation before discarding edits', () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('window', { confirm });
    expect(confirmDiscardSettings(false)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(confirmDiscardSettings(true)).toBe(false);
    confirm.mockReturnValue(true);
    expect(confirmDiscardSettings(true)).toBe(true);
    vi.unstubAllGlobals();
  });
});
