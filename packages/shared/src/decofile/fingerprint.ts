import { sanitizeSecretsForPersistence } from "./secret";

/**
 * JSON text with object keys sorted at every depth. Everything else follows
 * `JSON.stringify` (undefined properties dropped, undefined array slots become
 * `null`), so a value and its JSON round trip serialize identically.
 */
/**
 * The reserved key a saved block's metadata lives under, next to
 * `__resolveType` (`@decocms/blocks` drops it when resolving):
 * `{ lastEditedBy: <Studio user id>, lastEditedAt: <ISO 8601> }`, stamped by
 * the site editor on every save. Never content: canonical JSON, fingerprints
 * and merges ignore it.
 */
export const BLOCK_META_KEY = "__meta";

export interface BlockMeta {
  lastEditedBy: string;
  lastEditedAt: string;
}

/** A block's `__meta`, when it is well-formed; `null` otherwise. */
export function blockMetaOf(value: unknown): BlockMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const meta = (value as Record<string, unknown>)[BLOCK_META_KEY];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const { lastEditedBy, lastEditedAt } = meta as Record<string, unknown>;
  return typeof lastEditedBy === "string" &&
    lastEditedBy.length > 0 &&
    typeof lastEditedAt === "string" &&
    Number.isFinite(Date.parse(lastEditedAt))
    ? { lastEditedBy, lastEditedAt }
    : null;
}

/**
 * The block as saved by `userId` at `at`: its `__meta` replaced with theirs.
 * Without a user, any earlier `__meta` is dropped rather than kept on a
 * change someone else didn't make. Anything but a plain object is returned
 * as is.
 */
export function stampBlockMeta(
  value: unknown,
  userId: string | null | undefined,
  at: string,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { [BLOCK_META_KEY]: _previous, ...content } = value as Record<
    string,
    unknown
  >;
  return userId
    ? {
        ...content,
        [BLOCK_META_KEY]: { lastEditedBy: userId, lastEditedAt: at },
      }
    : content;
}

export function canonicalBlockJson(value: unknown): string {
  return JSON.stringify(value, (key, v: unknown) => {
    // Who edited a block last is metadata, not content (see BLOCK_META_KEY):
    // two copies that differ only there are the same version.
    if (key === BLOCK_META_KEY) return undefined;
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) {
      sorted[key] = (v as Record<string, unknown>)[key];
    }
    return sorted;
  });
}

/**
 * Identifies a block's content, so a writer can say which version its edit was
 * made against. Editor and API must agree on it: both hash the persisted form
 * (secrets sanitized, keys sorted), whatever key order or transient secret
 * `value` the in-memory copy carries. Throws {@link PlaintextSecretError} for a
 * value that could never be persisted.
 */
export async function decoBlockFingerprint(value: unknown): Promise<string> {
  const text = canonicalBlockJson(sanitizeSecretsForPersistence(value));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
