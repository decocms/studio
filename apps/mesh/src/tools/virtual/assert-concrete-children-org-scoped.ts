/**
 * Guards the COLLECTION_VIRTUAL_MCP create/update path: a private
 * (access='user') connection must not be hard-bound as a concrete child of an
 * agent, because a concrete child is loaded for every caller regardless of who
 * owns it. Private connections must be attached as typed slots instead, which
 * resolve to each caller's own connection of the same app_id.
 */

import type { ConnectionStoragePort } from "../../storage/ports";
import { INTERNAL_VIEWER } from "../../storage/ports";

export async function assertConcreteChildrenAreOrgScoped(
  connections: { connection_id: string }[],
  connectionStorage: ConnectionStoragePort,
  organizationId: string,
): Promise<void> {
  for (const conn of connections) {
    const c = await connectionStorage.findById(
      conn.connection_id,
      organizationId,
      INTERNAL_VIEWER,
    );
    if (c && c.access === "user") {
      throw new Error(
        `Connection ${conn.connection_id} is private and cannot be added as a concrete child of an agent. Attach it as a slot using its app_id instead.`,
      );
    }
  }
}
