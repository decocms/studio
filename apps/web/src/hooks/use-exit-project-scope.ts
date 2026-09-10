/** Leaving a project, for every control that offers it. Clearing
 *  `?virtualmcpid=` IS returning to the org, so the default un-narrows the page
 *  in place — scoped Tasks becomes the org's Tasks, not Home. Two pages cannot
 *  be kept and leave for Home instead: the routes that RESOLVE the scope, where
 *  the param IS the page's agent and dropping it silently re-points an open
 *  thread at the Super Agent (gated on `useRouteAgentId`, so it cannot drift
 *  from `resolveRouteAgentId`); and the project-only destinations, where
 *  un-narrowing lands on a page the org does not have — `routeExistsInScope`,
 *  shared with the sidebar rows rather than restated here. */

import { useNavigate } from "@tanstack/react-router";
import {
  DESTINATION_ROUTE,
  routeExistsInScope,
  useLeafRoutePath,
} from "@/hooks/use-destination-route";
import { useProjectScope } from "@/hooks/use-project-scope";
import { useRouteAgentId } from "@/layouts/thread-route";
import { track } from "@/lib/posthog-client";
import { useProjectContext } from "@/sdk";

export function useExitProjectScope(): () => void {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { setScope } = useProjectScope();
  const routeAgentId = useRouteAgentId();
  const leafPath = useLeafRoutePath();

  return () => {
    /** Why we left the page, not just that we did: with two reasons, a drop in
     *  `relocated` says nothing about which one moved. */
    const reason =
      routeAgentId !== undefined
        ? "route_resolves_scope"
        : routeExistsInScope(leafPath, null)
          ? null
          : "route_needs_scope";
    const relocated = reason !== null;
    track("scope_cleared", { relocated, reason });
    if (!relocated) {
      setScope(null);
      return;
    }
    navigate({
      to: DESTINATION_ROUTE.home,
      params: { org: org.slug },
      /** Explicit, never omitted: `retainSearchParams` re-adds a key the next
       *  search leaves out, so an omitted scope would come straight back. */
      search: { virtualmcpid: undefined },
    });
  };
}
