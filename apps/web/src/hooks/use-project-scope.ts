/** The active project scope. A project is a FILTER, not a container: picking
 *  one narrows the destinations that say they narrow, and is ignored by the
 *  rest.
 *
 *  ONE CARRIER: `?virtualmcpid=`, and nothing else. It has to mean the same on
 *  Tasks and Library, which have no path segment to hold it — which is why the
 *  agents route gave its `{-$project}` segment up rather than the reverse.
 *
 *  Never auto-selected — a scope nobody chose silently shortens lists, which is
 *  what this param did before only two routes resolved it. */

import { useNavigate, useSearch } from "@tanstack/react-router";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import {
  isDecopilot,
  isStudioPackAgent,
  useVirtualMCPNonBlocking,
  useVirtualMCPsNonBlocking,
} from "@/sdk";
import { getDevAgentIds } from "@/lib/agent-capabilities";
import { resolveGithubAttachment } from "@/lib/github-repo";

/** The control renders from the FIRST project: with one there is nothing to
 *  switch between, but its workspace still has to be reachable. Gating this at
 *  two stranded single-project orgs with no route to Preview, Code or Content
 *  once they navigated away. */
export const MIN_PROJECTS_FOR_SWITCHER = 1;

/**
 * The projects a person can scope to: their own, minus the plumbing.
 *
 * Decopilot is the org-wide default rather than a project; Studio Pack agents
 * are code-owned scaffolding; dev agents are reached through the Develop/Live
 * toggle on their live counterpart, never as standalone entries.
 */
export function scopableProjects(
  all: VirtualMCPEntity[] | null | undefined,
): VirtualMCPEntity[] {
  const projects = all ?? [];
  const devIds = getDevAgentIds(projects);
  return projects.filter(
    (project) =>
      !devIds.has(project.id) &&
      !isDecopilot(project.id) &&
      !isStudioPackAgent(project.id),
  );
}

/** `owner/name` for a project, or null when it has no repository attached. */
export function projectRepo(
  project: VirtualMCPEntity | null | undefined,
): string | null {
  const attachment = resolveGithubAttachment(project);
  if (attachment.status === "none") return null;
  return `${attachment.repo.owner}/${attachment.repo.name}`;
}

export interface ProjectScope {
  /** The scoped project's id, or null for "All projects". */
  scopeId: string | null;
  /** The scoped project, when it is present in the (non-blocking) list. */
  project: VirtualMCPEntity | null;
  /** `owner/name` of the scoped project, or null — the board's filter key. */
  repo: string | null;
  /** Every project the picker offers. */
  projects: VirtualMCPEntity[];
  /** Whether to render the project switcher at all. */
  hasProjects: boolean;
  setScope: (id: string | null) => void;
}

/** The scoped project's id, straight off the URL.
 *
 *  Split out of {@link useProjectScope} because that one also lists the org's
 *  projects to resolve the id into an entity. A caller that only needs to know
 *  WHETHER a project is selected should not subscribe to a query to find out —
 *  the sidebar's destination rows in particular promise to paint on the first
 *  frame without reading data. */
export function useScopeId(): string | null {
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  return search.virtualmcpid ?? null;
}

export function useProjectScope(): ProjectScope {
  const navigate = useNavigate();
  const all = useVirtualMCPsNonBlocking();

  const projects = scopableProjects(all);
  const scopeId = useScopeId();
  const listed = projects.find((p) => p.id === scopeId) ?? null;
  /** The list is ONE page (100 rows). The picker searches server-side, so a
   *  scope BEYOND that page is reachable — and resolving it to `null` dropped
   *  the project's own nav rows and the board's repo filter while the URL still
   *  said it was scoped. Read that one row by id instead: same cache, no
   *  pagination, and only once the list has resolved without it. */
  const unlisted = useVirtualMCPNonBlocking(
    scopeId && all.length > 0 && !all.some((p) => p.id === scopeId)
      ? scopeId
      : null,
  );
  /** Filtered the same way the list is, so the plumbing a picker never offers
   *  cannot become a scope by being fetched directly. */
  const project =
    listed ?? scopableProjects(unlisted ? [unlisted] : [])[0] ?? null;

  const setScope = (id: string | null) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        virtualmcpid: id ?? undefined,
      }),
    });

  return {
    scopeId,
    project,
    repo: projectRepo(project),
    projects,
    hasProjects: projects.length >= MIN_PROJECTS_FOR_SWITCHER,
    setScope,
  };
}
