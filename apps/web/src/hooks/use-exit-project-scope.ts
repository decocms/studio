/**
 * Leaving a project preserves the corresponding organization destination.
 *
 * Every destination exists on both sides of the scope now (see
 * `use-destination-route.ts`), so the only relocation left is the one the
 * ROUTE forces: a path carrying `$agentId` cannot be viewed unscoped, so
 * clearing the scope has to navigate off it.
 */
import { useProjectScope } from "@/hooks/use-project-scope";
import { useRouteAgentId } from "@/layouts/thread-route";
import { track } from "@/lib/posthog-client";

export function useExitProjectScope(): () => void {
  const { setScope } = useProjectScope();
  const routeAgentId = useRouteAgentId();
  return () => {
    const reason = routeAgentId !== undefined ? "route_resolves_scope" : null;
    track("scope_cleared", { relocated: reason !== null, reason });
    setScope(null);
  };
}
