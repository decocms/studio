/**
 * Files Route
 *
 * Serves org-scoped storage files via a stable, non-expiring URL.
 * Proxies the object bytes through studio on every request (presigning
 * internally), so the caller never sees storage URLs or manages expiry.
 *
 * Route: GET /api/:org/files/:key
 *
 * This endpoint is the stable URL stored in chat history as the text
 * annotation for uploaded files. Authenticated clients (UI <img> tags) can use
 * it instead of presigned URLs and it always works.
 *
 * Requires an authenticated session (StudioContext) — the org ID in the
 * URL is only used to extract the file key, not to bypass auth.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { StudioContext } from "@/core/studio-context";
import { generatePresignedGetUrl } from "./decopilot/file-materializer";
import { usesLocalObjectStorage } from "@/tools/connection/dev-assets";
import { isBrowserNavigation } from "../utils/browser-navigation";

type Variables = { studioContext: StudioContext };

const app = new Hono<{ Variables: Variables }>();

/** Request headers forwarded to storage so Range requests (media seeking)
 * and conditional revalidation keep working through the proxy. */
const FORWARDED_REQUEST_HEADERS = [
  "range",
  "if-none-match",
  "if-modified-since",
] as const;

/** Response headers passed through from storage to the client. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;

/** Now that bytes are served same-origin (no more redirect to the storage
 * domain), member-authored active content must not run with studio's origin.
 * CSP-sandbox it so scripts get an opaque origin and can't make credentialed
 * same-origin calls (same posture as the org-fs /read route). */
function applyContentPolicy(headers: Headers, contentType: string): void {
  if (
    contentType.startsWith("text/html") ||
    contentType.startsWith("image/svg")
  ) {
    // TEMP(demo 2026-07-08, REVERT): allow-same-origin — see org-fs.ts.
    headers.set(
      "Content-Security-Policy",
      "sandbox allow-scripts allow-modals allow-same-origin",
    );
  }
}

app.get("/:org/files/*", async (c) => {
  const ctx = c.get("studioContext");

  const orgId = ctx.organization?.id;

  if (!ctx.auth?.user?.id) {
    // A logged-out person opening a file link in the browser should land on
    // login (and return to this org afterward), not a raw JSON 401. API
    // clients (no `Accept: text/html`) still get the 401.
    if (isBrowserNavigation(c)) {
      return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`, 302);
    }
    throw new HTTPException(401, { message: "Authentication required" });
  }

  if (!orgId) {
    throw new HTTPException(401, { message: "Organization context required" });
  }

  // Extract the file key from the wildcard segment
  // Full path is /api/:org/files/:key — strip everything up to and including /files/
  const key = c.req.path.replace(/^.*\/files\//, "");

  if (!key) {
    throw new HTTPException(400, { message: "Missing file key" });
  }

  const presignedUrl = await generatePresignedGetUrl(key, ctx);

  if (!presignedUrl) {
    throw new HTTPException(503, { message: "Object storage not configured" });
  }

  // DevObjectStorage returns data: URIs — serve the bytes inline.
  if (presignedUrl.startsWith("data:") && usesLocalObjectStorage()) {
    const match = presignedUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) {
      throw new HTTPException(500, {
        message: "Invalid data URL from storage",
      });
    }
    const [, contentType, base64] = match;
    const bytes = Buffer.from(base64!, "base64");
    const headers = new Headers({
      "Content-Type": contentType!,
      "Cache-Control": "private, max-age=86400",
    });
    applyContentPolicy(headers, contentType!);
    return new Response(bytes, { status: 200, headers });
  }

  // Proxy the object through studio instead of redirecting: the storage origin
  // and signed URLs never reach the client.
  const upstreamHeaders = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = c.req.header(name);
    if (value) upstreamHeaders.set(name, value);
  }

  const upstream = await fetch(presignedUrl, { headers: upstreamHeaders });

  // 200 OK / 206 Partial Content / 304 Not Modified / 416 Range Not
  // Satisfiable pass through; storage 403/404 both mean "no such object"
  // to the caller; anything else is a storage-side failure.
  if (upstream.status === 403 || upstream.status === 404) {
    throw new HTTPException(404, { message: "File not found" });
  }
  if (!upstream.ok && upstream.status !== 304 && upstream.status !== 416) {
    console.error(
      `[files] upstream storage error ${upstream.status} for key:`,
      key,
    );
    throw new HTTPException(502, { message: "Upstream storage error" });
  }

  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Cache-Control", "private, max-age=86400");
  applyContentPolicy(headers, headers.get("content-type") ?? "");

  return new Response(upstream.body, { status: upstream.status, headers });
});

export default app;
