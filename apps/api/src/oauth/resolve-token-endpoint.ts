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
import { guardAgainstPrivateUrl } from "../mcp-clients/url-security";

/**
 * An unread response body keeps its connection out of the fetch keep-alive
 * pool. Both metadata probes below are discarded on a non-ok response
 * without ever being read, so drain them explicitly.
 */
async function drainBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore — best-effort drain
  }
}

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
          authorization_servers?: unknown;
        };
        const candidate = Array.isArray(data.authorization_servers)
          ? data.authorization_servers[0]
          : undefined;
        // authorization_servers is untrusted origin JSON — verify the shape.
        if (typeof candidate === "string") authServerUrl = candidate;
      } else {
        await drainBody(resourceRes);
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
        token_endpoint?: unknown;
      };
      // token_endpoint is untrusted, origin-controlled input — reject a private/internal target, resolving DNS so a rebinding domain doesn't slip past.
      if (typeof data.token_endpoint === "string") {
        try {
          const parsed = new URL(data.token_endpoint);
          if (
            (parsed.protocol === "http:" || parsed.protocol === "https:") &&
            !(await guardAgainstPrivateUrl(data.token_endpoint))
          ) {
            return data.token_endpoint;
          }
        } catch {
          // not a valid URL — fall through to null
        }
      }
    } else {
      await drainBody(authRes);
    }

    return null;
  } catch {
    return null;
  }
}
