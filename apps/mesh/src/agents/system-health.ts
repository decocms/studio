/**
 * System-health agent: install + lookup for the error-monitoring preset.
 *
 * First click on the card calls `ensureSystemHealthAgent`, which is
 * idempotent: it installs the underlying HTTP MCP connection (pointing
 * at `DECO_SYSTEM_HEALTH_MCP`, default `sites-syshealthagent.decocache.com`)
 * if one doesn't exist, then creates a wrapping virtual MCP (agent) that
 * aggregates that connection. Subsequent clicks reuse the existing pair
 * so re-running the preset doesn't multiply rows.
 *
 * The agent's static system prompt lives on the vmcp row's
 * `metadata.instructions`, which `dispatchRun` reads through
 * `passthroughClient.getInstructions()` the same way as every other agent.
 */

import type { MeshContext } from "@/core/mesh-context";
import { DownstreamTokenStorage } from "@/storage/downstream-token";
import { fetchToolsFromMCP } from "@/tools/connection/fetch-tools";

const SYSTEM_HEALTH_APP_NAME = "mcp-system-health";
const SYSTEM_HEALTH_AGENT_TYPE = "system-health-agent";
const DEFAULT_SYSTEM_HEALTH_URL = "https://sites-syshealthagent.decocache.com";

const SYSTEM_HEALTH_AGENT_INSTRUCTIONS = `
You are the system-health agent for the user's deco.cx sites.
Use the connected MCP to list sites and recent errors.
When the user picks a site, summarize health and propose fixes.
Don't invent tools you don't have.
`.trim();

function getSystemHealthMcpUrl(): string {
  const base = process.env.DECO_SYSTEM_HEALTH_MCP ?? DEFAULT_SYSTEM_HEALTH_URL;
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/mcp") ? trimmed : `${trimmed}/mcp`;
}

async function findSystemHealthConnection(
  organizationId: string,
  ctx: MeshContext,
) {
  const { items } = await ctx.storage.connections.list(organizationId, {
    slug: SYSTEM_HEALTH_APP_NAME,
    includeVirtual: false,
  });
  return items[0] ?? null;
}

/**
 * True iff the org has an installed system-health connection AND a valid
 * downstream OAuth token for it. Used by the preset resolver to decide
 * whether the card should open the install/OAuth dialog or skip straight
 * to starting the thread.
 *
 * We accept either a non-expired `DownstreamToken` row or a legacy
 * `connection_token` on the connection itself — older installs may carry
 * the token there instead of in the dedicated table.
 */
export async function hasAuthenticatedSystemHealth(
  organizationId: string,
  ctx: MeshContext,
): Promise<boolean> {
  const conn = await findSystemHealthConnection(organizationId, ctx);
  if (!conn) return false;
  if (conn.connection_token) return true;
  const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
  const token = await tokenStorage.get(conn.id);
  return !!token && !tokenStorage.isExpired(token);
}

async function ensureSystemHealthConnection(
  organizationId: string,
  userId: string,
  ctx: MeshContext,
): Promise<string> {
  const existing = await findSystemHealthConnection(organizationId, ctx);
  if (existing) return existing.id;

  const url = getSystemHealthMcpUrl();
  const title = "System Health";
  const fetched = await fetchToolsFromMCP({
    id: `pending-${Date.now()}`,
    title,
    connection_type: "HTTP",
    connection_url: url,
    connection_token: null,
    connection_headers: null,
  }).catch(() => null);

  const created = await ctx.storage.connections.create({
    organization_id: organizationId,
    created_by: userId,
    title,
    description: "Monitors deco.cx site health and surfaces errors.",
    app_name: SYSTEM_HEALTH_APP_NAME,
    app_id: null,
    connection_type: "HTTP",
    connection_url: url,
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: fetched?.scopes?.length ? fetched.scopes : null,
    metadata: { type: SYSTEM_HEALTH_AGENT_TYPE },
    icon: null,
    tools: fetched?.tools?.length ? fetched.tools : null,
  });
  return created.id;
}

export async function ensureSystemHealthAgent(
  organizationId: string,
  userId: string,
  ctx: MeshContext,
): Promise<string> {
  const connectionId = await ensureSystemHealthConnection(
    organizationId,
    userId,
    ctx,
  );

  const wrappers = await ctx.storage.virtualMcps.listByConnectionId(
    organizationId,
    connectionId,
  );
  const existingAgent = wrappers.find(
    (v) =>
      (v.metadata as Record<string, unknown> | null)?.type ===
      SYSTEM_HEALTH_AGENT_TYPE,
  );
  if (existingAgent) return existingAgent.id;

  const agent = await ctx.storage.virtualMcps.create(organizationId, userId, {
    title: "System health",
    description: "Monitors errors on your deco.cx sites.",
    icon: "icon://Activity?color=rose",
    status: "active",
    pinned: false,
    metadata: {
      type: SYSTEM_HEALTH_AGENT_TYPE,
      instructions: SYSTEM_HEALTH_AGENT_INSTRUCTIONS,
    },
    connections: [
      {
        connection_id: connectionId,
        selected_tools: null,
        selected_resources: null,
        selected_prompts: null,
      },
    ],
  });

  return agent.id;
}
