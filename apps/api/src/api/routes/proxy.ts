/**
 * MCP Proxy Routes
 *
 * Proxies MCP requests to downstream connections using the official MCP SDK.
 * Based on the pattern from @modelcontextprotocol/typescript-sdk
 *
 * Architecture:
 * - Creates MCP Server to handle incoming requests
 * - Creates MCP Client to connect to downstream connections
 * - Uses middleware pipeline for authorization
 * - Supports StreamableHTTP and STDIO transports
 */

import { clientFromConnection, serverFromConnection } from "@/mcp-clients";
import { SpanStatusCode } from "@opentelemetry/api";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Context, Hono } from "hono";
import { endTime, startTime } from "hono/timing";
import { getUserId, type StudioContext } from "../../core/studio-context";
import { managementContextStore, managementMCP } from "../../tools";
import { serveMcpRequest } from "../utils/serve-mcp";
import { handleAuthError } from "./oauth-proxy";
import { getMcpListCache } from "@/mcp-clients/mcp-list-cache";
import { createLazyClient } from "@/mcp-clients/lazy-client";
import { injectCSP } from "@decocms/shared/mcp-apps/csp-injector";
import type { McpUiResourceCsp } from "@decocms/shared/mcp-apps/types";
import {
  assertCircuitClosed,
  CircuitOpenError,
  recordFailure,
  recordSuccess,
} from "@/mcp-clients/circuit-breaker";
import { getConnectionCircuitStore } from "@/mcp-clients/connection-circuit-store";
import { CONNECTION_ERROR_REPROBE_COOLDOWN_MS } from "@/core/constants";
import { peekRpcMethod, probeDecision } from "./proxy-handshake";
import { handleVirtualMcpRequest } from "./virtual-mcp";
import { resolveDevConnection } from "./dev-connection";
import { parseDevConnectionId } from "@decocms/shared/sdk";
import type { ConnectionEntity } from "../../tools/connection/schema";
export { toServerClient, type MCPProxyClient } from "./mcp-proxy-factory";

// Define Hono variables type
type Variables = {
  studioContext: StudioContext;
};

type ProxyEnv = { Variables: Variables };

const handleError = (err: Error, c: Context) => {
  if (err instanceof CircuitOpenError) {
    c.header("Retry-After", String(Math.ceil(err.cooldownRemainingMs / 1000)));
    return c.json({ error: err.message }, 503);
  }
  if (err.message.includes("not found")) {
    return c.json({ error: err.message }, 404);
  }
  if (err.message.includes("does not belong to the active organization")) {
    return c.json({ error: "Connection not found" }, 404);
  }
  if (err.message.includes("inactive")) {
    return c.json({ error: err.message }, 503);
  }
  return c.json({ error: "Internal server error", message: err.message }, 500);
};

// ============================================================================
// Route Handlers
// ============================================================================

