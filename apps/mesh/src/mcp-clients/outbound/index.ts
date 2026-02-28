/**
 * Outbound MCP Client Factory
 *
 * Factory functions for creating MCP clients for outbound connections
 * (STDIO, HTTP, Websocket, SSE).
 */

import type { MeshContext } from "@/core/mesh-context";
import {
  type ConnectionEntity,
  isStdioParameters,
} from "@/tools/connection/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildRequestHeaders } from "./headers";
import { createClientPool } from "./client-pool";
import { createStdioTransport } from "./transport-stdio";
import {
  composeTransport,
  AuthTransport,
  MonitoringTransport,
} from "./transports";

// Singleton pool for STDIO connections — child processes must persist across requests.
// Separate from the per-request pool on MeshContext (used by HTTP/SSE).
const stdioPool = createClientPool();

/**
 * Create an MCP client for outbound connections (STDIO, HTTP, Websocket, SSE)
 *
 * @param connection - Connection entity from database
 * @param ctx - Mesh context for creating clients
 * @param superUser - Whether to use superuser mode for background processes
 * @returns Client instance connected to the downstream MCP server
 */
export async function createOutboundClient(
  connection: ConnectionEntity,
  ctx: MeshContext,
  superUser = false,
): Promise<Client> {
  const connectionId = connection.id;

  // Extract virtualMcpId if request is routed through a Virtual MCP (agent)
  const virtualMcpId =
    ctx.connectionId && ctx.connectionId !== connectionId
      ? ctx.connectionId
      : undefined;

  switch (connection.connection_type) {
    case "STDIO": {
      // Block STDIO connections in production unless explicitly allowed
      if (
        process.env.NODE_ENV === "production" &&
        process.env.UNSAFE_ALLOW_STDIO_TRANSPORT !== "true"
      ) {
        throw new Error(
          "STDIO connections are disabled in production. Set UNSAFE_ALLOW_STDIO_TRANSPORT=true to enable.",
        );
      }

      const maybeParams = connection.connection_headers;

      if (!isStdioParameters(maybeParams)) {
        throw new Error("STDIO connection missing parameters");
      }

      // Create base transport with stderr logging
      let transport: Transport = createStdioTransport({
        id: connectionId,
        name: connection.title,
        command: maybeParams.command,
        args: maybeParams.args,
        env: maybeParams.envVars,
        cwd: maybeParams.cwd,
      });

      // Compose with auth and monitoring transports
      transport = composeTransport(
        transport,
        (t) => new AuthTransport(t, { ctx, connection, superUser }),
        (t) =>
          new MonitoringTransport(t, {
            ctx,
            connectionId,
            connectionTitle: connection.title,
            virtualMcpId,
          }),
      );

      // STDIO uses a singleton pool — child processes must persist across requests.
      // NOT the per-request pool on ctx (that one is for HTTP/SSE with fresh auth headers).
      return stdioPool(transport, connectionId);
    }

    case "HTTP":
    case "Websocket": {
      if (!connection.connection_url) {
        throw new Error(`${connection.connection_type} connection missing URL`);
      }

      const headers = await buildRequestHeaders(connection, ctx, superUser);

      const httpParams = connection.connection_headers;
      if (httpParams && "headers" in httpParams) {
        Object.assign(headers, httpParams.headers);
      }

      let transport: Transport = new StreamableHTTPClientTransport(
        new URL(connection.connection_url),
        { requestInit: { headers } },
      );

      // Compose with auth and monitoring transports
      transport = composeTransport(
        transport,
        (t) => new AuthTransport(t, { ctx, connection, superUser }),
        (t) =>
          new MonitoringTransport(t, {
            ctx,
            connectionId,
            connectionTitle: connection.title,
            virtualMcpId,
          }),
      );

      return ctx.getOrCreateClient(transport, connectionId);
    }

    case "SSE": {
      if (!connection.connection_url) {
        throw new Error("SSE connection missing URL");
      }

      const headers = await buildRequestHeaders(connection, ctx, superUser);

      const httpParams = connection.connection_headers;
      if (httpParams && "headers" in httpParams) {
        Object.assign(headers, httpParams.headers);
      }

      let transport: Transport = new SSEClientTransport(
        new URL(connection.connection_url),
        { requestInit: { headers } },
      );

      // Compose with auth and monitoring transports
      transport = composeTransport(
        transport,
        (t) => new AuthTransport(t, { ctx, connection, superUser }),
        (t) =>
          new MonitoringTransport(t, {
            ctx,
            connectionId,
            connectionTitle: connection.title,
            virtualMcpId,
          }),
      );

      return ctx.getOrCreateClient(transport, connectionId);
    }

    default:
      throw new Error(`Unknown connection type: ${connection.connection_type}`);
  }
}
