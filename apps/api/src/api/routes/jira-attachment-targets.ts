/**
 * Pure addressing + validation helpers for the Jira attachment proxy
 * (`jira-attachments.ts`). Split out so the unit test can cover the guards
 * without loading the route — and with it Better Auth and the storage layer.
 *
 * Every function here decides where a request may go or what may be echoed
 * back, so each one fails closed on input it does not recognize.
 */

/** Where Atlassian's cloud REST + OAuth resource discovery live. */
export const ATLASSIAN_API_HOST = "api.atlassian.com";

/**
 * Ceiling on a proxied attachment. Jira's own default limit is 10MB but it is
 * configurable per site, and the point of the cap is the pod's disk and this
 * process's memory, not Jira's policy.
 *
 * ponytail: enforced from `content-length` only, then streamed. A response that
 * lies about its length gets through — that is Atlassian lying to us, not the
 * threat this bounds. Wrap the stream in a counting transform if that changes.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Bounded so a wedged upstream can't hold a request open indefinitely. */
export const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Numeric Jira attachment id, or null. Digits only: this value lands in the
 * upstream URL path, so anything else — a traversal segment, a query, an
 * absolute URL — must not survive. Pure; the unit test owns the shape.
 */
export function parseAttachmentId(raw: string | undefined): string | null {
  return raw && /^[0-9]{1,20}$/.test(raw) ? raw : null;
}

/**
 * True for a host that belongs to Atlassian. Used twice, for two different
 * reasons: to confirm a connection really is Atlassian before its token is
 * spent, and to confirm the 303 from the content endpoint lands on Atlassian's
 * media CDN rather than somewhere the redirect could carry the request.
 *
 * Suffix match on a dot boundary — `atlassian.com.evil.test` must not pass.
 */
export function isAtlassianHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "atlassian.com" ||
    h === "atlassian.net" ||
    h.endsWith(".atlassian.com") ||
    h.endsWith(".atlassian.net")
  );
}

/** True when `url` parses and its host is Atlassian's. Pure. */
export function isAtlassianUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      isAtlassianHost(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** One entry of Atlassian's `/oauth/token/accessible-resources`. */
export interface AccessibleResource {
  id: string;
  url?: string;
  name?: string;
}

export type CloudIdResolution =
  | { ok: true; cloudId: string }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Pick the Jira site to read from: the requested `cloudId` if the token can
 * actually see it, or the only one when there is exactly one and the caller
 * named none.
 *
 * Validating against the token's own accessible-resources list — rather than
 * shape-checking a caller-supplied id — is what keeps the upstream URL from
 * being steerable: an id the token cannot see is refused instead of fetched.
 * Ambiguity is an error, never a guess: silently picking the first of several
 * sites would serve BR data for a GLOBAL card and look like a Jira bug.
 *
 * Pure; the unit test owns every branch.
 */
export function resolveCloudId(
  requested: string | null | undefined,
  accessible: readonly AccessibleResource[],
): CloudIdResolution {
  const ids = accessible.map((r) => r.id).filter((id) => id.length > 0);
  if (ids.length === 0) {
    return {
      ok: false,
      status: 403,
      error:
        "This connection's Atlassian token can reach no sites. Reconnect it.",
    };
  }
  if (requested) {
    if (!ids.includes(requested)) {
      return {
        ok: false,
        status: 403,
        error: `cloudId ${requested} is not reachable with this connection's token`,
      };
    }
    return { ok: true, cloudId: requested };
  }
  if (ids.length > 1) {
    return {
      ok: false,
      status: 400,
      error: `This connection reaches ${ids.length} Atlassian sites — pass ?cloudId= one of: ${ids.join(", ")}`,
    };
  }
  // Non-null: length is exactly 1 here, but noUncheckedIndexedAccess doesn't
  // know that.
  const only = ids[0];
  return only
    ? { ok: true, cloudId: only }
    : { ok: false, status: 403, error: "No usable Atlassian site" };
}

/** The attachment-content endpoint for one site. Pure. */
export function attachmentContentUrl(
  cloudId: string,
  attachmentId: string,
): string {
  return `https://${ATLASSIAN_API_HOST}/ex/jira/${encodeURIComponent(
    cloudId,
  )}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`;
}

/**
 * `content-disposition` safe to echo back: keep the upstream's filename when it
 * is a plain one, otherwise name the file after the attachment id. The header
 * reaches a shell that may redirect it to disk, so a quoted path or a newline
 * does not get to pass through.
 *
 * Pure; the unit test owns it.
 */
export function safeContentDisposition(
  upstream: string | null,
  attachmentId: string,
): string {
  const name = upstream?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
  const safe =
    name && /^[A-Za-z0-9._ -]{1,120}$/.test(name)
      ? name
      : `attachment-${attachmentId}`;
  return `attachment; filename="${safe}"`;
}
