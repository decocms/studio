/**
 * Telling a downstream MCP that its configuration changed.
 *
 * `ON_MCP_CONFIGURATION` is how a configurable MCP learns its own state: the
 * server keeps no copy, so a write that skips this call leaves Studio and the
 * MCP disagreeing until something else happens to write again. Every path that
 * persists `configuration_state` therefore has to make it, which is why it
 * lives here rather than inside the one tool that used to own it.
 *
 * The call is made with the connection as it will be AFTER the write, so the
 * downstream sees the state it is being told about even though the row has not
 * landed yet.
 */

import { clientFromConnection } from "@/mcp-clients";
import type { StudioContext } from "@/core/studio-context";
import type { ConnectionEntity } from "@decocms/shared/sdk";

/** The one-time vault bootstrap a first configuration hands the downstream. */
export interface McpConfigurationVaultBootstrap {
  baseUrl: string;
  org: string;
  subjectConnectionId: string;
  token: string;
}

export async function notifyMcpConfiguration(
  ctx: StudioContext,
  connection: ConnectionEntity,
  params: {
    state: Record<string, unknown>;
    scopes: string[];
    /** Fires the MCP's onInstall hook — true only for a first configuration. */
    firstRun: boolean;
    vault?: McpConfigurationVaultBootstrap;
  },
): Promise<void> {
  const client = await clientFromConnection(connection, ctx, false);
  await client.callTool({
    name: "ON_MCP_CONFIGURATION",
    arguments: {
      state: params.state,
      scopes: params.scopes,
      firstRun: params.firstRun,
      ...(params.vault ? { vault: params.vault } : {}),
    },
  });
}
