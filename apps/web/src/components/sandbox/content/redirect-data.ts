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
 *
 * Next-major Blocks also reads a flat shape, the built-in `redirect`:
 *
 *   { "__resolveType": "redirect", from, to, permanent, status?, discardQueryParameters? }
 *
 * where `status` (301/302/307/308) wins over `permanent` (301, else 302). An
 * entry keeps the shape it was read in; new redirects use the nested shape,
 * which every site understands.
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

/** The next-major built-in, stored flat. */
const FLAT_REDIRECT_RESOLVE_TYPE = "redirect";

export const REDIRECT_STATUS_CODES = [301, 302, 307, 308] as const;
export type RedirectStatusCode = (typeof REDIRECT_STATUS_CODES)[number];

export type RedirectType = "temporary" | "permanent";

/** HTTP status the deco redirect handler emits for each type. */
export const REDIRECT_STATUS: Record<RedirectType, number> = {
  temporary: 307,
  permanent: 301,
};

export interface RedirectPayload {
  from: string;
  to: string;
  type: RedirectType;
  discardQueryParameters: boolean;
  /** Stored in the flat (`redirect`) shape; absent for the nested one. */
  flat?: true;
  /** Flat shape only: an explicit status, which wins over `type`. */
  status?: RedirectStatusCode;
}

export interface RedirectEntry extends RedirectPayload {
  key: string;
}

/** The status code a redirect answers with. A flat temporary one is a 302. */
export function redirectStatus(payload: RedirectPayload): number {
  if (!payload.flat) return REDIRECT_STATUS[payload.type];
  return payload.status ?? (payload.type === "permanent" ? 301 : 302);
}

const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
const asType = (v: unknown): RedirectType =>
  v === "permanent" ? "permanent" : "temporary";

const asStatus = (v: unknown): RedirectStatusCode | undefined =>
  REDIRECT_STATUS_CODES.find((code) => code === v);

/** A flat `redirect` block, defensively narrowed. */
function readFlatRedirect(block: Record<string, unknown>): RedirectPayload {
  const status = asStatus(block.status);
  return {
    from: asStr(block.from),
    to: asStr(block.to),
    type: block.permanent === true ? "permanent" : "temporary",
    discardQueryParameters: block.discardQueryParameters === true,
    flat: true,
    ...(status ? { status } : {}),
  };
}

/** The `redirect` sub-object of a redirect block, defensively narrowed. */
function readRedirect(
  block: Record<string, unknown> | undefined,
): RedirectPayload {
  if (block?.__resolveType === FLAT_REDIRECT_RESOLVE_TYPE) {
    return readFlatRedirect(block);
  }
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
    if (
      obj.__resolveType !== REDIRECT_RESOLVE_TYPE &&
      obj.__resolveType !== FLAT_REDIRECT_RESOLVE_TYPE
    ) {
      continue;
    }
    out.push({ key, ...readRedirect(obj) });
  }
  return out;
}

/** Editable payload for a single redirect block (empty defaults when missing). */
export function getRedirectPayload(
  block: Record<string, unknown> | undefined,
): RedirectPayload {
  return readRedirect(block);
}

/**
 * Build the decofile block for a redirect. Omits falsy optional fields. A flat
 * block keeps the fields of `base` (the stored block) the editor doesn't know.
 */
export function buildRedirectBlock(
  payload: RedirectPayload,
  base?: Record<string, unknown>,
): Record<string, unknown> {
  if (payload.flat) {
    const {
      status: _status,
      discardQueryParameters: _discard,
      ...kept
    } = base ?? {};
    return {
      ...kept,
      __resolveType: FLAT_REDIRECT_RESOLVE_TYPE,
      from: payload.from,
      to: payload.to,
      permanent: payload.type === "permanent",
      ...(payload.status ? { status: payload.status } : {}),
      ...(payload.discardQueryParameters
        ? { discardQueryParameters: true }
        : {}),
    };
  }
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
