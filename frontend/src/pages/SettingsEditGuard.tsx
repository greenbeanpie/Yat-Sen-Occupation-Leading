import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import { SettingsDirtyContext, confirmDiscardSettings } from './settings-dirty';

export function SettingsEditGuard({ children }: { children: ReactNode }) {
  const [dirtyForms, setDirtyForms] = useState<Set<string>>(() => new Set());
  const setDirty = useCallback((id: string, dirty: boolean) => setDirtyForms(current => {
    if (current.has(id) === dirty) return current;
    const next = new Set(current);
    if (dirty) next.add(id); else next.delete(id);
    return next;
  }), []);
  const dirty = dirtyForms.size > 0;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty &&
    `${currentLocation.pathname}${currentLocation.search}${currentLocation.hash}` !== `${nextLocation.pathname}${nextLocation.search}${nextLocation.hash}`);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (confirmDiscardSettings(true)) blocker.proceed(); else blocker.reset();
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return;
    let confirmedUpdate = false;
    const update = () => { confirmedUpdate = true; };
    const warn = (event: BeforeUnloadEvent) => { if (!confirmedUpdate) { event.preventDefault(); event.returnValue = ''; } };
    const leave = (event: Event) => { if (!confirmDiscardSettings(true)) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    window.addEventListener('settings-before-leave', leave);
    window.addEventListener('app-update-reload', update);
    return () => {
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('settings-before-leave', leave);
      window.removeEventListener('app-update-reload', update);
    };
  }, [dirty]);

  return <SettingsDirtyContext.Provider value={setDirty}>{children}</SettingsDirtyContext.Provider>;
}
