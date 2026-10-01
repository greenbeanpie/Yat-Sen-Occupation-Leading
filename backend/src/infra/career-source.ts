/** Bounded, read-only SYSU static source adapter. No page JavaScript is executed. */
export const CAREER_SOURCE_ORIGIN = "https://career.sysu.edu.cn";
export const CAREER_SOURCE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
const MAX_HTML_BYTES = 512 * 1024;
const MAX_COMPRESSED_BYTES = 64 * 1024;
const MAX_INFLATED_BYTES = 256 * 1024;
const MAX_BLOCKS = 4;
const MAX_TEXT = 30_000;
const FETCH_TIMEOUT_MS = 15_000;
const DETAIL_PATH = /^\/campus\/view\/id\/([0-9]{1,12})$/;
const ID = /^[0-9]{1,12}$/;

export class CareerSourceError extends Error {
  constructor(message: string) { super(message); this.name = "CareerSourceError"; }
}
export interface CareerListItem {
  id: string;
  title: string;
  url: string;
  publishedAt: string;
  pinned: boolean;
}
export interface CareerDetail {
  id: string;
  url: string;
  title: string;
  employer: string | null;
  originalDate: string | null;
  sourceExpiry: string | null;
  text: string;
  partial: boolean;
  warnings: string[];
}
const fail = (message: string): never => { throw new CareerSourceError(message); };
const utf8 = (bytes: Uint8Array): string => {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { return fail("Source is not valid UTF-8"); }
};
function checkHtml(html: string): void {
  if (!html.trim() || html.length > MAX_HTML_BYTES || new TextEncoder().encode(html).length > MAX_HTML_BYTES) fail("Source HTML is empty or exceeds size limit");
  if (/<title\b[^>]*>[^<]*(?:access forbidden|access denied|限制访问|访问限制|just a moment|attention required|captcha|验证|安全检查)[^<]*<\/title\s*>/i.test(html)
    || /(?:id=["'](?:challenge-form|cf-challenge-running)["']|\/cdn-cgi\/challenge-platform\/)/i.test(html)) fail("Source returned an access challenge; stopped");
}
async function readBounded(stream: ReadableStream<Uint8Array> | null, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!stream) return fail("Source response has no body");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) fail("Source request timed out");
      const { done, value } = await reader.read();
      if (signal?.aborted) fail("Source request timed out");
      if (done) break;
      length += value.byteLength;
      if (length > limit) { cancel(); fail("Source exceeds size limit"); }
      chunks.push(value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Only the first list page and an exact numeric detail path are authorized.
 * Workers fetch has no cookie jar; explicit headers never forward caller credentials.
 * One request only: no redirects, assets, links, retries, or alternate access routes.
 */
export async function fetchCareerHtml(path: string): Promise<string> {
  if (path !== "/campus/index" && !DETAIL_PATH.test(path)) fail("Unsupported career source path");
  const url = `${CAREER_SOURCE_ORIGIN}${path}`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new CareerSourceError("Source request timed out")); }, FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetch(url, {
        method: "GET", redirect: "manual", cache: "no-store", signal: controller.signal,
        headers: { "User-Agent": CAREER_SOURCE_USER_AGENT, Accept: "text/html" },
      });
      const rejectResponse = (message: string): never => {
        void response.body?.cancel().catch(() => undefined);
        return fail(message);
      };
      if (controller.signal.aborted) return rejectResponse("Source request timed out");
      if (response.redirected || (response.status >= 300 && response.status < 400) || response.headers.has("Location") || (response.url && response.url !== url)) return rejectResponse("Source redirect rejected");
      if (response.status === 403 || response.status === 429) return rejectResponse(`Source access restricted (${response.status}); stopped`);
      if (response.status !== 200) return rejectResponse(`Source HTTP ${response.status}; stopped`);
      const contentType = response.headers.get("Content-Type") ?? "";
      if (!/^text\/html(?:\s*;|\s*$)/i.test(contentType) || /charset\s*=\s*["']?(?!utf-8\b|utf8\b)[^\s;"']+/i.test(contentType)) return rejectResponse("Source response is not UTF-8 HTML");
      const claimedLength = response.headers.get("Content-Length");
      if (claimedLength !== null && (!/^\d+$/.test(claimedLength) || Number(claimedLength) > MAX_HTML_BYTES)) return rejectResponse("Source exceeds size limit");
      const html = utf8(await readBounded(response.body, MAX_HTML_BYTES, controller.signal));
      checkHtml(html);
      return html;
    })()]);
  } catch (error) {
    if (error instanceof CareerSourceError) throw error;
    throw new CareerSourceError(controller.signal.aborted ? "Source request timed out" : "Source network request failed; stopped");
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

interface EncodedBlock { id: string; parent: boolean; payload: string; outerOffset: number; innerOffset: number; fragment?: string }
// Recognize only the observed literal serialization grammar, never evaluate script.
const ENCODED_BLOCK = /\$\("#([A-Za-z][A-Za-z0-9_-]{0,63})"\)\.each\(function\(\)\s*\{\s*\$\(this\)(\.replaceWith|\.parent\(\)\.html)\(Base64\.decode\(unzip\("([A-Za-z0-9+/=]+)"\)\.substr\((\d{1,7})\)\)\.substr\((\d{1,7})\)\);\s*\}\);/g;
function base64(value: string, maxBytes: number): Uint8Array {
  if (!value || value.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return fail("Invalid or oversized encoded source block");
  let binary: string;
  try { binary = atob(value); } catch { return fail("Invalid base64 source block"); }
  if (binary.length > maxBytes || btoa(binary) !== value) return fail("Invalid or oversized encoded source block");
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function jsSubstr(value: string, offset: number): string {
  // Native JS slices UTF-16 code units, exactly like the site's positive .substr(n).
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= value.length) return fail("Invalid encoded source offset");
  return value.slice(offset);
}
async function decodeHtml(html: string, kind: "list" | "detail"): Promise<string> {
  checkHtml(html);
  const scripts: string[] = [];
  let current = -1;
  await new HTMLRewriter().on("script", {
    element() { current = scripts.push("") - 1; },
    text(chunk) { scripts[current] += chunk.text; },
  }).transform(new Response(html)).text();
  const blocks: EncodedBlock[] = [];
  for (const script of scripts) {
    const matches = Array.from(script.matchAll(ENCODED_BLOCK));
    const serializationCalls = script.match(/Base64\s*\.\s*decode\s*\(\s*unzip\s*\(/g) ?? [];
    if (matches.length !== serializationCalls.length) fail("Unsupported source serialization");
    for (const match of matches) {
      blocks.push({ id: match[1]!, parent: match[2] === ".parent().html", payload: match[3]!, outerOffset: Number(match[4]), innerOffset: Number(match[5]) });
      if (blocks.length > MAX_BLOCKS) fail("Too many encoded source blocks");
    }
  }
  if (new Set(blocks.map(block => block.id)).size !== blocks.length) fail("Duplicate encoded source target");
  if (blocks.some(block => block.parent) && (kind !== "detail" || blocks.length !== 1)) fail("Unsupported encoded parent structure");
  let totalDecoded = 0;
  for (const block of blocks) {
    let bytes: Uint8Array;
    try {
      const compressed = base64(block.payload, MAX_COMPRESSED_BYTES);
      const inflated = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"));
      bytes = await readBounded(inflated, MAX_INFLATED_BYTES);
    } catch (error) {
      if (error instanceof CareerSourceError) throw error;
      return fail("Invalid compressed source block");
    }
    // Base64 -> zlib -> UTF-8 -> UTF-16 substring -> Base64 -> UTF-8 -> UTF-16 substring.
    const encodedFragment = jsSubstr(utf8(bytes), block.outerOffset);
    block.fragment = jsSubstr(utf8(base64(encodedFragment, MAX_INFLATED_BYTES)), block.innerOffset);
    totalDecoded += bytes.byteLength + new TextEncoder().encode(block.fragment).length;
    if (totalDecoded > MAX_HTML_BYTES) fail("Decoded source exceeds size limit");
  }
  // Validate targets in the original document, before any replacement can mask a missing target.
  const counts = new Map<string, number>();
  let bodyCount = 0;
  let verify = new HTMLRewriter().on(".details-mge .aContent", { element() { bodyCount++; } });
  for (const block of blocks) {
    counts.set(block.id, 0);
    verify = verify.on(`#${block.id}`, { element() { counts.set(block.id, counts.get(block.id)! + 1); } });
    if (block.parent) verify = verify.on(`.details-mge .aContent > #${block.id}`, { element() { counts.set("parent", (counts.get("parent") ?? 0) + 1); } });
  }
  await verify.transform(new Response(html)).text();
  if (blocks.some(block => counts.get(block.id) !== 1)) fail("Encoded source target missing or duplicated");
  if (blocks.some(block => block.parent) && (bodyCount !== 1 || counts.get("parent") !== 1)) fail("Encoded parent is not the unique announcement body");
  let rewriter = new HTMLRewriter();
  for (const block of blocks) {
    rewriter = block.parent
      ? rewriter.on(".details-mge .aContent", { element(element) { element.setInnerContent(block.fragment!, { html: true }); } })
      : rewriter.on(`#${block.id}`, { element(element) { element.replace(block.fragment!, { html: true }); } });
  }
  for (const tag of ["script", "style", "noscript", "template"]) rewriter = rewriter.on(tag, { element(element) { element.remove(); } });
  const decoded = await rewriter.transform(new Response(html)).text();
  checkHtml(decoded);
  let clean = new HTMLRewriter().on("section[id]", { element(element) {
    if (/^content[0-9]+$/.test(element.getAttribute("id") ?? "")) fail("Unresolved encoded source placeholder");
  } });
  for (const tag of ["script", "style", "noscript", "template"]) clean = clean.on(tag, { element(element) { element.remove(); } });
  return clean.transform(new Response(decoded)).text();
}

// HTMLRewriter token text preserves entities. Support explicit common named entities
// and numeric references; fail closed on unknown names instead of silently corrupting evidence.
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", hellip: "…", copy: "©", reg: "®", trade: "™", times: "×", divide: "÷", yen: "¥", euro: "€", pound: "£", cent: "¢" };
function plain(value: string): string {
  const decoded = value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/gi, (_, entity: string) => {
    if (!entity.startsWith("#")) return ENTITIES[entity] ?? fail("Unsupported named HTML entity");
    const cp = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || (cp >= 0x80 && cp <= 0x9f)) return fail("Unsupported numeric HTML entity");
    return String.fromCodePoint(cp);
  });
  return decoded.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").normalize("NFC").trim();
}
function boundedText(value: string, limit: number, label: string): string {
  const text = plain(value);
  if (!text || text.length > limit) return fail(`Missing or oversized source ${label}`);
  return text;
}
function sourceUrl(href: string): { id: string; url: string } {
  // Do not normalize untrusted URLs: encoded paths, queries and external hosts are rejected.
  const path = href.startsWith(CAREER_SOURCE_ORIGIN + "/") ? href.slice(CAREER_SOURCE_ORIGIN.length) : href;
  const match = DETAIL_PATH.exec(path);
  if (!match) return fail("Unsupported announcement link");
  return { id: match[1]!, url: `${CAREER_SOURCE_ORIGIN}${path}` };
}

export async function parseCareerList(html: string): Promise<CareerListItem[]> {
  const decoded = await decodeHtml(html, "list");
  const rows: { href: string; title: string; date: string; pinned: boolean; anchors: number; dates: number }[] = [];
  let active: (typeof rows)[number] | undefined;
  await new HTMLRewriter()
    .on("ul.infoList", { element(element) {
      if (active) fail("Nested announcement list rows");
      active = { href: "", title: "", date: "", pinned: false, anchors: 0, dates: 0 };
      rows.push(active);
      if (rows.length > 30) fail("Too many announcement rows");
      element.onEndTag(() => { active = undefined; });
    } })
    .on('ul.infoList a[href*="/campus/view/id/"]', {
      element(element) { if (!active) fail("Announcement link outside a row"); active!.anchors++; active!.href = element.getAttribute("href") ?? ""; },
      text(chunk) { if (active) active.title += chunk.text; },
    })
    .on("ul.infoList li.span4", { element() { if (active) active.dates++; }, text(chunk) { if (active) active.date += chunk.text; } })
    .on("ul.infoList .status-ding", { element() { if (active) active.pinned = true; } })
    .transform(new Response(decoded)).text();
  if (!rows.length) fail("No announcements found; source structure changed");
  const result = rows.map(row => {
    if (row.anchors !== 1 || row.dates !== 1) fail("Announcement row structure changed");
    const title = boundedText(row.title, 500, "title");
    const publishedAt = plain(row.date);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(publishedAt)) fail("Announcement date format changed");
    return { ...sourceUrl(row.href), title, publishedAt, pinned: row.pinned };
  });
  if (new Set(result.map(item => item.id)).size !== result.length) fail("Duplicate announcement ID");
  return result;
}

export async function parseCareerDetail(html: string, id: string): Promise<CareerDetail> {
  if (!ID.test(id)) fail("Invalid announcement ID");
  const decoded = await decodeHtml(html, "detail");
  let images = 0, embeds = 0, hidden = 0;
  let sanitize = new HTMLRewriter();
  sanitize = sanitize.on(".details-mge .aContent img", { element() { images++; } });
  // Count missing visual/embedded evidence, then remove fallback/active content from text.
  for (const tag of ["iframe", "object", "embed", "video", "audio", "svg", "canvas", "picture"])
    sanitize = sanitize.on(`.details-mge .aContent ${tag}`, { element(element) { embeds++; element.remove(); } });
  sanitize = sanitize.on(".details-mge .aContent *", { element(element) {
    const style = element.getAttribute("style") ?? "";
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) hidden++;
  } });
  sanitize = sanitize.on("*", { element(element) {
    const style = element.getAttribute("style") ?? "";
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) { element.remove(); }
  } });
  // Inserted fragments are reparsed here; no scripts, including scripts inside a fragment, survive.
  for (const tag of ["script", "style", "noscript", "template"]) sanitize = sanitize.on(tag, { element(element) { element.remove(); } });
  const safeHtml = await sanitize.transform(new Response(decoded)).text();
  let title = "", employer = "", expiry = "", operation = "", body = "", node = "";
  let titleCount = 0, employerCount = 0, expiryCount = 0, bodyCount = 0;
  await new HTMLRewriter()
    .on(".title-message h5", { element() { titleCount++; }, text(chunk) { title += chunk.text; } })
    .on(".title-message a.name", { element() { employerCount++; }, text(chunk) { employer += chunk.text; } })
    .on(".expired_time", { element() { expiryCount++; }, text(chunk) { expiry += chunk.text; } })
    .on(".details-title .operation", { text(chunk) { operation += chunk.text; } })
    .on(".details-mge .aContent", {
      element() { bodyCount++; },
      text(chunk) {
        node += chunk.text;
        if (chunk.lastInTextNode) {
          const text = plain(node); node = "";
          if (text) body += (body ? "\n" : "") + text;
          if (body.length > MAX_TEXT) fail("Announcement text exceeds size limit");
        }
      },
    }).transform(new Response(safeHtml)).text();
  if (titleCount !== 1 || bodyCount !== 1 || employerCount > 1 || expiryCount > 1 || node) fail("Announcement detail structure changed");
  title = boundedText(title, 500, "title");
  if (!body) fail("Missing announcement body text");
  const dates = Array.from(plain(operation).matchAll(/发布时间[：:]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)(?![\d:])/g));
  if (dates.length > 1 || (operation.includes("发布时间") && dates.length !== 1)) fail("Announcement publication date format changed");
  const sourceExpiry = expiryCount ? boundedText(expiry, 100, "expiry") : null;
  if (sourceExpiry && !/^过期时间[：:]\s*\d{4}-\d{2}-\d{2}$/.test(sourceExpiry)) fail("Announcement expiry format changed");
  const warnings: string[] = [];
  if (images) warnings.push(`${images} source image(s), including possible QR codes or image-only requirements, were not fetched or interpreted.`);
  if (embeds) warnings.push(`${embeds} embedded/visual element(s) were not fetched or interpreted.`);
  if (hidden) warnings.push("Hidden source content was omitted from the static text capture.");
  if (!employerCount) warnings.push("Employer is missing from the source metadata.");
  if (!dates.length) warnings.push("Original publication date is missing from the source metadata.");
  if (!sourceExpiry) warnings.push("Website expiry is missing from the source metadata.");
  return {
    id, url: `${CAREER_SOURCE_ORIGIN}/campus/view/id/${id}`, title,
    employer: employerCount ? boundedText(employer, 500, "employer") : null,
    originalDate: dates[0]?.[1] ?? null, sourceExpiry, text: body,
    partial: warnings.length > 0, warnings,
  };
}
