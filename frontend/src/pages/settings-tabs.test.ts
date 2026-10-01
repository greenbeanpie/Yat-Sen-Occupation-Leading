import { describe, expect, it, vi } from 'vitest';
import { settingsTabs } from './settings-tabs';
import { confirmDiscardSettings } from './settings-dirty';
import { confirmPage } from '../dialogs/dialog-service';
vi.mock('../dialogs/dialog-service', () => ({ confirmPage: vi.fn(), promptPage: vi.fn() }));

describe('settings category access', () => {
  const user = { id: 'fixture', displayName: 'Fixture', timezone: 'UTC', demo: false, role: 'student' as const };
  it('excludes every administrative category for ordinary users', () => {
    expect(settingsTabs(user, false).map(tab => tab.id)).toEqual(['security', 'appearance', 'installation', 'notifications', 'sync']);
  });
  it('separates administrator and super administrator capabilities', () => {
    expect(settingsTabs({ ...user, role: 'admin' }, false).map(tab => tab.id)).toContain('management');
    expect(settingsTabs({ ...user, role: 'admin' }, false).map(tab => tab.id)).not.toContain('ai');
    expect(settingsTabs({ ...user, role: 'super_admin' }, false).map(tab => tab.id)).toContain('ai');
  });
  it('never offers real-account security or administration to demo or guest sessions', () => {
    expect(settingsTabs({ ...user, role: 'super_admin', demo: true }, true).map(tab => tab.id)).toEqual(['appearance', 'installation', 'notifications', 'sync']);
    expect(settingsTabs(undefined, true).map(tab => tab.id)).toEqual(['appearance', 'installation', 'notifications', 'sync']);
  });
  it('requires affirmative in-page confirmation before discarding edits', async () => {
    vi.mocked(confirmPage).mockResolvedValue(false);
    expect(await confirmDiscardSettings(false)).toBe(true);
    expect(confirmPage).not.toHaveBeenCalled();
    expect(await confirmDiscardSettings(true)).toBe(false);
    vi.mocked(confirmPage).mockResolvedValue(true);
    expect(await confirmDiscardSettings(true)).toBe(true);
  });
});
