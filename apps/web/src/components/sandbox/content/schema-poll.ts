import {
  hasManifestBlockSchema,
  type LiveMeta,
} from "@/components/sections-editor/resolve-schema";

/** How often the CMS re-reads `/live/_meta` while an app's schema is missing. */
export const SCHEMA_POLL_INTERVAL_MS = 2_000;

/**
 * How many reads one wait is worth — ~90s at {@link SCHEMA_POLL_INTERVAL_MS},
 * which covers a cold Deno boot with room to spare. A budget is needed because
 * "the block is not in the manifest" is also the steady state of a block no
 * build will ever add (a site whose `site` block the manifest does not carry,
 * an app whose module was deleted), and the answering source may be the
 * committed `.deco/meta.gen.json` — a ~1 MB read through the proxy, every two
 * seconds, for as long as the tab stays open.
 */
export const SCHEMA_POLL_MAX_READS = 45;

/**
 * The open wait: which block it is for, and the query's read count when it
 * opened. Held by the caller across calls, since `refetchInterval` runs
 * outside render and has nowhere of its own to keep it.
 */
export interface SchemaPollWindow {
  resolveType: string;
  /** The query's cumulative read count at the moment the wait opened. */
  reads: number;
}

export interface SchemaPollDecision {
  /** What to hand back to `refetchInterval`. */
  interval: number | false;
  /** The wait to carry into the next call; `null` closes it. */
  window: SchemaPollWindow | null;
}

/**
 * How long to wait before re-reading the schema, or `false` when there is
 * nothing to wait for.
 *
 * The wait ends when the schema arrives, and failing that when the budget
 * does. The budget is a DELTA from when this block was selected, not the
 * query's own `dataUpdateCount`: that counter is cumulative over the query's
 * whole lifetime, so in a long editing session it was spent before the install
 * even happened and the poll never ran at all.
 *
 * Carries the wait in and out rather than holding it: the caller's ref is the
 * only thing that survives between two `refetchInterval` calls, and writing to
 * it from here would be a side effect in a function the tests call directly.
 */
export function liveMetaSchemaPollInterval(input: {
  resolveType: string | undefined;
  meta: LiveMeta | undefined;
  /** The query's cumulative read count (`dataUpdateCount + errorUpdateCount`). */
  reads: number;
  /** The wait the previous call left open, if any. */
  window: SchemaPollWindow | null;
}): SchemaPollDecision {
  const { resolveType, meta, reads, window } = input;
  if (typeof resolveType !== "string" || resolveType === "") {
    return { interval: false, window: null };
  }
  // Arrived means the manifest carries the block — not that some form
  // rendered. A block the manifest has no entry for resolves against the
  // site-wide schema, so "there are fields to edit" is true of the wrong form
  // and would stop the poll on it. An app that IS in the manifest and has
  // nothing to configure is done too: re-reading will not grow it fields.
  if (meta && hasManifestBlockSchema(resolveType, meta)) {
    return { interval: false, window: null };
  }
  if (!window || window.resolveType !== resolveType) {
    return {
      interval: SCHEMA_POLL_INTERVAL_MS,
      window: { resolveType, reads },
    };
  }
  if (reads - window.reads >= SCHEMA_POLL_MAX_READS) {
    return { interval: false, window };
  }
  return { interval: SCHEMA_POLL_INTERVAL_MS, window };
}
