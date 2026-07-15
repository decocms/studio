/**
 * Shared utilities for the `studio-storage://` URI scheme.
 *
 * All code that produces or consumes studio-storage URIs should import from
 * here so the scheme string stays in one place and the parse/build logic is
 * consistent.
 *
 * The legacy `mesh-storage://` scheme is accepted forever on the read path:
 * these URIs are persisted in DB message parts and annotation text, so old
 * threads must keep resolving. Writers only ever emit `studio-storage://`.
 */

/** URI scheme prefix for stable object-storage references. */
const STUDIO_STORAGE_SCHEME = "studio-storage://";

/** Legacy scheme still present in persisted messages — read-only, never emitted. */
const LEGACY_MESH_STORAGE_SCHEME = "mesh-storage://";

/** Wrap a storage key in the stable URI scheme. */
export function toStudioStorageUri(key: string): string {
  return `${STUDIO_STORAGE_SCHEME}${key}`;
}

/**
 * Extract the storage key from a `studio-storage://` (or legacy
 * `mesh-storage://`) URI. Returns null for any other URI scheme.
 */
export function parseStudioStorageKey(uri: string): string | null {
  if (uri.startsWith(STUDIO_STORAGE_SCHEME)) {
    return uri.slice(STUDIO_STORAGE_SCHEME.length);
  }
  if (uri.startsWith(LEGACY_MESH_STORAGE_SCHEME)) {
    return uri.slice(LEGACY_MESH_STORAGE_SCHEME.length);
  }
  return null;
}

/**
 * Returns a fresh RegExp that matches `studio-storage://` (and legacy
 * `mesh-storage://`) URIs and captures the key. Group 1 = storage key.
 *
 * A factory is used (rather than a shared instance) because RegExp with the `g`
 * flag is stateful — callers using matchAll() or replace() need their own copy.
 */
export function studioStorageRegex(): RegExp {
  return /(?:studio|mesh)-storage:\/\/([^\s"'<>[\]]+)/g;
}
