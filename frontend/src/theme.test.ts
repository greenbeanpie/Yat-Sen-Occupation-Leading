import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTheme, readTheme, saveTheme, THEME_KEY } from './theme';

afterEach(() => {
  saveTheme('system');
  vi.unstubAllGlobals();
});

describe('theme preferences', () => {
  it('rejects invalid stored values', () => {
    expect(parseTheme('unexpected')).toBe('system');
    expect(parseTheme(null)).toBe('system');
  });

  it('removes the persisted override when returning to the system', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    saveTheme('dark');
    expect(values.get(THEME_KEY)).toBe('dark');
    expect(readTheme()).toBe('dark');
    saveTheme('system');
    expect(values.has(THEME_KEY)).toBe(false);
    expect(readTheme()).toBe('system');
  });

  it('retains the tab choice across component remounts with blocked storage', () => {
    const blocked = () => { throw new Error('Storage disabled'); };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    saveTheme('light');
    expect(readTheme()).toBe('light');
    saveTheme('dark');
    expect(readTheme()).toBe('dark');
    saveTheme('system');
    expect(readTheme()).toBe('system');
  });
});
