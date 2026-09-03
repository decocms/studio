/** Leave an agent-owned workspace for the organization Home route. */

import { useProjectScope } from "@/hooks/use-project-scope";
import { track } from "@/lib/posthog-client";

export function useExitProjectScope(): () => void {
  const { setScope } = useProjectScope();

  return () => {
    track("scope_cleared", {
      relocated: true,
      reason: "agent_workspace_exit",
    });
    setScope(null);
  };
}
