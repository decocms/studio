/**
 * The React front door to {@link buildProjectIndex} — the Tasks board's one
 * list of work buckets, shared by the board, the org home's feed and the
 * sidebar's task groups.
 *
 * Taking `tasks` as an argument rather than reading the board itself is what
 * makes it ONE index: every caller passes the same array from
 * `KEYS.taskBoardItems(locator)`, so a card is attributed identically wherever
 * it is rendered. It also keeps the index CLOSED over the cards it will be
 * asked about — a repository nothing declares still gets a bucket because a
 * card carries it.
 *
 * Non-blocking on purpose. The sidebar paints before any fetch resolves and
 * must not gain a suspending read; `useVirtualMCPsNonBlocking` answers `[]`
 * until the list lands, which is exactly the case
 * {@link taskMatchesProjectFilter}'s unresolved-id branch exists for.
 *
 * KNOWN LIMIT: that read is one page (100 projects). Past it a real project is
 * absent from the index and its cards fall back to a repository-titled bucket —
 * degraded, never dropped. `useProjectScope` carries a single-row fallback for
 * the SCOPED project (`unlisted`); widening that to the whole index means
 * paging, which is a separate change.
 */

import { useVirtualMCPsNonBlocking } from "@/sdk";
import {
  buildProjectIndex,
  type ProjectIndex,
  type AttributableTask,
} from "@/lib/project-index";
import { scopableProjects } from "./use-project-scope";

/**
 * Module-level so the default is a stable reference.
 *
 * An array literal in a default parameter, and a hook called in argument
 * position, each make the React Compiler bail out of memoizing this hook
 * entirely — and a fresh `ProjectIndex` identity every render invalidates every
 * downstream scope keyed on it (`TaskFiltersBar`'s guard is `$[2] !== index`).
 * Both are avoided here deliberately; `useMemo` is banned in this repo.
 */
const NO_EXTRA_REPOS: readonly string[] = [];

/** For callers that only need the option set, never attribution. */
export const NO_TASKS: readonly AttributableTask[] = [];

export function useProjectIndex(
  tasks: readonly AttributableTask[],
  extraRepos: readonly string[] = NO_EXTRA_REPOS,
): ProjectIndex {
  const all = useVirtualMCPsNonBlocking();
  const projects = scopableProjects(all);
  return buildProjectIndex(projects, [
    ...tasks.map((task) => task.repo),
    ...extraRepos,
  ]);
}
