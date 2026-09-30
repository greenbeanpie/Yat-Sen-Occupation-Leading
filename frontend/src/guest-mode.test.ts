import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDemoDatabase } from './data/demo-seed';
import { createSessionStorage } from './data/demo-store';
import {
  GUEST_DATA_STORAGE_PREFIX,
  currentGuestUserId,
  isGuestMode,
  isGuestUserId,
  startGuestMode,
  stopGuestMode,
} from './guest-mode';

function fakeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

afterEach(() => {
  stopGuestMode();
  vi.unstubAllGlobals();
});

describe('游客临时会话', () => {
  it('只在当前标签页建立身份，退出时同步清除会话与游客数据', () => {
    const storage = fakeStorage();
    vi.stubGlobal('sessionStorage', storage);

    const userId = startGuestMode();
    expect(isGuestUserId(userId)).toBe(true);
    expect(currentGuestUserId()).toBe(userId);
    expect(isGuestMode()).toBe(true);
    storage.setItem(`${GUEST_DATA_STORAGE_PREFIX}${userId}`, '{"private":"tab-only"}');

    expect(stopGuestMode()).toBe(userId);
    expect(isGuestMode()).toBe(false);
    expect(currentGuestUserId()).toBeNull();
    expect(storage.length).toBe(0);
  });

  it('游客种子只含一个学生身份，并把所有私有样例数据关联到该身份', () => {
    const userId = 'ffffffff-0000-4000-8000-000000000001';
    const database = buildDemoDatabase(new Date('2026-09-30T00:00:00.000Z'), userId);

    expect(isGuestUserId('f1234567-0000-4000-8000-000000000001')).toBe(false);
    expect(database.sessionUserId).toBe(userId);
    expect(database.users).toEqual([expect.objectContaining({ id: userId, role: 'student', displayName: '游客（临时体验）' })]);
    expect(database.profiles).toHaveLength(1);
    expect(database.profiles[0]?.userId).toBe(userId);
    expect(database.experiences.every((row) => row.userId === userId)).toBe(true);
    expect(database.skills.every((row) => row.userId === userId)).toBe(true);
  });

  it('sessionStorage 不可用时仍使用页面内存维持同一份临时演示数据', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('storage blocked'); },
      setItem: () => { throw new Error('storage blocked'); },
      removeItem: () => { throw new Error('storage blocked'); },
    });
    const storage = createSessionStorage('guest-data');

    storage.write('ephemeral');
    expect(storage.read()).toBe('ephemeral');
    storage.clear();
    expect(storage.read()).toBeNull();
  });
});
