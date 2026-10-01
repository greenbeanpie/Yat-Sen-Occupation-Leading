import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import { SettingsDirtyContext, confirmDiscardSettings } from './settings-dirty';
import type { SettingsLeaveRequest } from '../dialogs/settings-leave';

export function SettingsEditGuard({ children }: { children: ReactNode }) {
  const edits = useRef(new Set<string>());
  const [dirty, setDirty] = useState(false);
  const reportDirty = useCallback((id: string, changed: boolean) => {
    if (changed) edits.current.add(id); else edits.current.delete(id);
    setDirty(edits.current.size > 0);
  }, []);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => edits.current.size > 0 &&
    `${currentLocation.pathname}${currentLocation.search}${currentLocation.hash}` !== `${nextLocation.pathname}${nextLocation.search}${nextLocation.hash}`);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    const controller = new AbortController();
    void confirmDiscardSettings(true, controller.signal, false).then(confirmed => {
      if (!controller.signal.aborted) { if (confirmed) blocker.proceed(); else blocker.reset(); }
    });
    return () => controller.abort();
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return;
    let confirmedUpdate = false;
    const update = () => { confirmedUpdate = true; };
    const warn = (event: BeforeUnloadEvent) => { if (!confirmedUpdate) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    window.addEventListener('app-update-reload', update);
    return () => { window.removeEventListener('beforeunload', warn); window.removeEventListener('app-update-reload', update); };
  }, [dirty]);
  useEffect(() => {
    const controller = new AbortController();
    let pendingEdits: Set<string> | null = null;
    const leave = (event: Event) => {
      if (!edits.current.size) return;
      const waitUntil = (event as CustomEvent<SettingsLeaveRequest>).detail?.waitUntil;
      if (!waitUntil) { event.preventDefault(); return; }
      waitUntil(confirmDiscardSettings(true, controller.signal).then(confirmed => {
        if (!confirmed || controller.signal.aborted) return false;
        pendingEdits = new Set(edits.current); edits.current.clear(); setDirty(false); return true;
      }));
    };
    const failed = () => { if (pendingEdits) { edits.current = pendingEdits; pendingEdits = null; setDirty(edits.current.size > 0); } };
    window.addEventListener('settings-before-leave', leave);
    window.addEventListener('settings-leave-failed', failed);
    return () => { controller.abort(); window.removeEventListener('settings-before-leave', leave); window.removeEventListener('settings-leave-failed', failed); };
  }, []);
  return <SettingsDirtyContext.Provider value={reportDirty}>{children}</SettingsDirtyContext.Provider>;
}
