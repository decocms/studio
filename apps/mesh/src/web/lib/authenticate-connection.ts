import { authenticateMcp } from "@/web/lib/mcp-oauth";
import { KEYS } from "@/web/lib/query-keys";
import type { QueryClient } from "@tanstack/react-query";
import type { useConnectionActions } from "@decocms/mesh-sdk";
import { toast } from "sonner";

/**
 * Runs the full OAuth authentication flow for an MCP connection:
 * 1. Opens the OAuth popup via authenticateMcp()
 * 2. Saves the token via the OAuth endpoint (or falls back to connection_token)
 * 3. Invalidates auth-related queries so the UI refreshes
 *
 * Returns true on success, false on failure.
 */
export async function authenticateConnection(
  connectionId: string,
  connectionActions: ReturnType<typeof useConnectionActions>,
  queryClient: QueryClient,
): Promise<boolean> {
  const { token, tokenInfo, error } = await authenticateMcp({ connectionId });

  if (error || !token) {
    toast.error(`Authentication failed: ${error || "No token received"}`);
    return false;
  }

  if (tokenInfo) {
    try {
      const response = await fetch(
        `/api/connections/${connectionId}/oauth-token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            accessToken: tokenInfo.accessToken,
            refreshToken: tokenInfo.refreshToken,
            expiresIn: tokenInfo.expiresIn,
            scope: tokenInfo.scope,
            clientId: tokenInfo.clientId,
            clientSecret: tokenInfo.clientSecret,
            tokenEndpoint: tokenInfo.tokenEndpoint,
          }),
        },
      );
      if (!response.ok) {
        console.error("Failed to save OAuth token:", await response.text());
        await connectionActions.update.mutateAsync({
          id: connectionId,
          data: { connection_token: token },
        });
      } else {
        try {
          await connectionActions.update.mutateAsync({
            id: connectionId,
            data: {},
          });
        } catch (err) {
          console.warn("Failed to refresh connection tools after OAuth:", err);
        }
      }
    } catch (err) {
      console.error("Error saving OAuth token:", err);
      await connectionActions.update.mutateAsync({
        id: connectionId,
        data: { connection_token: token },
      });
    }
  } else {
    await connectionActions.update.mutateAsync({
      id: connectionId,
      data: { connection_token: token },
    });
  }

  const mcpProxyUrl = new URL(`/mcp/${connectionId}`, window.location.origin);
  await queryClient.invalidateQueries({
    queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
  });

  return true;
}
