/**
 * A project's metadata without the keys only the server writes, for a client
 * that sends back the metadata it read: `sandboxMap` (the per-user sandbox
 * handles) and `blocksV8` (the "Blocks v8 site" switch, which only an org
 * admin flips, with its own field; the server refuses a metadata write that
 * would change it, so a stale copy must never travel).
 */
export function omitServerManagedMetadata<T extends Record<string, unknown>>(
  metadata: T,
): T {
  const sanitized = { ...metadata };
  delete sanitized.sandboxMap;
  delete sanitized.blocksV8;
  return sanitized as T;
}
