import type { QueryClient } from "@tanstack/react-query";

/**
 * The editor's bookkeeping of what it last read or wrote of a project's
 * content (the revision, `KEYS.contentRevision`, the per-block versions,
 * `KEYS.contentVersions`, and the changes, `KEYS.contentChanges`, whose
 * versions guard a hosted save) is set directly and often not watched by a
 * hook, so the cache would drop it 5 minutes after it was made (`gcTime`).
 * The next guarded write would then find no version and stop with "This
 * changed while you were editing" though nothing changed. It is kept as long
 * as the page is open.
 */
export function keepContentBookkeeping(queryClient: QueryClient) {
  for (const prefix of [
    "content-revision",
    "content-versions",
    "content-changes",
  ]) {
    if (queryClient.getQueryDefaults([prefix]).gcTime !== Infinity) {
      queryClient.setQueryDefaults([prefix], { gcTime: Infinity });
    }
  }
}
