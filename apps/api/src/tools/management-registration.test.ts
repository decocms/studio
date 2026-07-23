/**
 * Multi-tenant isolation of the shared, ctx-free management tool handler.
 *
 * The registration (config + handler) is built ONCE and shared across every
 * per-request server; the handler reads its StudioContext from an
 * AsyncLocalStorage store rather than capturing it. This test proves that
 * concurrent requests from different tenants each see ONLY their own ctx — both
 * at handler entry and after the handler is suspended mid-execution while every
 * other tenant's handler runs.
 *
 * Why a barrier: a test that just fires N requests and checks results can pass
 * even with a broken (module-global) implementation, because the requests may
 * never overlap at the dangerous moment. The barrier forces ALL N handlers to
 * be suspended simultaneously, each having read its ctx, so a global-variable
 * implementation would have its "current ctx" clobbered by later arrivals and
 * every handler would read the last tenant's id — failing the assertion. With
 * real ALS, each handler's context is restored on resume regardless of what ran
 * in between.
 *
 * It drives the REAL SDK dispatch path (handleRequest -> microtask -> handler),
 * since that microtask hop is exactly where async-context propagation could
 * break.
 */
import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { StudioContext } from "@/core/studio-context";
import {
  buildToolRegistration,
  managementContextStore,
  type RegistrableTool,
} from "./management-registration";

const N = 32;

function fakeCtx(tenantId: string): StudioContext {
  // The handler only touches `.access.setToolName`; the tool reads `.tenantId`.
  return {
    tenantId,
    access: { setToolName: () => {} },
  } as unknown as StudioContext;
}

function callToolRequest(id: number): Request {
  return new Request("http://test.local/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "BARRIER", arguments: {} },
    }),
  });
}

describe("management tool ctx isolation (AsyncLocalStorage)", () => {
  test("concurrent tenants each read only their own ctx under forced interleaving", async () => {
    // Barrier: release only once all N handlers have entered and read their
    // ctx, guaranteeing every handler is suspended mid-execution at the same
    // time (maximal interleaving).
    let arrived = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    // Fail loudly instead of hanging if some handler never arrives.
    const watchdog = setTimeout(() => releaseGate(), 10_000);

    const barrierTool: RegistrableTool = {
      name: "BARRIER",
      description: "test barrier tool",
      inputSchema: undefined,
      outputSchema: undefined,
      execute: async (_args, ctx) => {
        // ctx the handler read from ALS at entry and forwarded here.
        const entryId = (ctx as unknown as { tenantId: string }).tenantId;
        arrived++;
        if (arrived === N) releaseGate();
        // Suspend while every other tenant's handler runs.
        await gate;
        // Re-read the store AFTER suspension: with a broken (global) impl this
        // would now hold the last-arrived tenant's ctx for everyone.
        const afterId = (
          managementContextStore.getStore() as unknown as {
            tenantId: string;
          }
        )?.tenantId;
        return { entryId, afterId };
      },
    };

    // Built ONCE, shared across all per-request servers — exactly like prod.
    const { config, handler } = buildToolRegistration(barrierTool);

    const results = await Promise.all(
      Array.from({ length: N }, async (_unused, i) => {
        const tenantId = `tenant-${i}`;
        // Fresh server + transport per request (production shape), reusing the
        // shared config + handler.
        const server = new McpServer(
          { name: "test", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        server.registerTool("BARRIER", config, handler);
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        await server.connect(transport);

        const response = await managementContextStore.run(
          fakeCtx(tenantId),
          () => transport.handleRequest(callToolRequest(i)),
        );
        const body = (await response.json()) as {
          result?: {
            structuredContent?: { entryId?: string; afterId?: string };
          };
          error?: unknown;
        };
        return { tenantId, body };
      }),
    );

    clearTimeout(watchdog);

    // The barrier must have actually fired — all N were in-flight together.
    expect(arrived).toBe(N);

    for (const { tenantId, body } of results) {
      expect(body.error).toBeUndefined();
      const sc = body.result?.structuredContent;
      expect(sc).toBeDefined();
      // ctx read at handler entry belongs to this tenant.
      expect(sc?.entryId).toBe(tenantId);
      // ctx read after suspension (while all siblings ran) still this tenant.
      expect(sc?.afterId).toBe(tenantId);
    }

    // Every tenant id appears exactly once — no duplication / bleed.
    const seen = results.map((r) => r.body.result?.structuredContent?.afterId);
    expect(new Set(seen).size).toBe(N);
  }, 20_000);

  test("handler invoked outside a request context throws", async () => {
    const tool: RegistrableTool = {
      name: "NO_CTX",
      description: "test",
      inputSchema: undefined,
      outputSchema: undefined,
      execute: async () => ({ ok: true }),
    };
    const { handler } = buildToolRegistration(tool);
    // Not wrapped in managementContextStore.run(...) — getStore() is undefined.
    expect(handler({})).rejects.toThrow(/outside a request context/);
  });
});
