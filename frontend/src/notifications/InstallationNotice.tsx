import { useEffect, useState, useSyncExternalStore } from 'react';
import { getInstallState, subscribe } from '../pwa-install';

const SHOWN_KEY = 'intern-workbench:install-banner-shown';
let shownInMemory = false;
function wasShown(): boolean {
  try { return shownInMemory || sessionStorage.getItem(SHOWN_KEY) === '1'; }
  catch { return shownInMemory; }
}

const DISMISSED_KEY = 'intern-workbench:install-banner-dismissed';
// Storage can be unavailable; preserve dismissal across route remounts anyway.
const dismissedInMemory = false;
function wasDismissed(): boolean {
  try { return dismissedInMemory || sessionStorage.getItem(DISMISSED_KEY) === '1'; }
  catch { return dismissedInMemory; }
}

export function InstallationNotice() {
  const { canInstall } = useSyncExternalStore(subscribe, getInstallState);
  const [dismissed] = useState(wasDismissed);
  const [firstVisit] = useState(() => !wasShown());
  useEffect(() => {
    if (!canInstall || dismissed || !firstVisit) return;
    shownInMemory = true;
    try { sessionStorage.setItem(SHOWN_KEY, '1'); } catch { /* Keep the in-memory session fallback. */ }
    window.dispatchEvent(new CustomEvent('app-notification', { detail: { id: 'install', text: '安装到桌面可获得独立窗口和离线入口。', action: 'install' } }));
  }, [canInstall, dismissed, firstVisit]);
  return null;
}
