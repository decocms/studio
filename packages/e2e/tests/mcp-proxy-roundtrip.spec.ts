/**
 * End-to-end smoke test for mesh's MCP proxy.
 *
 * Stands up a tiny test MCP server (apps/mesh/e2e/fixtures/test-mcp-server.ts),
 * creates a real connection in mesh that points at it, then exercises the
 * proxy mount at /api/:org/mcp/:connectionId. Validates the whole chain:
 *
 *   Playwright APIRequestContext
 *     → /api/:org/mcp/:connectionId (mesh proxy)
 *       → connection lookup + auth
 *         → outbound HTTP to the test MCP server
 *           → tool handler returns
 *         ← MCP response
 *       ← mesh forwards
 *     ← client gets JSON-RPC tools/call result
 *
 * Also serves as the first runtime use of:
 *   - startTestMcpServer (test-mcp-server.ts)
 *   - createHttpConnection + callSelfMcpTool (mcp-tools.ts)
 * — surfacing breakage in those helpers before downstream specs depend on
 * them.
 */

import { z } from "zod";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";
import {
  startTestMcpServer,
  type TestMcpServer,
} from "../fixtures/test-mcp-server";
import { expect, newApiContext, test } from "../fixtures/test";

test.describe("MCP proxy roundtrip", () => {
  let mcpServer: TestMcpServer;

  test.beforeAll(async () => {
    mcpServer = await startTestMcpServer({
      tools: [
        {
          name: "ping",
          description: "Returns pong + the input.",
          inputSchema: { from: z.string() },
          handler: (args) => ({ pong: true, from: args.from }),
        },
      ],
    });
  });

  test.afterAll(async () => {
    await mcpServer?.stop();
  });

  test("calls a tool on a downstream MCP server through the proxy", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);

    // Create a real connection in mesh pointing at the test MCP server.
    // This also exercises `callSelfMcpTool` indirectly via the helper.
    const connection = await createHttpConnection(ctx, user.orgSlug, {
      title: `Test MCP ${Date.now()}`,
      url: mcpServer.url,
    });

    // Verify the connection is actually queryable through the management
    // MCP — `callSelfMcpTool` direct use, also serves as a smoke check
    // that the helper handles list-style responses.
    const listed = await callSelfMcpTool<{
      items?: Array<{ id: string; title: string }>;
    }>(ctx, user.orgSlug, "COLLECTION_CONNECTIONS_LIST", {});
    expect(listed.items?.some((c) => c.id === connection.id)).toBe(true);

    // Hit the proxy mount with a JSON-RPC tools/call. The proxy resolves
    // the connection, opens an MCP client to the underlying URL, and
    // forwards the call.
    const res = await ctx.post(`/api/${user.orgSlug}/mcp/${connection.id}`, {
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ping", arguments: { from: "playwright" } },
      },
      headers: { Accept: "application/json, text/event-stream" },
    });
    expect(res.ok()).toBe(true);
    const envelope = (await res.json()) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: unknown;
    };
    expect(envelope.error).toBeUndefined();
    expect(envelope.result?.isError).not.toBe(true);
    const text = envelope.result?.content?.[0]?.text;
    expect(text).toBeDefined();
    const payload = JSON.parse(text!) as { pong: boolean; from: string };
    expect(payload).toEqual({ pong: true, from: "playwright" });

    // The test MCP server should have logged at least tools/call.
    expect(mcpServer.requests.some((r) => r.method === "tools/call")).toBe(
      true,
    );

    await ctx.dispose();
  });

  test("repeated tools/list does not re-handshake downstream on every poll", async ({
    playwright,
  }) => {
    // Dedicated downstream server so request counts are isolated from the
    // other test in this describe.
    const downstream = await startTestMcpServer({
      tools: [
        {
          name: "ping",
          description: "Returns pong.",
          handler: () => ({ pong: true }),
        },
      ],
    });

    try {
      const ctx = await newApiContext(playwright);
      const user = await signUpViaApi(ctx);
      const connection = await createHttpConnection(ctx, user.orgSlug, {
        title: `Poll MCP ${Date.now()}`,
        url: downstream.url,
      });

      const url = `/api/${user.orgSlug}/mcp/${connection.id}`;
      const headers = { Accept: "application/json, text/event-stream" };

      // Standard MCP lifecycle: initialize once (the proxy probes downstream
      // here to surface auth — that's the legitimate handshake).
      const init = await ctx.post(url, {
        headers,
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "e2e-poll", version: "1.0.0" },
          },
        },
      });
      expect(init.ok()).toBe(true);

      // Poll tools/list many times in quick succession — the kind of traffic a
      // UI generates. With the eager-probe gating + SWR revalidation throttle,
      // these must NOT each trigger a fresh downstream MCP handshake.
      const POLLS = 8;
      let lastTools: Array<{ name: string }> = [];
      for (let i = 0; i < POLLS; i++) {
        const res = await ctx.post(url, {
          headers,
          data: { jsonrpc: "2.0", id: 10 + i, method: "tools/list" },
        });
        expect(res.ok()).toBe(true);
        const body = (await res.json()) as {
          result?: { tools?: Array<{ name: string }> };
        };
        if (body.result?.tools) lastTools = body.result.tools;
      }

      // Functional correctness: the proxied tool list is still served.
      expect(lastTools.some((t) => t.name === "ping")).toBe(true);

      // The core assertion: downstream handshakes are bounded by a small
      // constant (initialize probe + at most a cold list warm-up), NOT one per
      // request. Before the fix this would be ~POLLS + 1.
      const initializeCount = downstream.requests.filter(
        (r) => r.method === "initialize",
      ).length;
      expect(initializeCount).toBeLessThanOrEqual(3);
      expect(initializeCount).toBeLessThan(POLLS);

      await ctx.dispose();
    } finally {
      await downstream.stop();
    }
  });
});
