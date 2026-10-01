/**
 * Read-only VTEX relay for a project's draft preview.
 *
 * An app preview (`kind: "eitri-app"`) renders in a sandboxed, opaque-origin
 * frame and calls the store's VTEX APIs, which send no CORS headers. This
 * relays exactly the public catalog / Intelligent Search / read-only GraphQL
 * GETs those screens need. It rides on the decofile draft token
 * (`GET /api/:org/decofile/:vmcp/:branch/commerce?token=…&url=…`), so only a
 * frame Studio opened can use it, scoped to one app project (the route only
 * serves projects on the app-preview canvas or with a `.deco/app.json`).
 *
 * Never an open proxy: https only, `<account>.vtexcommercestable.com.br` or
 * `<account>.myvtex.com` (only the manifest's `vtexAccount` when it names
 * one), a fixed path allowlist with no encoded separators, GET only, GraphQL
 * only as `query`/`variables`/`operationName`, no client headers (no cookies,
 * no Authorization), no redirects, JSON responses only, size and time caps,
 * a byte-bounded cache. Responses carry no upstream headers but the type.
 */

const HOST_RE =
  /^([a-z0-9][a-z0-9-]{0,62})\.(?:vtexcommercestable\.com\.br|myvtex\.com)$/;
const PATH_RE =
  /^\/api\/(?:catalog_system\/pub\/|intelligent-search\/|io\/_v\/api\/intelligent-search\/)/;
const GRAPHQL_RE = /^\/api\/io\/_v\/(?:private|public)\/graphql\/v1\/?$/;
const GRAPHQL_PARAMS = new Set(["query", "variables", "operationName"]);
/** Encoded `/`, `\` or `.` could step out of the allowlisted prefix upstream. */
const ENCODED_SEPARATOR_RE = /%(?:2f|5c|2e)/i;
const MAX_URL_CHARS = 8192;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

/**
 * The upstream URL to relay, or null when the policy refuses it. With
 * `account` (the app's `.deco/app.json` `vtexAccount`), only that store.
 */
export function commerceRelayTarget(
  raw: string | undefined,
  account?: string | null,
): URL | null {
  if (!raw || raw.length > MAX_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = HOST_RE.exec(url.hostname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !host ||
    (account && host[1] !== account) ||
    ENCODED_SEPARATOR_RE.test(url.pathname)
  ) {
    return null;
  }
  if (PATH_RE.test(url.pathname)) return url;
  if (GRAPHQL_RE.test(url.pathname)) {
    for (const name of url.searchParams.keys()) {
      if (!GRAPHQL_PARAMS.has(name)) return null;
    }
    const query = url.searchParams.get("query");
    // A persisted query (no text) can't be proven read-only.
    return query && !/\b(?:mutation|subscription)\b/.test(query) ? url : null;
  }
  return null;
}

/** Bodies above this are relayed but never cached. */
const MAX_CACHED_BODY_BYTES = 256 * 1024;
/** Whole relay cache per pod, in body bytes. */
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  status: number;
  body: Uint8Array<ArrayBuffer>;
  expiresAt: number;
}

/** Same URL, same answer for everyone (no credentials go upstream).
 *  Insertion-ordered, so shedding from the front drops the oldest. */
const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;

function cacheDrop(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cacheBytes -= entry.body.byteLength;
}

function cacheGet(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (entry && entry.expiresAt <= Date.now()) {
    cacheDrop(key, entry);
    return undefined;
  }
  return entry;
}

function cacheSet(key: string, body: Uint8Array<ArrayBuffer>): void {
  if (body.byteLength > MAX_CACHED_BODY_BYTES) return;
  const previous = cache.get(key);
  if (previous) cacheDrop(key, previous);
  cache.set(key, { status: 200, body, expiresAt: Date.now() + CACHE_TTL_MS });
  cacheBytes += body.byteLength;
  for (const [oldest, entry] of cache) {
    if (cacheBytes <= MAX_CACHE_BYTES) break;
    cacheDrop(oldest, entry);
  }
}

const relayHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=60",
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};

async function readCapped(
  res: Response,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function relayCommerceRead(
  target: URL,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const hit = cacheGet(target.href);
  if (hit) {
    return new Response(hit.body, {
      status: hit.status,
      headers: relayHeaders,
    });
  }
  let res: Response;
  try {
    res = await fetchImpl(target, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return Response.json(
      { error: "upstream" },
      { status: 502, headers: relayHeaders },
    );
  }
  // Only JSON comes back: an upstream HTML page must never render on Studio's origin.
  const type = res.headers.get("content-type") ?? "";
  const body =
    res.status < 300 || res.status >= 400
      ? /^application\/(?:[\w.+-]+\+)?json\b/i.test(type)
        ? await readCapped(res).catch(() => null)
        : null
      : null;
  if (!body) {
    await res.body?.cancel().catch(() => {});
    return Response.json(
      { error: "upstream" },
      { status: 502, headers: relayHeaders },
    );
  }
  if (res.status === 200) cacheSet(target.href, body);
  return new Response(body, { status: res.status, headers: relayHeaders });
}
