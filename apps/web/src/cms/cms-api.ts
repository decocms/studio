import { cmsRequestSignal } from "./request-deadline";
/**
 * The web editor's client for the hosted CMS on R2
 * (`/api/cms/:site/...`): the site-keyed routes that replace the v8 git
 * path's `/decofile/:virtualMcpId/:branch`. No GitHub on any of them.
 *
 * The site is the project's `metadata.siteSlug`; the path names no
 * organization (Studio finds the site's). The editor's draft is named after
 * its thread's branch, as today.
 */

import { z } from "zod";
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
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    if (res.ok) {
      throw new CmsRequestError(
        "The CMS returned invalid JSON",
        res.status,
        "invalid_response",
      );
    }
  }
  if (!res.ok) {
    const body = json !== null && typeof json === "object" ? json : {};
    const code =
      "code" in body && typeof body.code === "string" ? body.code : null;
    const message =
      "error" in body && typeof body.error === "string"
        ? body.error
        : `HTTP ${res.status}`;
    throw new CmsRequestError(message, res.status, code);
  }
  return json as T;
}

/** All hosted REST traffic shares credentials, freshness and error handling. */
export async function cmsRequest<T>(
  site: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  return cmsJson<T>(
    await fetch(cmsUrl(site, path), {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
      signal: cmsRequestSignal(init?.signal),
    }),
  );
}

const cmsPublicationSchema = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("published"),
    revision: z.string().min(1),
    previous: z.string().min(1).nullable(),
  }),
  z.object({
    result: z.literal("up-to-date"),
    revision: z.string().min(1).nullable(),
  }),
]);

/** Publish and rollback can acknowledge only an explicit, versioned result. */
export function parseCmsPublicationResult(value: unknown) {
  const answer = cmsPublicationSchema.safeParse(value);
  if (!answer.success) {
    throw new CmsRequestError(
      "The CMS returned an invalid publication response",
      200,
      "invalid_response",
    );
  }
  return answer.data;
}

/** A draft as the CMS answers it (contract §4.4). */
export interface CmsDraft {
  name: string;
  slug: string;
  createdBy: string;
  via: string;
  createdAt: string;
  /** The draft index's bare ETag (it moves only when the draft's names do). */
  etag: string | null;
  /** `delivery.decocms.com/sites/<site>/drafts/<slug>/index.json@<draftToken>` (the draft index; its version moves with every save). */
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
  return cmsRequest<CmsDraft>(site, "drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
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
