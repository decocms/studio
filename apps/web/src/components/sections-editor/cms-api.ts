/**
 * The web editor's client for the hosted CMS on R2
 * (`/api/cms/:site/...`): the site-keyed routes that replace the v8 git
 * path's `/decofile/:virtualMcpId/:branch`. No GitHub on any of them.
 *
 * The site is the project's `metadata.siteSlug`; the path names no
 * organization (Studio finds the site's). The editor's draft is named after
 * its thread's branch, as today.
 */

import { canonicalJson } from "@decocms/blocks/protocol";
import { isValidSiteSlug } from "@decocms/shared/site-slug";

/** The project's site id, or null when it names none. */
export function cmsSiteOf(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const slug = metadata?.siteSlug;
  return typeof slug === "string" && isValidSiteSlug(slug) ? slug : null;
}

/** `/api/cms/:site/<path>`. */
export function cmsUrl(site: string, path: string): string {
  return `/api/cms/${encodeURIComponent(site)}/${path}`;
}

/** The content-protocol endpoint of one draft (absolute, for the client). */
export function cmsDraftRpcEndpoint(site: string, draft: string): string {
  return new URL(
    cmsUrl(site, `drafts/${encodeURIComponent(draft)}/rpc`),
    window.location.origin,
  ).href;
}

/** A refused CMS request, with the API's `code` (`production_moved`, …). */
export class CmsRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "CmsRequestError";
  }
}

/** The JSON answer, or a {@link CmsRequestError} carrying its `code`. */
export async function cmsJson<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    code?: unknown;
  };
  if (!res.ok) {
    const code = typeof json.code === "string" ? json.code : null;
    const message =
      typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    throw new CmsRequestError(message, res.status, code);
  }
  return json as T;
}

/** A draft as the CMS answers it (contract §4.4). */
export interface CmsDraft {
  name: string;
  slug: string;
  createdBy: string;
  via: string;
  createdAt: string;
  /** The draft object's bare ETag. */
  etag: string | null;
  /** `delivery.decocms.com/sites/<site>/drafts/<slug>.json@<etag>`. */
  pointer: string | null;
  previewUrl: string | null;
}

/**
 * Opens the editor's draft: `POST /drafts {name}` creates it when absent
 * (insert-if-absent, so two tabs share one) and answers it either way.
 */
export async function ensureCmsDraft(
  site: string,
  name: string,
): Promise<CmsDraft> {
  return cmsJson<CmsDraft>(
    await fetch(cmsUrl(site, "drafts"), {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
}

/**
 * A block's version on the hosted CMS, as the server computes it: the first
 * 16 bytes of `sha256(canonicalJson(block))`, 22 characters of base64url.
 * A copy of `@decocms/blocks/protocol`'s `blockVersion` until a release
 * carries it (contract §1.3, known deviation; see `apps/api/src/hosted/block-version.ts`).
 */
export async function cmsBlockVersion(block: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(block)),
  );
  const bytes = new Uint8Array(digest).subarray(0, 16);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
