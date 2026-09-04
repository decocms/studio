/** The agent workspace selected by the canonical route. Identity belongs in
 * `/$org/projects/$agentId`; `?virtualmcpid=` is read only while a legacy URL is
 * settling its compatibility redirect. */

import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import {
  isDecopilot,
  isStudioPackAgent,
  useVirtualMCPNonBlockingState,
  useVirtualMCPsNonBlocking,
} from "@/sdk";
import { getDevAgentIds } from "@/lib/agent-capabilities";
import { projectRepo } from "@/lib/github-repo";

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

/** Resolve the entity named by the route without applying picker policy.
 *
 * Development projects stay out of {@link scopableProjects}, but their
 * canonical routes are reachable through the Develop/Live toggle. Route
 * identity therefore has to resolve independently from whether the entity is
 * offered as a picker destination. */
export function projectForScope(
  all: VirtualMCPEntity[] | null | undefined,
  scopeId: string | null,
  exact: VirtualMCPEntity | null,
): VirtualMCPEntity | null {
  if (!scopeId) return null;
  return (
    (all ?? []).find((project) => project.id === scopeId) ??
    (exact?.id === scopeId ? exact : null)
  );
}

export interface ProjectScope {
  /** The scoped project's id, or null for "All projects". */
  scopeId: string | null;
  /** The scoped project, resolved independently from picker eligibility. */
  project: VirtualMCPEntity | null;
  /** `owner/name` of the scoped project, or null — the board's filter key. */
  repo: string | null;
  /** Every project the picker offers. */
  projects: VirtualMCPEntity[];
  /** Whether to render the project switcher at all. */
  hasProjects: boolean;
  /** Whether the exact route entity is still resolving. */
  projectPending: boolean;
  setScope: (id: string | null) => void;
}

export function resolveProjectScopeId(input: {
  agentIdParam?: string;
  legacyVirtualMcpId?: string;
  legacyThreadRoute?: boolean;
}): string | null {
  const canonical = input.agentIdParam?.trim();
  if (canonical) return canonical;
  if (!input.legacyThreadRoute) return null;
  const legacy = input.legacyVirtualMcpId?.trim();
  return legacy || null;
}

/** The scoped project's id, straight off the URL.
 *
 *  Split out of {@link useProjectScope} because that one also lists the org's
 *  projects to resolve the id into an entity. A caller that only needs to know
 *  WHETHER a project is selected should not subscribe to a query to find out —
 *  the sidebar's destination rows in particular promise to paint on the first
 *  frame without reading data. */
export function useScopeId(): string | null {
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const legacyVirtualMcpId =
    "virtualmcpid" in search && typeof search.virtualmcpid === "string"
      ? search.virtualmcpid
      : undefined;
  return resolveProjectScopeId({
    agentIdParam: params.agentId,
    legacyVirtualMcpId,
    legacyThreadRoute: params.taskId !== undefined,
  });
}

export function useProjectScope(): ProjectScope {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const all = useVirtualMCPsNonBlocking();

  const projects = scopableProjects(all);
  const scopeId = useScopeId();
  /** The list is ONE page (100 rows). The picker searches server-side, so a
   *  scope BEYOND that page is reachable — and resolving it to `null` dropped
   *  the project's own nav rows while the URL still said it was scoped. Read
   *  that one row by id in parallel whenever the current page lacks it. */
  const unlisted = useVirtualMCPNonBlockingState(
    scopeId && !all.some((p) => p.id === scopeId) ? scopeId : null,
  );
  const project = projectForScope(all, scopeId, unlisted.item);

  const setScope = (id: string | null) => {
    const org = params.org ?? "";
    if (id) {
      navigate({
        to: "/$org/projects/$agentId",
        params: { org, agentId: id },
        search: { thread: undefined },
      });
      return;
    }
    navigate({
      to: "/$org/home",
      params: { org },
      search: { thread: undefined },
    });
  };

  return {
    scopeId,
    project,
    repo: projectRepo(project),
    projects,
    hasProjects: projects.length >= MIN_PROJECTS_FOR_SWITCHER,
    projectPending: project === null && unlisted.pending,
    setScope,
  };
}
