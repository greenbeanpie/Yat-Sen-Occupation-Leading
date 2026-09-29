import { cacheValue, db, readCached } from '../offline';
import { createBrowserPlatform } from './browser';
import type { PlatformStorage, WorkbenchPlatform } from './types';

/**
 * 键值存储复用离线缓存表：界面层只依赖 PlatformStorage，
 * 离线队列本身仍由同步引擎（offline.ts）负责。
 */
const dexieStorage: PlatformStorage = {
  read: <T,>(key: string) => readCached<T>(key),
  write: (key, value) => cacheValue(key, value),
  remove: async (key) => {
    await db.cache.delete(key);
  },
};

export const platform: WorkbenchPlatform = createBrowserPlatform({ storage: dexieStorage });

export { createBrowserPlatform } from './browser';
export type {
  NotificationPermissionState,
  PlatformStorage,
  WorkbenchPlatform,
} from './types';
