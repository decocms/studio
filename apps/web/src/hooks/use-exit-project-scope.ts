/** Leaving a project preserves the corresponding organization destination. */
import { useProjectScope } from "@/hooks/use-project-scope";
import {
  routeExistsInScope,
  useLeafRoutePath,
} from "@/hooks/use-destination-route";
import { useRouteAgentId } from "@/layouts/thread-route";
import { track } from "@/lib/posthog-client";

export function useExitProjectScope(): () => void {
  const { setScope } = useProjectScope();
  const routeAgentId = useRouteAgentId();
  const leafPath = useLeafRoutePath();
  return () => {
    const reason =
      routeAgentId !== undefined
        ? "route_resolves_scope"
        : routeExistsInScope(leafPath, null)
          ? null
          : "route_needs_scope";
    track("scope_cleared", { relocated: reason !== null, reason });
    setScope(null);
  };
}
