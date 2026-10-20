/**
 * Viewing another tenant's board WITHOUT leaving your own org.
 *
 * The pick lands in `?boardOrg=<slug>` and this provider re-points the board's
 * `ProjectContext` at that org — nothing else. Every board read and write
 * already addresses `/api/<org.slug>/tools/...` and keys its cache off
 * `locator`, so swapping the org here moves the whole board at once, while the
 * URL, the sidebar, the chat and every other surface stay where they were.
 * `resolve-org-from-path` is what actually admits (and audits) the call.
 *
 * ponytail: no board-wide `org` prop, no second board component — the context
 * the board already reads IS the knob.
 */

import { ProjectContextProvider, useProjectContext } from "@/sdk";
import { useTaskBoardAdminOrgs } from "@/hooks/use-task-board-analytics";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useParams, useSearch } from "@tanstack/react-router";
import type { PropsWithChildren } from "react";

/**
 * The `?boardOrg=` slug, or null when it names this org (or nothing).
 *
 * Compared against the org in the PATH, not `ProjectContext` — inside the
 * provider below the context org already IS the boardOrg, so comparing there
 * would read "not viewing anyone else" the moment it became true.
 */
export function useBoardOrgSlug(): string | null {
  const pathOrg = useParams({ strict: false }).org;
  const { boardOrg } = useSearch({ strict: false }) as { boardOrg?: string };
  return boardOrg && boardOrg !== pathOrg ? boardOrg : null;
}

export function BoardOrgProvider({ children }: PropsWithChildren) {
  const { project } = useProjectContext();
  const slug = useBoardOrgSlug();
  const { data, isLoading } = useTaskBoardAdminOrgs();

  if (!slug) return children;
  // Wait rather than paint your own board first: a swap after the fact would
  // fire a full board read against the wrong org and flash the wrong cards.
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }
  // Fails closed: a slug the server did not list (bogus, or the caller is not
  // an admin) is ignored, not trusted.
  const target = data?.orgs.find((o) => o.slug === slug);
  if (!target) return children;

  return (
    <ProjectContextProvider
      org={{ id: target.id, name: target.name, slug: target.slug, logo: null }}
      project={project}
    >
      {children}
    </ProjectContextProvider>
  );
}
