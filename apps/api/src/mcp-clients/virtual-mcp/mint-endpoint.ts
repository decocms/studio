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

/**
 * Which Studio MCP surface the minted endpoint points at.
 *
 * - `"agent-tools"` — `/mcp/virtual-mcp/<agentId>`: the tools the agent
 *   aggregates. Correct for an agent with `connection_aggregations` rows.
 * - `"management"` — `/api/<slug>/mcp/self`: Studio's own management tools
 *   (TASK_BOARD_*, connections, agents...). Needed by any out-of-process
 *   harness expected to act on Studio itself.
 *
 * Explicit per caller rather than inferred from the agent: a run that silently
 * picks the wrong surface reports `connected` with an empty tool list, which
 * reads as "the agent ignored its instructions" instead of a misconfiguration.
 */
export type McpEndpointTarget = "agent-tools" | "management";

export class MissingOrganizationSlugError extends Error {
  constructor(organizationId: string) {
    super(
      `cannot mint a management MCP endpoint for organization "${organizationId}": ` +
        `the org-scoped path /api/<slug>/mcp/self needs the org slug, which was not loaded.`,
    );
    this.name = "MissingOrganizationSlugError";
  }
}

/**
 * The endpoint path for one target. Pure — exported for the unit test, which is
 * the only place the two path shapes are pinned against regression.
 *
 * Throws before any credential is minted when a management endpoint is asked
 * for without a slug: the org-scoped path cannot be built without one, and a
 * key minted for an unusable url is a live credential nobody will revoke.
 */
export function mcpEndpointUrl(args: {
  publicUrl: string;
  agentId: string;
  organization: { id: string; slug?: string };
  target: McpEndpointTarget;
}): string {
  const { publicUrl, agentId, organization, target } = args;
  if (target === "agent-tools") {
    return `${publicUrl}/mcp/virtual-mcp/${agentId}`;
  }
  if (!organization.slug) {
    throw new MissingOrganizationSlugError(organization.id);
  }
  return `${publicUrl}/api/${organization.slug}/mcp/self`;
}

export async function mintMcpEndpoint(
  ctx: StudioContext,
  agentId: string,
  organization: { id: string; slug?: string; name?: string },
  apiKeyName: string,
  target: McpEndpointTarget = "agent-tools",
): Promise<{
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}> {
  // Before minting: a throw after `apiKey.create` would leave a live 1h key
  // behind for a run that never starts.
  const url = mcpEndpointUrl({
    publicUrl: getPublicUrl(),
    agentId,
    organization,
    target,
  });
  const apiKey = await ctx.boundAuth.apiKey.create({
    name: apiKeyName,
    // The per-run key is the agent's own callback credential — it acts on
    // behalf of the user, against `/mcp/virtual-mcp/<agentId>` (a `vir_*`
    // resource) or the org's management MCP, for the duration of the run, so it
    // needs full access. With no implicit default (auth/index.ts), the scope
    // must be explicit; wildcard matches the prior behavior (full access via
    // the admin bypass).
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
    url,
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
