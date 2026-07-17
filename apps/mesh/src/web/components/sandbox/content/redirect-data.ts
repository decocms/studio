/**
 * Pure helpers for the Content tab "Redirects" collection.
 *
 * A deco site stores each URL redirect as a standalone top-level decofile
 * block of `__resolveType` `website/loaders/redirect.ts`, shaped as:
 *
 *   { "redirect": { from, to, type, discardQueryParameters }, "__resolveType": "…redirect.ts" }
 *
 * The site's routes include an inline `website/loaders/redirects.ts` (plural)
 * that auto-discovers ALL such blocks via `resolveTypeSelector`, so CRUD here
 * is just create/update/delete of these blocks — no routes/site wiring needed.
 */

export const REDIRECT_RESOLVE_TYPE = "website/loaders/redirect.ts";

/**
 * Both redirect loader resolveTypes (the per-redirect block and the plural
 * aggregator). Redirects have a dedicated collection, so these are excluded
 * from the generic Loaders catalog to avoid double-listing the same blocks.
 */
export const REDIRECT_LOADER_RESOLVE_TYPES: ReadonlySet<string> = new Set([
  REDIRECT_RESOLVE_TYPE,
  "website/loaders/redirects.ts",
]);

export type RedirectType = "temporary" | "permanent";

/** HTTP status the deco redirect handler emits for each type. */
export const REDIRECT_STATUS: Record<RedirectType, number> = {
  temporary: 307,
  permanent: 301,
};

export interface RedirectEntry {
  key: string;
  from: string;
  to: string;
  type: RedirectType;
  discardQueryParameters: boolean;
}

export interface RedirectPayload {
  from: string;
  to: string;
  type: RedirectType;
  discardQueryParameters: boolean;
}

const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
const asType = (v: unknown): RedirectType =>
  v === "permanent" ? "permanent" : "temporary";

/** The `redirect` sub-object of a redirect block, defensively narrowed. */
function readRedirect(
  block: Record<string, unknown> | undefined,
): RedirectPayload {
  const raw =
    block &&
    typeof block.redirect === "object" &&
    block.redirect !== null &&
    !Array.isArray(block.redirect)
      ? (block.redirect as Record<string, unknown>)
      : {};
  return {
    from: asStr(raw.from),
    to: asStr(raw.to),
    type: asType(raw.type),
    discardQueryParameters: raw.discardQueryParameters === true,
  };
}

/** Every redirect block in the decofile, most-specific fields narrowed. */
export function extractRedirects(
  decofile: Record<string, unknown>,
): RedirectEntry[] {
  const out: RedirectEntry[] = [];
  for (const [key, val] of Object.entries(decofile)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const obj = val as Record<string, unknown>;
    if (obj.__resolveType !== REDIRECT_RESOLVE_TYPE) continue;
    const { from, to, type, discardQueryParameters } = readRedirect(obj);
    out.push({ key, from, to, type, discardQueryParameters });
  }
  return out;
}

/** Editable payload for a single redirect block (empty defaults when missing). */
export function getRedirectPayload(
  block: Record<string, unknown> | undefined,
): RedirectPayload {
  return readRedirect(block);
}

/** Build the decofile block for a redirect. Omits falsy optional fields. */
export function buildRedirectBlock(
  payload: RedirectPayload,
): Record<string, unknown> {
  const redirect: Record<string, unknown> = {
    from: payload.from,
    to: payload.to,
    type: payload.type,
  };
  if (payload.discardQueryParameters) redirect.discardQueryParameters = true;
  return { redirect, __resolveType: REDIRECT_RESOLVE_TYPE };
}

/** A URL-safe slug derived from the redirect's `from` path (for the block key). */
function slugifyFrom(from: string): string {
  const path = (from.split(/[?#]/)[0] ?? "").replace(/^\/+/, "");
  const slug = path
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "redirect";
}

const MAX_UNIQUE_KEY_ATTEMPTS = 1000;

/** Fresh `redirects-<slug>-<uuid>` key not colliding with an existing block. */
export function generateRedirectBlockKey(
  decofile: Record<string, unknown>,
  from: string,
): string {
  const slug = slugifyFrom(from);
  for (let i = 0; i < MAX_UNIQUE_KEY_ATTEMPTS; i++) {
    const key = `redirects-${slug}-${crypto.randomUUID()}`;
    if (!Object.hasOwn(decofile, key)) return key;
  }
  throw new Error("Could not generate a unique redirect block key");
}
