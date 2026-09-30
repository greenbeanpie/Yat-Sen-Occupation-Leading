import { useEffect, useState } from 'react';
import { get } from '../api/client';

/** Account administration must never fall back to an offline copy. */
export function useAdminResource<T>(path: string, userId: string, refresh: string) {
  const [resource, setResource] = useState<{ data: T | null; error: string; loading: boolean }>({ data: null, error: '', loading: true });
  useEffect(() => {
    let active = true;
    setResource({ data: null, error: '', loading: true });
    get<T>(path, { cache: 'no-store' })
      .then(data => { if (active) setResource({ data, error: '', loading: false }); })
      .catch((error: unknown) => {
        if (active) setResource({ data: null, error: error instanceof Error ? error.message : '管理数据加载失败，请重试。', loading: false });
      });
    return () => { active = false; };
  }, [path, userId, refresh]);
  return resource;
}
