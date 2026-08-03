/**
 * Mint a 1h-TTL API key + return the MCP endpoint URL/headers a sandbox-side
 * consumer uses to talk to Studio's virtual-MCP gateway over HTTP. The hosted
 * agent-sandbox filesystem layer materializes it as the tool-scripting endpoint
 * in a provisioned sandbox, which reaches Studio over its internal URL.
 */

import { getInternalUrl } from "@/core/server-constants";
import type { StudioContext } from "@/core/studio-context";

const MCP_KEY_TTL_SECONDS = 3600;

export async function mintMcpEndpoint(
  ctx: StudioContext,
  agentId: string,
  organization: { id: string; slug?: string; name?: string },
  apiKeyName: string,
): Promise<{
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}> {
  const apiKey = await ctx.boundAuth.apiKey.create({
    name: apiKeyName,
    // The per-run key is the agent's own callback credential — it proxies to
    // `/mcp/virtual-mcp/<agentId>` (a `vir_*` resource) and acts on behalf of
    // the user for the duration of the run, so it needs full access. With no
    // implicit default (auth/index.ts), the scope must be explicit; wildcard
    // matches the prior behavior (full access via the admin bypass).
    permissions: { "*": ["*"] },
    expiresIn: MCP_KEY_TTL_SECONDS,
    metadata: {
      organization: {
        id: organization.id,
        slug: organization.slug,
        name: organization.name,
      },
    },
  });
  return {
    url: `${getInternalUrl()}/mcp/virtual-mcp/${agentId}`,
    headers: {
      Authorization: `Bearer ${apiKey.key}`,
      "x-org-id": organization.id,
    },
    // Wire-shape: HarnessStreamInputWire requires expiresAt for the
    // remote-cli path so the daemon can pre-empt expiry with a refresh
    // (v2 — currently only used for logging / forward-compat).
    expiresAt: Date.now() + MCP_KEY_TTL_SECONDS * 1000,
  };
}
