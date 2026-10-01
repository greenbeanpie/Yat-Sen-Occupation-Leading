import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifySourceRedirect } from '../src/infra/career-source-redirect';
import { SourceRedirectSchema } from '../src/infra/ai/diagnostics';
import { CareerSourceError, fetchCareerHtml } from '../src/infra/career-source';
import { classifyCareerSourceError } from '../src/infra/career-source-errors';

const requestUrl = 'https://career.sysu.edu.cn/campus/index';
afterEach(() => vi.unstubAllGlobals());
describe('safe Location fixtures without network', () => {
  it.each([
    ['/campus/index/?token=fixture-secret#fixture-secret', 'same_origin_public', 'https://career.sysu.edu.cn/campus/index/'],
    ['https://career.sysu.edu.cn/campus/view/id/997448?ticket=fixture-secret', 'same_origin_public', 'https://career.sysu.edu.cn/campus/view/id/[id]'],
    ['/', 'same_origin_public', 'https://career.sysu.edu.cn/'],
    ['/unknown/fixture-secret', 'same_origin_other', 'https://career.sysu.edu.cn/[other-path]'],
    ['/user/login?return=fixture-secret', 'login', 'https://career.sysu.edu.cn/[login]'],
    ['/user/%6cogin', 'login', 'https://career.sysu.edu.cn/[login]'],
    ['https://cas.sysu.edu.cn/cas/login?ticket=fixture-secret', 'login', '[external login target]'],
    ['/cdn-cgi/challenge-platform?token=fixture-secret', 'challenge', 'https://career.sysu.edu.cn/[challenge]'],
    ['https://fixture-secret.other.test/secret', 'external', '[external HTTPS target]'],
    ['//other.test/verify', 'challenge', '[external challenge target]'],
    ['https://career.sysu.edu.cn:444/campus/index', 'external', '[external HTTPS target]'],
    ['http://career.sysu.edu.cn/campus/index', 'insecure', '[non-HTTPS target]'],
    ['javascript:fixture-secret', 'insecure', '[non-HTTPS target]'],
    ['https://fixture-secret:fixture-secret@career.sysu.edu.cn/campus/index', 'invalid', '[invalid target]'],
    ['https://career.sysu.edu.cn/campus/index\n', 'invalid', '[invalid target]'],
    ['https://[broken', 'invalid', '[invalid target]'],
    ['/invalid%zz', 'invalid', '[invalid target]'],
    ['', 'invalid', '[invalid target]'],
    [null, 'missing', '[missing Location]'],
  ] as const)('classifies %s and retains no arbitrary URL text', (location, kind, target) => {
    const result = classifySourceRedirect(location, requestUrl);
    expect(result).toMatchObject({kind, target});
    expect(SourceRedirectSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
  it('records removal flags without query or fragment content', () => {
    expect(classifySourceRedirect('/campus/index?token=fixture-secret#fixture-secret', requestUrl)).toMatchObject({queryRemoved:true,fragmentRemoved:true});
    expect(SourceRedirectSchema.safeParse({kind:'external',target:'https://fixture-secret.test',queryRemoved:false,fragmentRemoved:false}).success).toBe(false);
  });
  it.each([301,302,303,307,308])('preserves HTTP %s and safe Location through fetch/classification while cancelling body', async status => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({cancel}), {status, headers:{Location:'/campus/index/?token=fixture-secret#fixture-secret'}});
    const fetcher = vi.fn().mockResolvedValue(response); vi.stubGlobal('fetch', fetcher);
    const error = await fetchCareerHtml('/campus/index').catch(error => error);
    expect(error).toBeInstanceOf(CareerSourceError);
    const failure = classifyCareerSourceError(error);
    expect(failure).toMatchObject({code:'source_redirect',httpStatus:status,sourceRedirect:{kind:'same_origin_public',target:'https://career.sysu.edu.cn/campus/index/'}});
    expect(failure.message).toContain('同源公开路径');
    expect(JSON.stringify(failure)).not.toContain('fixture-secret');
    expect(cancel).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({redirect:'manual'});
  });
  it.each([403,429])('prioritizes HTTP %s over an accompanying Location', async status => {
    const fetcher=vi.fn().mockResolvedValue(new Response('blocked',{status,headers:{Location:'/user/login?secret=fixture-secret'}}));
    vi.stubGlobal('fetch',fetcher);
    const failure=classifyCareerSourceError(await fetchCareerHtml('/campus/index').catch(error=>error));
    expect(failure).toMatchObject({code:status===403?'source_forbidden':'source_rate_limited',httpStatus:status});
    expect(failure.sourceRedirect).toBeUndefined();expect(fetcher).toHaveBeenCalledOnce();
  });
  it('classifies missing Location separately from a known redirect target',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(null,{status:302})));
    expect(classifyCareerSourceError(await fetchCareerHtml('/campus/index').catch(error=>error))).toMatchObject({code:'source_redirect',httpStatus:302,sourceRedirect:{kind:'missing'}});
  });
});
