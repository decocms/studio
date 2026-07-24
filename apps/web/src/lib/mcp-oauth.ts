/**
 * MCP OAuth Client Utilities
 *
 * Re-exported from @/sdk for backwards compatibility.
 * New code should import directly from @/sdk.
 */

export {
  authenticateMcp,
  handleOAuthCallback,
  isConnectionAuthenticated,
  type McpOAuthProviderOptions,
  type OAuthTokenInfo,
  type AuthenticateMcpResult,
  type McpAuthStatus,
} from "@/sdk";
