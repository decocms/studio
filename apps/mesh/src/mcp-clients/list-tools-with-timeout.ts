/**
 * Bounded `listTools()` probe.
 *
 * `clientFromConnection` connects eagerly (the transport handshake and the
 * downstream-token DB read both happen before `listTools()` is even sent), so a
 * timeout on the request alone wouldn't cover a connection that hangs during
 * connect. We race the whole connect+list against a deadline and abort the
 * in-flight request on timeout so a slow downstream can't pin a socket open.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { StudioContext } from "../core/studio-context";
import type { ConnectionEntity } from "../tools/connection/schema";
import { clientFromConnection } from "./client";

class ListToolsTimeoutError extends Error {
  constructor(connectionId: string, timeoutMs: number) {
    super(
      `listTools timed out after ${timeoutMs}ms for connection ${connectionId}`,
    );
    this.name = "ListToolsTimeoutError";
  }
}

/**
 * Connect to a connection's MCP server and list its tools, bounded by
 * `timeoutMs`. Rejects with {@link ListToolsTimeoutError} on timeout; the
 * underlying request is aborted and the client closed in the background.
 */
export async function listToolsWithTimeout(
  connection: ConnectionEntity,
  ctx: StudioContext,
  timeoutMs: number,
): Promise<Tool[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ListToolsTimeoutError(connection.id, timeoutMs));
    }, timeoutMs);
  });

  const work = (async () => {
    const client = await clientFromConnection(connection, ctx, true);
    try {
      const result = await client.listTools(undefined, {
        timeout: timeoutMs,
        signal: controller.signal,
      });
      return result.tools;
    } finally {
      await client.close().catch(() => {});
    }
  })();

  // Don't leave the losing `work` promise unhandled when the timeout wins.
  work.catch(() => {});

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
