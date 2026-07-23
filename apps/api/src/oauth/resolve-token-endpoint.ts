/**
 * Resolve Origin Token Endpoint
 *
 * When OAuth tokens are exchanged through the proxy, the stored tokenEndpoint
 * points to the proxy URL (e.g., /oauth-proxy/:connectionId/token).
 * For server-side token refresh, we need the origin's actual token endpoint
 * to avoid a self-referential call through the proxy.
 */

import {
  fetchProtectedResourceMetadata,
  fetchAuthorizationServerMetadata,
} from "../api/routes/oauth-proxy";

/**
 * Resolve the origin's actual OAuth token endpoint from a connection URL.
 *
 * Discovery flow:
 * 1. Fetch Protected Resource Metadata to find authorization_servers
 * 2. Fall back to origin root if metadata unavailable
 * 3. Fetch Authorization Server Metadata to find token_endpoint
 *
 * @param connectionUrl - The origin MCP server URL
 * @returns The origin's token endpoint URL, or null if discovery fails
 */
export async function resolveOriginTokenEndpoint(
  connectionUrl: string,
): Promise<string | null> {
  try {
    let authServerUrl: string | undefined;

    try {
      const resourceRes = await fetchProtectedResourceMetadata(connectionUrl);
      if (resourceRes.ok) {
        const data = (await resourceRes.json()) as {
          authorization_servers?: string[];
        };
        authServerUrl = data.authorization_servers?.[0];
      }
    } catch {
      // Protected resource metadata not available, fall through
    }

    // Fall back to origin root (many servers expose auth metadata there)
    if (!authServerUrl) {
      authServerUrl = new URL(connectionUrl).origin;
    }

    const authRes = await fetchAuthorizationServerMetadata(authServerUrl);
    if (authRes.ok) {
      const data = (await authRes.json()) as {
        token_endpoint?: string;
      };
      return data.token_endpoint ?? null;
    }

    return null;
  } catch {
    return null;
  }
}
