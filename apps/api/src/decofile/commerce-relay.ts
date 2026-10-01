/**
 * Read-only VTEX relay for a project's draft preview.
 *
 * An app preview (`kind: "eitri-app"`) renders in a sandboxed, opaque-origin
 * frame and calls the store's VTEX APIs, which send no CORS headers. This
 * relays exactly the public catalog / Intelligent Search / read-only GraphQL
 * GETs those screens need. It rides on the decofile draft token
 * (`GET /api/:org/decofile/:vmcp/:branch/commerce?token=…&url=…`), so only a
 * frame Studio opened can use it, scoped to one project.
 *
 * Never an open proxy: https only, `<account>.vtexcommercestable.com.br` or
 * `<account>.myvtex.com`, a fixed path allowlist, GET only, no client headers
 * (no cookies, no Authorization), no redirects, JSON responses only, size and
 * time caps. Responses carry no upstream headers but the content type.
 */

import { createTtlLruCache } from "@/lib/ttl-lru-cache";

const HOST_RE =
  /^[a-z0-9][a-z0-9-]{0,62}\.(?:vtexcommercestable\.com\.br|myvtex\.com)$/;
const PATH_RE =
  /^\/api\/(?:catalog_system\/pub\/|intelligent-search\/|io\/_v\/api\/intelligent-search\/)/;
const GRAPHQL_RE = /^\/api\/io\/_v\/(?:private|public)\/graphql\/v1\/?$/;
const MAX_URL_CHARS = 8192;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

/** The upstream URL to relay, or null when the policy refuses it. */
export function commerceRelayTarget(raw: string | undefined): URL | null {
  if (!raw || raw.length > MAX_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !HOST_RE.test(url.hostname)
  ) {
    return null;
  }
  if (PATH_RE.test(url.pathname)) return url;
  if (GRAPHQL_RE.test(url.pathname)) {
    const query = url.searchParams.get("query");
    // A persisted query (no text) can't be proven read-only.
    return query && !/\b(?:mutation|subscription)\b/.test(query) ? url : null;
  }
  return null;
}

/** Same URL, same answer for everyone (no credentials go upstream). */
const cache = createTtlLruCache<{
  status: number;
  body: Uint8Array<ArrayBuffer>;
}>({
  ttlMs: 60_000,
  maxSize: 500,
});

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
  const hit = cache.get(target.href);
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
  if (res.status === 200 && body.byteLength < 1024 * 1024) {
    cache.set(target.href, { status: 200, body });
  }
  return new Response(body, { status: res.status, headers: relayHeaders });
}
