/**
 * The agent share modal's "typed client" command:
 * `STUDIO_API_KEY=<key> bunx @decocms/cli typegen --org <slug> --agent <id>`.
 * The modal mints a key scoped to that one agent (`{ [agentId]: ["*"] }`), and
 * `decocms typegen` lists the agent's tools over MCP at
 * `/api/:org/mcp/virtual-mcp/:id`. This pins that the scoped key works on that
 * org-scoped route and on the legacy `/mcp/virtual-mcp/:id` the generated
 * client calls at runtime, and nowhere outside its agent.
 */

import type { APIRequestContext } from "@playwright/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { createHttpConnection } from "../fixtures/mcp-tools";
import { startTestMcpServer } from "../fixtures/test-mcp-server";
import { expect, newApiContext, test } from "../fixtures/test";

async function listTools(
  ctx: APIRequestContext,
  path: string,
  key: string,
): Promise<{ status: number; names: string[] }> {
  const res = await ctx.post(path, {
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json, text/event-stream",
    },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  if (!res.ok()) return { status: res.status(), names: [] };
  const body = (await res.json()) as {
    result?: { tools?: { name: string }[] };
  };
  return {
    status: res.status(),
    names: (body.result?.tools ?? []).map((tool) => tool.name),
  };
}

test.describe("agent typegen with a modal-scoped API key", () => {
  test("the key lists its agent's tools on both MCP routes and nothing else", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const mcpServer = await startTestMcpServer();
    const connection = await createHttpConnection(ownerCtx, owner.orgSlug, {
      title: `echo ${stamp}`,
      url: mcpServer.url,
    });
    const created = await ownerCtx.post(
      `/api/${owner.orgSlug}/tools/COLLECTION_VIRTUAL_MCP_CREATE`,
      {
        data: {
          data: {
            title: `typegen ${stamp}`,
            connections: [{ connection_id: connection.id }],
          },
        },
      },
    );
    expect(created.status(), await created.text()).toBe(200);
    const agentId = ((await created.json()) as { item: { id: string } }).item
      .id;

    // Exactly what the share modal mints.
    const minted = await ownerCtx.post(
      `/api/${owner.orgSlug}/tools/API_KEY_CREATE`,
      {
        data: {
          name: `typegen-${stamp}`,
          permissions: { [agentId]: ["*"] },
        },
      },
    );
    expect(minted.status(), await minted.text()).toBe(200);
    const key = ((await minted.json()) as { key: string }).key;

    // No cookies: the key is the only credential.
    const keyCtx = await newApiContext(playwright);

    const orgScoped = await listTools(
      keyCtx,
      `/api/${owner.orgSlug}/mcp/virtual-mcp/${agentId}`,
      key,
    );
    expect(orgScoped.status).toBe(200);
    expect(orgScoped.names.some((name) => name.endsWith("echo"))).toBe(true);

    const legacy = await listTools(keyCtx, `/mcp/virtual-mcp/${agentId}`, key);
    expect(legacy.status).toBe(200);
    expect(legacy.names.sort()).toEqual([...orgScoped.names].sort());

    // Scoped to the agent: the org's builtin tools stay out of reach.
    const builtin = await keyCtx.post(
      `/api/${owner.orgSlug}/tools/ORGANIZATION_SETTINGS_GET`,
      { headers: { authorization: `Bearer ${key}` }, data: {} },
    );
    expect(builtin.status()).toBe(403);

    await keyCtx.dispose();
    await ownerCtx.dispose();
    await mcpServer.stop();
  });
});
