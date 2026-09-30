interface WorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  BACKEND: { fetch(request: Request): Promise<Response> };
}

/**
 * 生产环境入口：把同源 `/api/v1` 请求转给后端 Worker（Service Binding），
 * 其余请求交给静态资源绑定。这样演示会话 Cookie 始终保持同源。
 */
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/v1' || pathname.startsWith('/api/v1/')) {
      return env.BACKEND.fetch(request);
    }
    const original = await env.ASSETS.fetch(request);
    const response = new Response(original.body, original);
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (new URL(request.url).protocol === 'https:') response.headers.set('Strict-Transport-Security', 'max-age=31536000');
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    return response;
  },
};
