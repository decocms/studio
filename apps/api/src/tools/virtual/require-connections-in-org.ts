/**
 * Ownership guard for virtual MCP connection references.
 *
 * COLLECTION_VIRTUAL_MCP_CREATE/UPDATE accept a list of connection ids to
 * aggregate into the agent. `connections.findById` only filters by
 * organization when given one — an unchecked id would let a caller wire in
 * another org's connection and have its tools (and credentials) proxied
 * through their own virtual MCP.
 */
import type { StudioContext } from "../../core/studio-context";

export async function requireConnectionsInOrganization(
  ctx: StudioContext,
  organizationId: string,
  connectionIds: string[],
): Promise<void> {
  const uniqueIds = [...new Set(connectionIds)];
  const found = await Promise.all(
    uniqueIds.map((id) => ctx.storage.connections.findById(id, organizationId)),
  );
  const missing = uniqueIds.filter((_, i) => !found[i]);
  if (missing.length > 0) {
    throw new Error(`Connection not found: ${missing.join(", ")}`);
  }
}
