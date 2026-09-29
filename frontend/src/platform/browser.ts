import type {
  NotificationPermissionState,
  PlatformStorage,
  WorkbenchPlatform,
} from './types';

interface BrowserDependencies {
  window?: Window & typeof globalThis;
  document?: Document;
  storage?: PlatformStorage;
}

function permissionFrom(value: string | undefined | null): NotificationPermissionState {
  return value === 'granted' || value === 'denied' ? value : 'default';
}

/** 浏览器实现；依赖通过参数注入，便于在没有 DOM 的测试里替换。 */
export function createBrowserPlatform(dependencies: BrowserDependencies = {}): WorkbenchPlatform {
  const view = dependencies.window ?? globalThis.window;
  const doc = dependencies.document ?? globalThis.document;
  const storage = dependencies.storage;

  if (!storage) throw new Error('浏览器平台实现需要传入本地存储适配器。');

  return {
    kind: 'browser',
    files: {
      pickFile({ accept }) {
        return new Promise<File | null>((resolve) => {
          const input = doc.createElement('input');
          input.type = 'file';
          input.accept = accept;
          input.className = 'platform-file-input';
          input.style.position = 'fixed';
          input.style.left = '-10000px';
          input.style.width = '1px';
          input.style.height = '1px';

          let settled = false;
          const finish = (file: File | null) => {
            if (settled) return;
            settled = true;
            input.remove();
            resolve(file);
          };

          input.addEventListener('change', () => finish(input.files?.[0] ?? null));
          // Chrome/Safari 在用户取消时会派发 cancel；旧内核只会在别处继续，不影响功能。
          input.addEventListener('cancel', () => finish(null));
          doc.body.append(input);
          input.click();
        });
      },
    },
    notifications: {
      permission() {
        if (!('Notification' in view)) return 'unsupported';
        return permissionFrom(view.Notification.permission);
      },
      async requestPermission() {
        if (!('Notification' in view)) return 'unsupported';
        if (view.Notification.permission === 'granted' || view.Notification.permission === 'denied') {
          return view.Notification.permission;
        }
        return permissionFrom(await view.Notification.requestPermission());
      },
    },
    network: {
      isOnline: () => view.navigator.onLine,
      subscribe(listener) {
        const report = () => listener(view.navigator.onLine);
        view.addEventListener('online', report);
        view.addEventListener('offline', report);
        return () => {
          view.removeEventListener('online', report);
          view.removeEventListener('offline', report);
        };
      },
    },
    storage,
  };
}
