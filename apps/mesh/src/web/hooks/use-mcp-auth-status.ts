import {
  isConnectionAuthenticated,
  type McpAuthStatus,
} from "@/web/lib/mcp-oauth";
import { KEYS } from "@/web/lib/query-keys";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useSuspenseQuery } from "@tanstack/react-query";

/**
 * Hook to check MCP authentication status
 * Uses Suspense for loading states - wrap components in <Suspense> and <ErrorBoundary>.
 * @param connectionId - Connection ID
 * @returns McpAuthStatus - authentication status including OAuth support info
 */
export function useMCPAuthStatus({
  connectionId,
}: {
  connectionId: string;
}): McpAuthStatus {
  const { org } = useProjectContext();
  const mcpProxyUrl = new URL(
    `/api/${org.slug}/mcp/${connectionId}`,
    window.location.origin,
  );
  const { data: authStatus } = useSuspenseQuery({
    queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
    queryFn: () =>
      isConnectionAuthenticated({
        url: mcpProxyUrl.href,
        token: null,
        orgId: org.id,
      }),
  });

  return authStatus;
}
