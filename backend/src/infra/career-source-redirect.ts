const ORIGIN = 'https://career.sysu.edu.cn';
// Only fixed public routes/categories can leave this module. Arbitrary hostnames,
// path segments, queries, fragments and userinfo may contain credentials.
export const SOURCE_REDIRECT_KINDS = ['same_origin_public', 'same_origin_other', 'login', 'challenge', 'external', 'insecure', 'invalid', 'missing'] as const;
export const SOURCE_REDIRECT_TARGETS = [
    `${ORIGIN}/`, `${ORIGIN}/campus/index`, `${ORIGIN}/campus/index/`,
    `${ORIGIN}/campus/view/id/[id]`, `${ORIGIN}/campus/view/id/[id]/`,
    `${ORIGIN}/[other-path]`, `${ORIGIN}/[login]`, `${ORIGIN}/[challenge]`,
    '[external HTTPS target]', '[external login target]', '[external challenge target]',
    '[non-HTTPS target]', '[invalid target]', '[missing Location]',
  ] as const;
export type SourceRedirect = {
  kind: typeof SOURCE_REDIRECT_KINDS[number]; target: typeof SOURCE_REDIRECT_TARGETS[number];
  queryRemoved: boolean; fragmentRemoved: boolean;
};

export function safeSourceRedirect(value: unknown): SourceRedirect | undefined {
  try {
    if (!value || typeof value !== 'object') return;
    const item = value as SourceRedirect;
    if (!SOURCE_REDIRECT_KINDS.includes(item.kind) || !SOURCE_REDIRECT_TARGETS.includes(item.target)
      || typeof item.queryRemoved !== 'boolean' || typeof item.fragmentRemoved !== 'boolean') return;
    return {kind:item.kind,target:item.target,queryRemoved:item.queryRemoved,fragmentRemoved:item.fragmentRemoved};
  } catch { return; }
}

/** Classify a Location without following it or retaining untrusted URL text. */
export function classifySourceRedirect(location: string | null, requestUrl: string): SourceRedirect {
  const summary = (kind: SourceRedirect['kind'], target: SourceRedirect['target'], url?: URL): SourceRedirect => ({
    kind, target, queryRemoved: !!url?.search, fragmentRemoved: !!url?.hash,
  });
  if (location === null) return summary('missing', '[missing Location]');
  if (!location.trim() || location.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(location)) return summary('invalid', '[invalid target]');
  let url: URL;
  try { url = new URL(location, requestUrl); } catch { return summary('invalid', '[invalid target]'); }
  if (url.username || url.password) return summary('invalid', '[invalid target]', url);
  if (url.protocol !== 'https:') return summary('insecure', '[non-HTTPS target]', url);
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return summary('invalid', '[invalid target]', url); }
  const sameOrigin = url.origin === ORIGIN;
  if (/(?:^|\/)(?:login|signin|sign-in|cas|sso|passport|authenticate|authentication)(?:\/|\.|$)/i.test(path)) {
    return summary('login', sameOrigin ? `${ORIGIN}/[login]` : '[external login target]', url);
  }
  if (/(?:^|\/)(?:captcha|challenge|verify|verification)(?:\/|\.|$)|\/cdn-cgi\/challenge-platform(?:\/|$)/i.test(path)) {
    return summary('challenge', sameOrigin ? `${ORIGIN}/[challenge]` : '[external challenge target]', url);
  }
  if (!sameOrigin) return summary('external', '[external HTTPS target]', url);
  // Match the encoded pathname, not a normalized/decoded path, for public routes.
  if (url.pathname === '/' || url.pathname === '/campus/index' || url.pathname === '/campus/index/') {
    return summary('same_origin_public', `${ORIGIN}${url.pathname}` as SourceRedirect['target'], url);
  }
  if (/^\/campus\/view\/id\/[0-9]{1,12}\/?$/.test(url.pathname)) {
    return summary('same_origin_public', `${ORIGIN}/campus/view/id/[id]${url.pathname.endsWith('/') ? '/' : ''}`, url);
  }
  return summary('same_origin_other', `${ORIGIN}/[other-path]`, url);
}