export const createProxyRoutes = () => {
  const app = new Hono<ProxyEnv>();

  /**
   * Default MCP endpoint - serves Decopilot virtual MCP (aggregates all org connections)
   *
   * Route: POST /mcp
   * Uses the Decopilot default virtual MCP, excluding Studio's self-management
   * connection and the organization registry.
   */
  app.all("/", async (c) => {
    return handleVirtualMcpRequest(c, undefined);
  });

  /**
   * Cacheable GET for a connection's UI resource HTML (MCP-apps).
   *
   * Route: GET /mcp/:connectionId/ui-resource?uri=<resource uri>
   *
   * Reads the resource through the lazy client (so the per-pod read cache + SWR
   * apply — no upstream call on a warm hit), injects CSP server-side, then
   * serves the HTML with an `ETag`: a matching `If-None-Match` returns 304 with
   * no body, so the (often multi-MiB) HTML only re-transfers when it changes.
   * `no-cache` makes the browser revalidate before use, so a server-side
   * invalidation is picked up promptly. `private` because it's org/auth-scoped.
   *
   * This is the GET counterpart to the JSON-RPC `resources/read` POST, which is
   * inherently uncacheable by the browser. The frontend renders the bytes into
   * an iframe `srcDoc` (CSP already injected here).
   */
  app.get("/:connectionId/ui-resource", async (c) => {
    const ctx = c.get("studioContext");
    const connectionId = c.req.param("connectionId");
    const uri = c.req.query("uri");
    if (!uri) return c.json({ error: "uri query param is required" }, 400);
    if (!ctx.organization?.id) {
      return c.json({ error: "Organization context is required" }, 403);
    }

    const devAgentId = parseDevConnectionId(connectionId);
    let connection: ConnectionEntity | null;
    if (devAgentId) {
      const userId = getUserId(ctx);
      if (!userId) return c.json({ error: "Authentication required" }, 401);
      connection = await resolveDevConnection(
        ctx,
        devAgentId,
        userId,
        c.req.query("branch") ?? undefined,
      );
      if (!connection) {
        return c.json({ error: "Dev server not running" }, 503);
      }
    } else {
      connection = await ctx.storage.connections.findById(
        connectionId,
        ctx.organization.id,
      );
      if (!connection || connection.organization_id !== ctx.organization.id) {
        return c.json({ error: "Connection not found" }, 404);
      }
    }

    const client = createLazyClient(
      connection,
      ctx,
      false,
      getMcpListCache() ?? undefined,
    );
    let text: string | undefined;
    let resourceCsp: McpUiResourceCsp | undefined;
    try {
      const result = (await client.readResource({ uri })) as {
        contents?: Array<{
          text?: string;
          _meta?: { ui?: { csp?: McpUiResourceCsp } };
        }>;
      };
      const content = result.contents?.[0];
      text = content?.text;
      resourceCsp = content?._meta?.ui?.csp;
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    } finally {
      await client.close().catch(() => {});
    }
    if (typeof text !== "string") {
      return c.json({ error: "Resource has no text content" }, 404);
    }

    const html = injectCSP(text, { resourceCsp });
    const etag = `"${Bun.hash(html).toString(36)}"`;
    const cacheControl = "private, no-cache";
    if (c.req.header("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": cacheControl },
      });
    }
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ETag: etag,
        "Cache-Control": cacheControl,
      },
    });
  });

  /**
   * Proxy MCP request to a downstream connection
   *
   * Route: POST /mcp/:connectionId
   * Connection IDs are globally unique UUIDs (no project prefix needed)
   */
  app.all("/:connectionId", async (c) => {
    const connectionId = c.req.param("connectionId");
    const ctx = c.get("studioContext");

    // SELF MCP connections ({orgId}_self) route to the management MCP server
    // instead of creating an outbound client connection
    if (connectionId.endsWith("_self")) {
      const selfOrgId = connectionId.slice(0, -"_self".length);
      if (!ctx.organization || ctx.organization.id !== selfOrgId) {
        return c.json({ error: "Connection not found" }, 404);
      }
      const server = await managementMCP(ctx);
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse:
          c.req.raw.headers.get("Accept")?.includes("application/json") ??
          false,
      });
      await server.connect(transport);
      // Tool handlers read ctx from the ALS store, so the request must run
      // inside its scope.
      return managementContextStore.run(ctx, () =>
        serveMcpRequest(
          server,
          transport,
          c.req.raw,
          `mcp:self:${connectionId}`,
        ),
      );
    }

    // Dev connections (`dev_<agentId>`) resolve to the acting user's running
    // sandbox dev server — synthetic, per-user, never persisted. Bypass
    // findById and the handshake-probe/circuit machinery below: it keys off a
    // persisted id and logs `connection.url` in a span, which would leak the
    // dev token; dev servers also 5xx transiently on hot-reload.
    const devAgentId = parseDevConnectionId(connectionId);
    if (devAgentId) {
      if (!ctx.organization?.id) {
        return c.json({ error: "Organization context is required" }, 403);
      }
      const userId = getUserId(ctx);
      if (!userId) return c.json({ error: "Authentication required" }, 401);
      const connection = await resolveDevConnection(
        ctx,
        devAgentId,
        userId,
        c.req.query("branch") ?? undefined,
      );
      if (!connection) {
        return c.json({ error: "Dev server not running" }, 503);
      }
      const server = serverFromConnection(connection, ctx, false);
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse:
          c.req.raw.headers.get("Accept")?.includes("application/json") ??
          false,
      });
      await server.connect(transport);
      return serveMcpRequest(
        server,
        transport,
        c.req.raw,
        `mcp:dev:${connectionId}`,
      );
    }

    // Hoisted so the catch block can reuse it instead of re-querying.
    let connection: ConnectionEntity | null = null;
    try {
      try {
        // Organization context is required — without it the ownership
        // check below would be skipped, allowing cross-tenant access.
        if (!ctx.organization?.id) {
          return c.json({ error: "Organization context is required" }, 403);
        }

        // Fetch connection scoped to the caller's organization
        connection = await ctx.tracer.startActiveSpan(
          "studio.connection.lookup",
          { attributes: { "connection.id": connectionId } },
          async (span) => {
            startTime(c, "mcp.find_connection");
            try {
              const result = await ctx.storage.connections.findById(
                connectionId,
                ctx.organization!.id,
              );
              span.setStatus({ code: SpanStatusCode.OK });
              return result;
            } catch (err) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: (err as Error).message,
              });
              span.recordException(err as Error);
              throw err;
            } finally {
              endTime(c, "mcp.find_connection");
              span.end();
            }
          },
        );
        if (!connection) {
          throw new Error("Connection not found");
        }
        // Narrows `connection` for the closures below.
        const foundConnection = connection;

        // Validate organization ownership
        if (foundConnection.organization_id !== ctx.organization.id) {
          throw new Error(
            "Connection does not belong to the active organization",
          );
        }

        // Check connection status.
        // "inactive" = deliberate manual disable: permanent until re-enabled.
        // "error" = auto-disable after sustained failures: self-heals via a
        // half-open re-probe once the cooldown (measured from updated_at, the
        // disable time) elapses. Within the cooldown we fast-fail with a
        // Retry-After hint so callers stop hammering.
        let recovering = false;
        if (foundConnection.status !== "active") {
          const sinceDisabledMs =
            Date.now() - new Date(foundConnection.updated_at).getTime();
          const canReprobe =
            foundConnection.status === "error" &&
            !!foundConnection.connection_url &&
            sinceDisabledMs >= CONNECTION_ERROR_REPROBE_COOLDOWN_MS;
          if (canReprobe) {
            recovering = true;
          } else {
            if (
              foundConnection.status === "error" &&
              foundConnection.connection_url
            ) {
              const remainingMs =
                CONNECTION_ERROR_REPROBE_COOLDOWN_MS - sinceDisabledMs;
              c.header("Retry-After", String(Math.ceil(remainingMs / 1000)));
            }
            throw new Error(`Connection inactive: ${foundConnection.status}`);
          }
        }

        // For HTTP connections, eagerly attempt the upstream MCP handshake to
        // surface auth errors (e.g. OAuth 401). The lazy client inside
        // serverFromConnection defers the connection, so without this probe
        // the proxy would handle "initialize" locally and return 200 OK —
        // hiding the 401 the frontend needs to trigger the OAuth popup.
        // On success this also warms the per-request client pool, so the
        // lazy client reuses the same connection instead of double-connecting.
        //
        // Gated by method: notifications/ping/GET skip the probe entirely, and
        // a list method skips it only when its list is already cached (warm SWR
        // path) — so a cached list poll no longer pays a full downstream
        // handshake. A cold list cache still probes, which surfaces first-load
        // auth errors and warms the per-request pool. See ./proxy-handshake.
        const rpcMethod = await peekRpcMethod(c.req.raw);
        const { decision, listType } = probeDecision(rpcMethod);
        let probe = decision === "probe";
        if (decision === "skip-if-list-cached" && listType) {
          const listCache = getMcpListCache();
          probe = listCache
            ? (await listCache.get(listType, connectionId)) === null
            : true;
        }
        if (recovering) probe = true; // half-open: a real handshake must test recovery
        if (foundConnection.connection_url && probe) {
          assertCircuitClosed(connectionId);
          await ctx.tracer.startActiveSpan(
            "studio.connection.handshake",
            {
              attributes: {
                "connection.id": connectionId,
                "connection.url": foundConnection.connection_url,
              },
            },
            async (span) => {
              startTime(c, "mcp.client_handshake");
              try {
                await clientFromConnection(foundConnection, ctx, false);
                recordSuccess(connectionId);
                void getConnectionCircuitStore().recordSuccess(connectionId);
                if (recovering) {
                  await ctx.storage.connections.update(connectionId, {
                    status: "active",
                  });
                  console.info(
                    "[proxy] auto-recovered connection after successful re-probe",
                    { connectionId, org: ctx.organization?.slug },
                  );
                }
                span.setStatus({ code: SpanStatusCode.OK });
              } catch (err) {
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: (err as Error).message,
                });
                span.recordException(err as Error);
                throw err;
              } finally {
                endTime(c, "mcp.client_handshake");
                span.end();
              }
            },
          );
        }

        // Create enhanced server directly (no need for bridge - server is used directly!)
        startTime(c, "mcp.create_server");
        const server = serverFromConnection(foundConnection, ctx, false);
        endTime(c, "mcp.create_server");

        // Create HTTP transport
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse:
            c.req.raw.headers.get("Accept")?.includes("application/json") ??
            false,
        });

        // Connect server to transport
        startTime(c, "mcp.server_connect");
        await server.connect(transport);
        endTime(c, "mcp.server_connect");

        // Handle request and cleanup
        startTime(c, "mcp.handle_request");
        const response = await serveMcpRequest(
          server,
          transport,
          c.req.raw,
          `mcp:${connectionId}`,
        );
        endTime(c, "mcp.handle_request");
        return response;
      } catch (error) {
        if (error instanceof CircuitOpenError) {
          throw error;
        }
        // Check if this is an auth error - if so, return appropriate 401
        // Note: This only applies to HTTP connections
        connection ??= await ctx.storage.connections.findById(
          connectionId,
          ctx.organization?.id,
        );
        if (connection?.connection_url) {
          const authResponse = await handleAuthError({
            error: error as Error & { status?: number },
            reqUrl: new URL(c.req.raw.url),
            connectionId,
            connectionUrl: connection.connection_url,
            headers: {}, // Headers are built internally by createEnhancedServer
            orgSlug: ctx.organization?.slug,
          });
          if (authResponse) {
            // 401-style errors are user-recoverable (drive the OAuth popup) —
            // they must NOT trip the breaker or disable the connection.
            return authResponse;
          }
          // Non-auth failure (404 / 5xx / network) against a real downstream.
          // Trip the per-replica breaker (latency guard) and the cross-replica
          // failure window. Once failures are sustained fleet-wide, durably
          // disable the connection so every replica stops probing it.
          recordFailure(connectionId);
          const { shouldDisable } =
            await getConnectionCircuitStore().recordFailure(connectionId);
          if (shouldDisable && connection.status === "active") {
            await ctx.storage.connections.update(connectionId, {
              status: "error",
            });
            console.warn(
              "[proxy] auto-disabled connection after sustained failures",
              {
                connectionId,
                org: ctx.organization?.slug,
                error: (error as Error).message,
              },
            );
          }
        }
        throw error;
      }
    } catch (error) {
      return handleError(error as Error, c);
    }
  });

  app.all("/:connectionId/call-tool/:toolName", async (c) => {
    const connectionId = c.req.param("connectionId");
    const toolName = c.req.param("toolName");
    const ctx = c.get("studioContext");

    // Without an org, findById's org filter is skipped — cross-tenant lookup.
    if (!ctx.organization?.id) {
      return c.json({ error: "Organization context is required" }, 403);
    }

    // Hoisted so the catch block can reuse it instead of re-querying.
    let connection: ConnectionEntity | null = null;
    try {
      // Fetch connection and create client directly
      connection = await ctx.storage.connections.findById(
        connectionId,
        ctx.organization.id,
      );
      if (!connection) {
        return c.json({ error: "Connection not found" }, 404);
      }

      // Validate organization ownership
      if (connection.organization_id !== ctx.organization.id) {
        throw new Error(
          "Connection does not belong to the active organization",
        );
      }

      // Mirrors the /:connectionId route's disabled-connection gate.
      if (connection.status !== "active") {
        throw new Error(`Connection inactive: ${connection.status}`);
      }

      // Client pool manages lifecycle, no need for await using
      const client = await clientFromConnection(connection, ctx, false);
      const result = await client.callTool({
        name: toolName,
        arguments: await c.req.json(),
      });

      if (result.isError) {
        return new Response(JSON.stringify(result.content), {
          headers: {
            "Content-Type": "application/json",
          },
          status: 500,
        });
      }

      return new Response(
        JSON.stringify(result.structuredContent ?? result.content),
        {
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    } catch (error) {
      // Surface upstream OAuth 401s as a WWW-Authenticate response so the
      // frontend can trigger the OAuth popup — consistent with the main proxy
      // route. Without this, an expired/missing credential would 500 here.
      connection ??= await ctx.storage.connections.findById(
        connectionId,
        ctx.organization.id,
      );
      if (connection?.connection_url) {
        const authResponse = await handleAuthError({
          error: error as Error & { status?: number },
          reqUrl: new URL(c.req.raw.url),
          connectionId,
          connectionUrl: connection.connection_url,
          headers: {},
          orgSlug: ctx.organization?.slug,
        });
        if (authResponse) {
          return authResponse;
        }
      }
      return handleError(error as Error, c);
    }
  });

  return app;
};
