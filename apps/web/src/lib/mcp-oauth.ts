/**
 * MCP OAuth Client Utilities
 *
 * Re-exported from @/sdk for backwards compatibility.
 * New code should import directly from @/sdk.
 */

import { signInFromSandbox } from "@/components/connections/sandbox-sign-in-dialog";
import { authenticateMcp as authenticateThroughProxy } from "@/sdk";

export {
  handleOAuthCallback,
  isConnectionAuthenticated,
  type McpOAuthProviderOptions,
  type OAuthTokenInfo,
  type AuthenticateMcpResult,
  type McpAuthStatus,
} from "@/sdk";

async function usesSandboxSignIn(orgSlug: string, connectionId: string) {
  const res = await fetch(
    `/api/${encodeURIComponent(orgSlug)}/connections/${connectionId}/oauth-token/status`,
    { credentials: "include" },
  ).catch(() => null);
  const status: unknown = await res?.json().catch(() => null);
  return (
    !!status &&
    typeof status === "object" &&
    "sandboxSignIn" in status &&
    status.sandboxSignIn === true
  );
}

/** OAuth through Studio's proxy, or through a sandbox for servers that need it. */
export async function authenticateMcp(
  params: Parameters<typeof authenticateThroughProxy>[0],
) {
  if (
    params.orgSlug &&
    (await usesSandboxSignIn(params.orgSlug, params.connectionId))
  ) {
    return signInFromSandbox(params.orgSlug, params.connectionId);
  }
  return authenticateThroughProxy(params);
}
