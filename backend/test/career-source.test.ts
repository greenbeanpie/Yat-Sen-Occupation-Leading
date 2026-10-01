import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { CAREER_SOURCE_USER_AGENT, fetchCareerHtml } from "../src/infra/career-source";
import expected from "./fixtures/career-source/expected.json";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/career-source/${name}`, import.meta.url), "utf8");
let runtime: Miniflare;
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import {parseCareerList,parseCareerDetail} from './src/infra/career-source.ts';
      export default {async fetch(request){try {const {kind,html,id}=await request.json();return Response.json({value:await(kind==='list'?parseCareerList(html):parseCareerDetail(html,id))});}catch(error){return Response.json({error:error.message},{status:422});}}};`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)), sourcefile: "career-source-test-worker.ts", loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent",
  });
  runtime = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: "2025-10-11" });
  await runtime.ready;
});
afterAll(async () => { await runtime?.dispose(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
async function parse(kind: "list" | "detail", html: string, id = "123"): Promise<unknown> {
  const response = await runtime.dispatchFetch("https://parser.test/", { method: "POST", body: JSON.stringify({ kind, html, id }) });
  const result = await response.json() as { value?: unknown; error?: string };
  if (result.error) throw new Error(result.error);
  return result.value;
}
const row = (id = "123", title = "Research &amp; Development") => `<ul class="infoList"><li><a href="/campus/view/id/${id}">${title}</a></li><li class="span4">2026-09-30 12:34:56</li></ul>`;
const detail = (body: string) => `<div class="details-title"><div class="title-message"><h5>测试公告</h5><a class="name">测试单位</a><span class="expired_time">过期时间：2026-11-30</span></div><div class="operation"><li>发布时间：2026-09-30 21:45</li></div></div><div class="details-mge"><div class="aContent">${body}</div></div>`;
function encoded(fragment: string, target = "content1", parent = false): string {
  const first = "🧪x", second = "😀y";
  const payload = Buffer.from(deflateSync(first + Buffer.from(second + fragment).toString("base64"))).toString("base64");
  return `<script>$("#${target}").each(function() { $(this)${parent ? ".parent().html" : ".replaceWith"}(Base64.decode(unzip("${payload}").substr(${first.length})).substr(${second.length})); });</script>`;
}

describe("SYSU static source parser in real Workers runtime", () => {
  it("matches every exact list field from the recorded first page", async () => {
    const result = await parse("list", fixture("list.html"));
    expect(result).toEqual(expected.list);
    expect(result).toHaveLength(20);
  });
  it.each(["997448", "997447"])("matches exact recorded metadata and full plaintext for %s", async id => {
    const result = await parse("detail", fixture(`detail-${id}.html`), id);
    expect(result).toEqual(expected.details.find(item => item.id === id));
    expect(JSON.stringify(result)).not.toContain("body_html");
  });
  it("decodes both UTF-16 substring stages including supplementary-plane prefixes", async () => {
    expect(await parse("list", `<section id="content1"></section>${encoded(row())}`)).toEqual([
      { id: "123", title: "Research & Development", url: "https://career.sysu.edu.cn/campus/view/id/123", publishedAt: "2026-09-30 12:34:56", pinned: false },
    ]);
  });
  it("faithfully replaces parent contents and removes the old siblings", async () => {
    const html = detail('<p>OLD MUST DISAPPEAR</p><section id="content1"></section>') + encoded("<p>真实内容</p>", "content1", true);
    expect(await parse("detail", html)).toMatchObject({ text: "真实内容", partial: false, warnings: [] });
  });
  it("never executes or returns active source markup, and flags unseen media", async () => {
    const fragment = '<p>A &amp; B &#x4e2d; &copy;</p><script>throw Error("executed");</script><style>bad</style><p hidden>SECRET</p><p style="display:none">HIDDEN</p><img src="https://evil.test/track"><iframe src="https://evil.test/embed">EMBED</iframe><p>End</p>';
    const result = await parse("detail", detail('<section id="content1"></section>') + encoded(fragment, "content1", true));
    expect(result).toMatchObject({ text: "A & B 中 ©\nEnd", partial: true, warnings: [
      "1 source image(s), including possible QR codes or image-only requirements, were not fetched or interpreted.",
      "1 embedded/visual element(s) were not fetched or interpreted.",
      "Hidden source content was omitted from the static text capture.",
    ] });
    expect(JSON.stringify(result)).not.toMatch(/evil\.test|SECRET|HIDDEN|EMBED|executed/);
  });
  it("does not leak scripts inserted inside list anchor text", async () => {
    const result = await parse("list", `<section id="content1"></section>${encoded(row("123", 'Safe<script>evil()</script>'))}`);
    expect(result).toMatchObject([{ title: "Safe" }]);
  });
  it("keeps missing metadata unknown with explicit warnings", async () => {
    const result = await parse("detail", '<div class="title-message"><h5>Title</h5></div><div class="details-mge"><div class="aContent">Body</div></div>');
    expect(result).toMatchObject({ employer: null, originalDate: null, sourceExpiry: null, partial: true });
  });
  it.each([
    ["empty list", "list", "<html></html>", "No announcements"],
    ["challenge", "list", "<title>Access Forbidden</title>", "access challenge"],
    ["duplicate IDs", "list", row() + row(), "Duplicate announcement"],
    ["external link", "list", row().replace('href="/', 'href="https://evil.test/'), "Unsupported announcement link"],
    ["query in link", "list", row().replace('id/123"', 'id/123?x=1"'), "Unsupported announcement link"],
    ["missing date", "list", row().replace('class="span4"', 'class="other"'), "row structure"],
    ["bad date", "list", row().replace("2026-09-30 12:34:56", "unknown"), "date format"],
    ["too many rows", "list", Array.from({ length: 31 }, (_, i) => row(String(i))).join(""), "Too many announcement"],
    ["missing title", "detail", detail("Body").replace(/<h5>.*?<\/h5>/, ""), "detail structure"],
    ["empty body", "detail", detail(""), "Missing announcement body"],
    ["duplicate body", "detail", detail("One") + detail("Two"), "detail structure"],
    ["oversized text", "detail", detail("x".repeat(30_001)), "text exceeds"],
    ["unknown entity", "detail", detail("&NotSupported;"), "Unsupported named HTML entity"],
  ] as const)("fails closed for %s", async (_, kind, html, message) => { await expect(parse(kind, html)).rejects.toThrow(message); });
  it("rejects invalid IDs before detail parsing", async () => {
    for (const id of ["", "../123", "123?x=1", "1234567890123"]) await expect(parse("detail", detail("Body"), id)).rejects.toThrow("Invalid announcement ID");
  });
  it("rejects oversized HTML before parsing", async () => { await expect(parse("list", "中".repeat(180_000))).rejects.toThrow("size limit"); });
  it("fails closed on missing or duplicate encoding targets", async () => {
    await expect(parse("list", encoded(row()))).rejects.toThrow("target missing");
    await expect(parse("list", '<i id="content1"></i><i id="content1"></i>' + encoded(row()))).rejects.toThrow("target missing");
  });
  it("rejects unsupported script serialization instead of silently returning other rows", async () => {
    await expect(parse("list", row() + encoded(row("321")).replace(".substr(3)", ".slice(3)"))).rejects.toThrow("Unsupported source serialization");
  });
  it("rejects unresolved placeholders even when the decoder grammar changes completely", async () => {
    await expect(parse("detail", detail('<section id="content123">Loading</section>') + '<script>newDecoder("content123")</script>')).rejects.toThrow("Unresolved encoded source placeholder");
    await expect(parse("list", row() + '<section id="content456"></section>')).rejects.toThrow("Unresolved encoded source placeholder");
  });
  it("bounds encoded block count", async () => {
    const html = Array.from({ length: 5 }, (_, i) => `<i id="content${i}"></i>${encoded(row(String(i)), `content${i}`)}`).join("");
    await expect(parse("list", html)).rejects.toThrow("Too many encoded");
  });
  it("rejects duplicate serialization of the same target", async () => {
    await expect(parse("list", '<i id="content1"></i>' + encoded(row()) + encoded(row()))).rejects.toThrow("Duplicate encoded");
  });
  it("does not allow parent replacement outside the unique detail body", async () => {
    await expect(parse("detail", detail("Body") + '<section id="content1"></section>' + encoded("Body", "content1", true))).rejects.toThrow("unique announcement body");
    await expect(parse("list", '<section id="content1"></section>' + encoded(row(), "content1", true))).rejects.toThrow("Unsupported encoded parent");
  });
  it("bounds compressed bytes, decompressed bytes, and substring offsets", async () => {
    const input = '<section id="content1"></section>' + encoded(row());
    await expect(parse("list", input.replace(/unzip\("[^"]+"/, `unzip("${"A".repeat(90_000)}"`))).rejects.toThrow("oversized encoded");
    await expect(parse("list", '<section id="content1"></section>' + encoded("x".repeat(260_000)))).rejects.toThrow("size limit");
    await expect(parse("list", input.replace(".substr(3)", ".substr(9999999)"))).rejects.toThrow("source offset");
  });
  it("rejects corrupt zlib, noncanonical base64 and invalid UTF-8", async () => {
    const input = '<section id="content1"></section>' + encoded(row());
    await expect(parse("list", input.replace(/unzip\("[^"]+"/, 'unzip("AAAA"'))).rejects.toThrow("compressed source");
    await expect(parse("list", input.replace(/unzip\("[^"]+"/, 'unzip("AB=="'))).rejects.toThrow("encoded source");
    const badUtf8 = Buffer.from(deflateSync(Buffer.from([0xff, 0xfe]))).toString("base64");
    await expect(parse("list", input.replace(/unzip\("[^"]+"/, `unzip("${badUtf8}"`))).rejects.toThrow("UTF-8");
  });
});

describe("strict single-request source fetch boundary (no real network)", () => {
  function mock(response: Response | Error) {
    const fetcher = response instanceof Error ? vi.fn().mockRejectedValue(response) : vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }
  it("uses only the fixed origin, exact authorized UA, no caller credentials, and manual redirects", async () => {
    const fetcher = mock(new Response(row(), { headers: { "Content-Type": "text/html;charset=utf-8" } }));
    expect(await fetchCareerHtml("/campus/index")).toBe(row());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://career.sysu.edu.cn/campus/index");
    expect(options).toMatchObject({ method: "GET", redirect: "manual", cache: "no-store", headers: { "User-Agent": CAREER_SOURCE_USER_AGENT, Accept: "text/html" } });
    expect(Object.keys(options.headers).sort()).toEqual(["Accept", "User-Agent"]);
  });
  it("permits the exact numeric detail path", async () => {
    const fetcher = mock(new Response(detail("Body"), { headers: { "Content-Type": "text/html" } }));
    await fetchCareerHtml("/campus/view/id/997448");
    expect(fetcher.mock.calls[0]![0]).toBe("https://career.sysu.edu.cn/campus/view/id/997448");
  });
  it.each(["https://career.sysu.edu.cn/campus/index", "https://evil.test", "//evil.test/campus/index", "/campus/index?page=2", "/campus/index/", "/campus/index#x", "/campus/view/id/1?x=1", "/campus/view/id/%31", "/campus/view/id/1234567890123", "/campus/view/id/1/../../", "/campus/view/id/1\n", "/company/view/id/1"])("rejects unauthorized path %s without any network request", async path => {
    const fetcher = mock(new Error("Must not call"));
    await expect(fetchCareerHtml(path)).rejects.toThrow("Unsupported career source path");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([301, 302, 307, 308, 403, 429, 500])( "stops on HTTP %s without retry or fallback", async status => {
    const fetcher = mock(new Response("blocked", { status, headers: { "Content-Type": "text/html", ...(status < 400 ? { Location: "https://other.test/" } : {}) } }));
    await expect(fetchCareerHtml("/campus/index")).rejects.toThrow(/redirect|restricted|HTTP/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects a reported redirect even if the final HTTP status is 200", async () => {
    const response = new Response(row(), { headers: { "Content-Type": "text/html" } });
    Object.defineProperty(response, "redirected", { value: true });
    mock(response);
    await expect(fetchCareerHtml("/campus/index")).rejects.toThrow("redirect");
  });
  it.each(["application/json", "text/html;charset=gbk", "", "text/htmlnot"])("rejects unsupported response type %s", async contentType => {
    mock(new Response(row(), { headers: { "Content-Type": contentType } }));
    await expect(fetchCareerHtml("/campus/index")).rejects.toThrow("UTF-8 HTML");
  });
  it("rejects HTML access challenges without fallback", async () => {
    const fetcher = mock(new Response("<title>Access Forbidden</title>", { headers: { "Content-Type": "text/html" } }));
    await expect(fetchCareerHtml("/campus/index")).rejects.toThrow("access challenge");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("enforces both declared and streamed response size limits", async () => {
    mock(new Response("small", { headers: { "Content-Type": "text/html", "Content-Length": "524289" } }));
    await expect(fetchCareerHtml("/campus/index")).rejects.toThrow("size limit");
    mock(new Response("x".repeat(524289), { headers: { "Content-Type": "text/html", "Content-Length": "1" } }));
    await expect(fetchCareerHtml("/campus/index")).rejects.toThrow("size limit");
  });
  it("stops on network failure", async () => {
    const fetcher = mock(new Error("connection reset"));
    await expect(fetchCareerHtml("/campus/index")).rejects.toThrow("network request failed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds stalled headers with a timeout and abort signal", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(() => new Promise(() => {})); vi.stubGlobal("fetch", fetcher);
    const pending = expect(fetchCareerHtml("/campus/index")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15_001); await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as unknown as [string, { signal: AbortSignal }])[1].signal.aborted).toBe(true);
  });
  it("keeps the timeout active during stalled body reads and cancels the stream", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    mock(new Response(new ReadableStream({ cancel: cancelled }), { headers: { "Content-Type": "text/html" } }));
    const pending = expect(fetchCareerHtml("/campus/index")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15_001); await pending;
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
