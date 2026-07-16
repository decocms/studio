/**
 * E2E: an API key scoped to a virtual MCP (`{ vir_<id>: ["*"] }` — exactly what
 * the agent Connect modal mints) can call tools THROUGH that agent's gateway.
 *
 * Regression for the farmrio report: gateway tool-call authorization checked
 * only the underlying connection id, so an agent-scoped key could `tools/list`
 * (HTTP 200) but every `tools/call` died with JSON-RPC -32603
 * "Access denied to: <tool>". Nothing translated a `vir_*` grant to the
 * connections behind the agent's surface.
 *
 * Contract proven over HTTP only:
 *   - a `{ vir_<id>: ["*"] }` key calls a downstream tool via
 *     /api/:org/mcp/virtual-mcp/:virId (the fix);
 *   - the same key is still DENIED on the direct connection proxy
 *     /api/:org/mcp/:connectionId — the grant is the agent surface, not the
 *     underlying connection;
 *   - spoofing `x-caller-id: vir_<id>` on the direct proxy does NOT smuggle
 *     the gateway grant in (the fallback reads a route-set field, never the
 *     caller-controlled header).
 */
import { z } from "zod";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";
import {
  startTestMcpServer,
  type TestMcpServer,
} from "../fixtures/test-mcp-server";
import { expect, newApiContext, test } from "../fixtures/test";

const RPC_HEADERS = { Accept: "application/json, text/event-stream" };

interface JsonRpcEnvelope {
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ text?: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

test.describe("agent-scoped API key on the gateway", () => {
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

  test("a { vir_<id>: ['*'] } key calls tools through the agent but not the raw connection", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const connection = await createHttpConnection(ownerCtx, owner.orgSlug, {
      title: `Gateway target ${stamp}`,
      url: mcpServer.url,
    });

    const { item: agent } = await callSelfMcpTool<{ item: { id: string } }>(
      ownerCtx,
      owner.orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: `Gateway agent ${stamp}`,
          connections: [{ connection_id: connection.id }],
        },
      },
    );
    expect(agent.id, "virtual MCP created").toBeTruthy();

    // Mint the key exactly like the Connect modal's typegen section does.
    const createKey = await ownerCtx.post(
      `/api/${owner.orgSlug}/tools/API_KEY_CREATE`,
      {
        data: {
          name: `typegen-${stamp}`,
          permissions: { [agent.id]: ["*"] },
        },
      },
    );
    expect(createKey.ok(), `API_KEY_CREATE: HTTP ${createKey.status()}`).toBe(
      true,
    );
    const apiKey = ((await createKey.json()) as { key?: string }).key;
    expect(apiKey, "key value returned").toBeTruthy();

    // Bearer-only context — auth is purely the agent-scoped key.
    const apiCtx = await newApiContext(playwright);
    const headers = { ...RPC_HEADERS, Authorization: `Bearer ${apiKey}` };
    const gatewayUrl = `/api/${owner.orgSlug}/mcp/virtual-mcp/${agent.id}`;

    // tools/list always worked (no per-tool gate) — use it to pick up the
    // gateway-namespaced tool name instead of hardcoding the slug scheme.
    const listRes = await apiCtx.post(gatewayUrl, {
      headers,
      data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(listRes.ok(), `tools/list: HTTP ${listRes.status()}`).toBe(true);
    const listBody = (await listRes.json()) as JsonRpcEnvelope;
    const pingTool = listBody.result?.tools?.find((t) =>
      t.name.endsWith("_ping"),
    );
    expect(pingTool, "namespaced ping tool listed").toBeTruthy();

    // The fix: tools/call through the agent surface succeeds. Before it, this
    // returned JSON-RPC -32603 "Access denied to: ping".
    const callRes = await apiCtx.post(gatewayUrl, {
      headers,
      data: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: pingTool!.name, arguments: { from: "e2e" } },
      },
    });
    expect(callRes.ok(), `tools/call: HTTP ${callRes.status()}`).toBe(true);
    const callBody = (await callRes.json()) as JsonRpcEnvelope;
    expect(
      callBody.error,
      `gateway tools/call error: ${JSON.stringify(callBody.error)}`,
    ).toBeUndefined();
    expect(callBody.result?.isError).not.toBe(true);
    const payload = JSON.parse(callBody.result?.content?.[0]?.text ?? "{}");
    expect(payload).toEqual({ pong: true, from: "e2e" });

    // Boundary: the agent-scoped grant does NOT reach the underlying
    // connection directly — only through the agent's gateway.
    const directRes = await apiCtx.post(
      `/api/${owner.orgSlug}/mcp/${connection.id}`,
      {
        headers,
        data: {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "ping", arguments: { from: "e2e" } },
        },
      },
    );
    const directDenied = !directRes.ok()
      ? true
      : Boolean(
          (((await directRes.json()) as JsonRpcEnvelope).error?.message ?? "")
            .toLowerCase()
            .includes("access denied"),
        );
    expect(directDenied, "vir-scoped key denied on direct connection").toBe(
      true,
    );

    // Spoof guard: x-caller-id is a caller-set header that feeds
    // ctx.connectionId — it must NOT be able to impersonate the gateway and
    // smuggle the vir grant onto a direct connection call.
    const spoofedRes = await apiCtx.post(
      `/api/${owner.orgSlug}/mcp/${connection.id}`,
      {
        headers: { ...headers, "x-caller-id": agent.id },
        data: {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "ping", arguments: { from: "e2e" } },
        },
      },
    );
    const spoofedDenied = !spoofedRes.ok()
      ? true
      : Boolean(
          (((await spoofedRes.json()) as JsonRpcEnvelope).error?.message ?? "")
            .toLowerCase()
            .includes("access denied"),
        );
    expect(
      spoofedDenied,
      "spoofed x-caller-id must not unlock the direct connection",
    ).toBe(true);

    await ownerCtx.dispose();
    await apiCtx.dispose();
  });
});
