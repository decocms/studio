import { BLOCKS_V8_METADATA_KEY } from "@decocms/shared/blocks-major";
import { DECO_ANALYTICS_METADATA_KEY } from "@decocms/shared/deco-analytics";

/**
 * Metadata keys only the server writes. A client write (the settings form,
 * an agent's tool call) can neither set nor clobber them.
 * - `sandboxMap`: the per-user sandbox handles.
 * - `blocksV8`: the "Blocks v8 site" switch, which an org admin flips with
 *   the update tool's `blocksV8` field (tools/virtual/blocks-v8-switch.ts).
 * - `decoAnalytics`: a site deco doesn't host's analytics registration; a
 *   client that could rewrite its id could read another site's traffic.
 */
const SERVER_MANAGED_KEYS = [
  "sandboxMap",
  BLOCKS_V8_METADATA_KEY,
  DECO_ANALYTICS_METADATA_KEY,
] as const;

type ServerManagedKey = (typeof SERVER_MANAGED_KEYS)[number];

export function stripServerManagedMetadata<T extends Record<string, unknown>>(
  metadata: T | null | undefined,
): Omit<T, ServerManagedKey> | null | undefined {
  if (!metadata) return metadata;
  const sanitized: Record<string, unknown> = { ...metadata };
  for (const key of SERVER_MANAGED_KEYS) delete sanitized[key];
  return sanitized as Omit<T, ServerManagedKey>;
}

/**
 * What survives a client clearing the project's metadata (`metadata: null`):
 * the server-managed keys plus the immutable site slug. Null when there is
 * nothing to keep.
 */
export function metadataKeptOnClear(
  existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!existing) return null;
  const kept: Record<string, unknown> = {};
  for (const key of [...SERVER_MANAGED_KEYS, "siteSlug"]) {
    if (existing[key]) kept[key] = existing[key];
  }
  return Object.keys(kept).length > 0 ? kept : null;
}
