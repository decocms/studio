/**
 * Mint a 1h-TTL API key + return the MCP endpoint URL/headers a sandbox-side
 * consumer uses to talk to Studio's virtual-MCP gateway over HTTP. Callers:
 * the sandbox-hosted harness dispatcher (`SandboxDispatchClient`) and the
 * cluster sandbox-fs layer (materializing the tool-scripting endpoint file
 * into a provisioned sandbox).
 *
 * Always the PUBLIC url. Every consumer of this endpoint dials it from outside
 * this process — a sandbox pod or the user's laptop — so a loopback url names
 * the consumer's own localhost, not Studio. In a sandbox pod that is the
 * tenant's dev server on :3000, which answers 404s instead of MCP.
 *
 * A pod reaches it the same way it reaches every other API: egress is limited
 * to DNS + TCP/443 (`netinit.allowedTCPPorts`), and RFC1918 destinations are
 * rejected, so the url has to be the public HTTPS one.
 */

import { getPublicUrl } from "@/core/server-constants";
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
    url: `${getPublicUrl()}/mcp/virtual-mcp/${agentId}`,
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
