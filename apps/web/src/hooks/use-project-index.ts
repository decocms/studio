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
 */

import { useVirtualMCPsNonBlocking } from "@/sdk";
import {
  buildProjectIndex,
  type ProjectIndex,
  type AttributableTask,
} from "@/lib/project-index";
import { scopableProjects } from "./use-project-scope";

export function useProjectIndex(
  tasks: readonly AttributableTask[],
  extraRepos: readonly string[] = [],
): ProjectIndex {
  const projects = scopableProjects(useVirtualMCPsNonBlocking());
  return buildProjectIndex(projects, [
    ...tasks.map((task) => task.repo),
    ...extraRepos,
  ]);
}
