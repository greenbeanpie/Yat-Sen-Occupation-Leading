import { describe, expect, it, vi } from 'vitest';
import { createBrowserPlatform } from './browser';
import type { PlatformStorage } from './types';

const storage: PlatformStorage = {
  read: async () => undefined,
  write: async () => undefined,
  remove: async () => undefined,
};

interface FakeInput {
  style: Record<string, string>;
  accept: string;
  files: File[] | null;
  clickCount: number;
  removed: boolean;
  emit(type: string): void;
}

function fakeDocument(): { document: Document; input: FakeInput } {
  const listeners = new Map<string, () => void>();
  const input: FakeInput = {
    style: {},
    accept: '',
    files: null,
    clickCount: 0,
    removed: false,
    emit(type) {
      listeners.get(type)?.();
    },
  };
  const element = {
    ...input,
    type: '',
    className: '',
    click() {
      input.clickCount += 1;
    },
    remove() {
      input.removed = true;
    },
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, listener);
    },
    get style() {
      return input.style;
    },
    get files() {
      return input.files;
    },
    set accept(value: string) {
      input.accept = value;
    },
    get accept() {
      return input.accept;
    },
  };
  return {
    document: { createElement: () => element, body: { append: () => undefined } } as unknown as Document,
    input,
  };
}

describe('浏览器平台适配器', () => {
  it('缺少 Notification 能力时报告 unsupported，界面可继续使用站内提醒', () => {
    const platform = createBrowserPlatform({ window: {} as Window & typeof globalThis, storage });
    expect(platform.notifications.permission()).toBe('unsupported');
  });

  it('已有 denied 结论时不再重复请求权限', async () => {
    const requestPermission = vi.fn();
    const platform = createBrowserPlatform({
      window: { Notification: { permission: 'denied', requestPermission } } as unknown as Window & typeof globalThis,
      storage,
    });
    await expect(platform.notifications.requestPermission()).resolves.toBe('denied');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('网络状态订阅在 online/offline 事件上回调并支持取消', () => {
    const listeners = new Map<string, () => void>();
    const navigator = { onLine: true };
    const platform = createBrowserPlatform({
      window: {
        navigator,
        addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
        removeEventListener: (type: string) => listeners.delete(type),
      } as unknown as Window & typeof globalThis,
      storage,
    });
    const seen: boolean[] = [];
    const unsubscribe = platform.network.subscribe((online) => seen.push(online));
    navigator.onLine = false;
    listeners.get('offline')?.();
    unsubscribe();
    expect(platform.network.isOnline()).toBe(false);
    expect(seen).toEqual([false]);
    expect(listeners.size).toBe(0);
  });

  it('文件选择返回用户选中的文件，并在结束后移除输入元素', async () => {
    const { document, input } = fakeDocument();
    const platform = createBrowserPlatform({ window: {} as Window & typeof globalThis, document, storage });
    const picked = platform.files.pickFile({ accept: '.pdf' });
    const file = new File(['示例'], '示例简历.pdf', { type: 'application/pdf' });
    input.files = [file];
    input.emit('change');
    await expect(picked).resolves.toBe(file);
    expect(input.clickCount).toBe(1);
    expect(input.accept).toBe('.pdf');
    expect(input.removed).toBe(true);
  });

  it('用户取消选择时解析为 null', async () => {
    const { document, input } = fakeDocument();
    const platform = createBrowserPlatform({ window: {} as Window & typeof globalThis, document, storage });
    const picked = platform.files.pickFile({ accept: '.pdf' });
    input.emit('cancel');
    await expect(picked).resolves.toBeNull();
    expect(input.removed).toBe(true);
  });
});
