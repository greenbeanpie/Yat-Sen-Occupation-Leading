import { useEffect, useState } from 'react';
import { applyTheme, parseTheme, readTheme, saveTheme, THEME_KEY, type ThemePreference } from './theme';

function useThemePreference() {
  const [preference, setPreference] = useState<ThemePreference>(readTheme);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(preference, media.matches);
    const localChange = (event: Event) => setPreference(parseTheme((event as CustomEvent).detail));
    const storage = (event: StorageEvent) => {
      try {
        if (event.storageArea === localStorage && (event.key === THEME_KEY || event.key === null)) {
          setPreference(parseTheme(event.newValue));
        }
      } catch { /* Storage can be disabled while this page is open. */ }
    };
    update();
    media.addEventListener('change', update);
    window.addEventListener('storage', storage);
    window.addEventListener('theme-preference-changed', localChange);
    return () => {
      media.removeEventListener('change', update);
      window.removeEventListener('storage', storage);
      window.removeEventListener('theme-preference-changed', localChange);
    };
  }, [preference]);

  return [preference, setPreference] as const;
}

export function ThemeSync() {
  useThemePreference();
  return null;
}

export function ThemeSelect() {
  const [preference, setPreference] = useThemePreference();
  return <label className="theme-select">
    <span className="visually-hidden">外观主题</span>
    <select value={preference} onChange={event => {
      const next = parseTheme(event.target.value);
      setPreference(next);
      applyTheme(next, matchMedia('(prefers-color-scheme: dark)').matches);
      saveTheme(next);
      window.dispatchEvent(new CustomEvent('theme-preference-changed', { detail: next }));
    }}>
      <option value="system">跟随系统</option>
      <option value="light">浅色</option>
      <option value="dark">深色</option>
    </select>
  </label>;
}
