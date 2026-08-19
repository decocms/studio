/**
 * Client Pool
 *
 * Manages a pool of MCP clients using a Map for connection reuse.
 * Scoped per-request — reuses connections within the same request cycle
 * (e.g., virtual MCP calling multiple tools on the same downstream connection).
 *
 * Must NOT be used as a singleton across requests — HTTP transports bake
 * Studio token headers at creation time, which go stale.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { sharedJsonSchemaValidator } from "@decocms/mcp-utils";

/**
 * Create a client pool
 * Returns a function to get or create clients from the pool
 *
 * @returns Function to get or create a client connection from the pool
 */
export function createClientPool(): (<T extends Transport>(
  createTransport: () => T | Promise<T>,
  key: string,
) => Promise<Client>) & {
  [Symbol.asyncDispose]: () => Promise<void>;
} {
  // Map to store client promises (single-flight pattern)
  const clientMap = new Map<string, Promise<Client>>();

  /**
   * Get or create a client connection from the pool
   * Implements single-flight pattern: concurrent requests for the same key share the same connection promise
   *
   * `createTransport` is called lazily — only on a cache miss. On a cache hit
   * (the common case for a virtual MCP calling multiple tools on the same
   * downstream connection within one request) it never runs, so callers that
   * build headers via a DB lookup + JWT issuance (see `buildRequestHeaders`)
   * don't pay that cost for a client they're about to reuse anyway.
   *
   * @param createTransport - Builds the transport for the connection; only invoked on a cache miss
   * @param key - Unique key for the cache (typically connectionId)
   * @returns The connected client
   */
  function getOrCreateClientImpl<T extends Transport>(
    createTransport: () => T | Promise<T>,
    key: string,
  ): Promise<Client> {
    // Check cache for existing promise (single-flight pattern)
    const cachedPromise = clientMap.get(key);
    if (cachedPromise) {
      return cachedPromise;
    }

    // Create the connection promise immediately and store it
    // This ensures concurrent requests for the same key get the same promise
    const clientPromise = (async () => {
      const transport = await createTransport();
      const client = new Client(
        {
          name: `outbound-client-${key}`,
          version: "1.0.0",
        },
        {
          capabilities: {
            tasks: {
              list: {},
              cancel: {},
              requests: { tool: { call: {} } },
            },
          },
          jsonSchemaValidator: sharedJsonSchemaValidator,
        },
      );

      // Set up cleanup handler BEFORE connecting - remove from cache when connection closes
      client.onclose = () => {
        clientMap.delete(key);
      };

      await client.connect(transport);
      return client;
    })().catch((e) => {
      clientMap.delete(key);
      throw e;
    });

    clientMap.set(key, clientPromise);

    return clientPromise;
  }

  // Create the function object with Symbol.asyncDispose
  const getOrCreateClient = Object.assign(getOrCreateClientImpl, {
    [Symbol.asyncDispose]: async (): Promise<void> => {
      const closePromises: Promise<void>[] = [];
      for (const [_key, clientPromise] of clientMap) {
        closePromises.push(
          clientPromise.then((client) => client.close()).catch(() => {}),
        );
      }
      await Promise.all(closePromises);
      clientMap.clear();
    },
  }) as (<T extends Transport>(
    createTransport: () => T | Promise<T>,
    key: string,
  ) => Promise<Client>) & {
    [Symbol.asyncDispose]: () => Promise<void>;
  };

  return getOrCreateClient;
}
