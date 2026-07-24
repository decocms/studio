/**
 * Mint a 1h-TTL API key + return the MCP endpoint URL/headers a sandbox-side
 * consumer uses to talk to Studio's virtual-MCP gateway over HTTP. Two callers:
 * dispatch-run (CLI harnesses opening a real HTTP MCP connection) and the
 * cluster sandbox-fs layer (materializing the tool-scripting endpoint file
 * into a provisioned sandbox).
 *
 * `sandboxProviderKind` decides which base URL to mint:
 *   - `"agent-sandbox"` — `getInternalUrl()` (loopback; the consumer runs
 *     in hosted execution alongside the API).
 *   - `"user-desktop"` — `getPublicUrl()` (the consumer runs on the user's
 *     laptop and dials Studio back over the public network).
 */

import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import { getInternalUrl, getPublicUrl } from "@/core/server-constants";
import type { StudioContext } from "@/core/studio-context";

const MCP_KEY_TTL_SECONDS = 3600;

export async function mintMcpEndpoint(
  ctx: StudioContext,
  agentId: string,
  organization: { id: string; slug?: string; name?: string },
  apiKeyName: string,
  sandboxProviderKind: SandboxProviderKind,
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
  const baseUrl =
    sandboxProviderKind === "user-desktop" ? getPublicUrl() : getInternalUrl();
  return {
    url: `${baseUrl}/mcp/virtual-mcp/${agentId}`,
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
