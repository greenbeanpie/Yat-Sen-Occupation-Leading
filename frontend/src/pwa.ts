import { registerSW } from 'virtual:pwa-register';

export interface ServiceWorkerHooks {
  onNeedRefresh: () => void;
  onOfflineReady: () => void;
  onError: (error: unknown) => void;
}

/**
 * 注册 Service Worker 并暴露更新提示所需的钩子；开发服务器不带 SW，
 * 直接返回空实现，避免本地联调出现无意义的“新版本”提示。
 */
export function registerServiceWorker(hooks: ServiceWorkerHooks): (reloadPage?: boolean) => Promise<void> {
  if (!import.meta.env.PROD) return async () => undefined;
  const update = registerSW({
    immediate: true,
    onNeedRefresh: hooks.onNeedRefresh,
    onOfflineReady: hooks.onOfflineReady,
    onRegisterError: hooks.onError,
  });
  return async (reloadPage = true) => {
    await update(reloadPage);
  };
}
