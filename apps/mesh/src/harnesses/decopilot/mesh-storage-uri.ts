/**
 * Shared utilities for the `mesh-storage://` URI scheme.
 *
 * All code that produces or consumes mesh-storage URIs should import from here
 * so the scheme string stays in one place and the parse/build logic is consistent.
 */

/** URI scheme prefix for stable object-storage references. */
const MESH_STORAGE_SCHEME = "mesh-storage://";

/** Wrap a storage key in the stable URI scheme. */
export function toMeshStorageUri(key: string): string {
  return `${MESH_STORAGE_SCHEME}${key}`;
}

/**
 * Extract the storage key from a `mesh-storage://` URI.
 * Returns null for any other URI scheme.
 */
export function parseMeshStorageKey(uri: string): string | null {
  if (!uri.startsWith(MESH_STORAGE_SCHEME)) return null;
  return uri.slice(MESH_STORAGE_SCHEME.length);
}

/**
 * Returns a fresh RegExp that matches `mesh-storage://` URIs and captures the key.
 * Group 1 = storage key.
 *
 * A factory is used (rather than a shared instance) because RegExp with the `g`
 * flag is stateful — callers using matchAll() or replace() need their own copy.
 */
export function meshStorageRegex(): RegExp {
  return /mesh-storage:\/\/([^\s"'<>[\]]+)/g;
}
