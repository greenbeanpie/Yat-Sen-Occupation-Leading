interface WorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  BACKEND: { fetch(request: Request): Promise<Response> };
}

/**
 * 生产环境入口：把同源 `/api/v1` 请求转给后端 Worker（Service Binding），
 * 其余请求交给静态资源绑定。这样演示会话 Cookie 始终保持同源。
 */
export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/v1' || pathname.startsWith('/api/v1/')) {
      return env.BACKEND.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
