import {
  hasManifestBlockSchema,
  type LiveMeta,
} from "@/components/sections-editor/resolve-schema";

/** How often the CMS re-reads `/live/_meta` while an app's schema is missing. */
export const SCHEMA_POLL_INTERVAL_MS = 2_000;

/**
 * How long to wait before re-reading the schema, or `false` when there is
 * nothing to wait for.
 *
 * The only stop condition is the schema arriving: a just-installed app has
 * none until the dev server restarts and regenerates it, and how long that
 * takes is a cold Deno boot, not a number anyone can pick. What bounds this is
 * the caller — the query is gated on the dev server being up, it never polls a
 * hidden tab, and the app has to stay selected. The budget it replaces was
 * counted off the query's `dataUpdateCount`, which is cumulative over its whole
 * lifetime: in a long editing session it was spent before the install even
 * happened, so the poll never ran at all.
 */
export function liveMetaSchemaPollInterval(input: {
  resolveType: string | undefined;
  meta: LiveMeta | undefined;
}): number | false {
  const { resolveType, meta } = input;
  if (typeof resolveType !== "string") return false;
  // Arrived means the manifest carries the block — not that some form
  // rendered. A block the manifest has no entry for resolves against the
  // site-wide schema, so "there are fields to edit" is true of the wrong form
  // and would stop the poll on it. An app that IS in the manifest and has
  // nothing to configure is done too: re-reading will not grow it fields.
  if (meta && hasManifestBlockSchema(resolveType, meta)) return false;
  return SCHEMA_POLL_INTERVAL_MS;
}
