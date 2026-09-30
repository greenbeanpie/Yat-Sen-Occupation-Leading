export type ThemePreference = 'system' | 'light' | 'dark';
export const THEME_KEY = 'yso-theme';
let memoryPreference: ThemePreference = 'system';

export function parseTheme(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function readTheme(): ThemePreference {
  try { memoryPreference = parseTheme(localStorage.getItem(THEME_KEY)); }
  catch { /* Preserve this tab's choice across login/page transitions. */ }
  return memoryPreference;
}

export function saveTheme(preference: ThemePreference): void {
  memoryPreference = preference;
  try {
    if (preference === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, preference);
  } catch { /* The in-memory preference still works when persistence is blocked. */ }
}

export function applyTheme(preference: ThemePreference, systemDark: boolean): void {
  const dark = preference === 'dark' || (preference === 'system' && systemDark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111827' : '#f3f5f9');
}
