import { createContext, useContext, useEffect, useId } from 'react';

export const SettingsDirtyContext = createContext<(id: string, dirty: boolean) => void>(() => undefined);

/** Only booleans are shared: passwords and configuration values stay in their forms. */
export function useSettingsDirty(dirty: boolean) {
  const setDirty = useContext(SettingsDirtyContext);
  const id = useId();
  useEffect(() => {
    setDirty(id, dirty);
    return () => setDirty(id, false);
  }, [dirty, id, setDirty]);
}

export function confirmDiscardSettings(dirty: boolean): boolean {
  return !dirty || window.confirm('有尚未保存的修改。确定放弃这些修改吗？');
}
