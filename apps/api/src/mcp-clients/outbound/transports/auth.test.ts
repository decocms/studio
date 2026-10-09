import { describe, expect, test } from "bun:test";
import { MCP_LIST_TOOLS_TIMEOUT_MS } from "@/core/constants";
import { AuthTransport, agentKeyCovers } from "./auth";

describe("AuthTransport", () => {
  test(
    "bounds the internal tools/list probe instead of hanging forever when the downstream server never replies",
    async () => {
      // Simulates a downstream MCP server that accepts the request but never
      // sends a response — no onmessage callback is ever invoked.
      const hangingInner = {
        send: async () => {},
        close: async () => {},
      } as any;

      const ctx = { pendingRevalidations: [], auth: {} } as any;
      const connection = { id: "conn_test" } as any;

      const transport = new AuthTransport(hangingInner, { ctx, connection });

      const outcome = await Promise.race([
        transport
          .send({
            jsonrpc: "2.0",
            id: "1",
            method: "tools/call",
            params: { name: "SOME_TOOL", arguments: {} },
          } as any)
          .then(() => "resolved")
          .catch(() => "rejected"),
        new Promise((resolve) =>
          setTimeout(
            () => resolve("still-hanging"),
            MCP_LIST_TOOLS_TIMEOUT_MS + 3000,
          ),
        ),
      ]);

      expect(outcome).not.toBe("still-hanging");
    },
    MCP_LIST_TOOLS_TIMEOUT_MS + 5000,
  );
});

describe("agentKeyCovers", () => {
  const agent = {
    id: "vir_agent",
    organization_id: "org_a",
    status: "active",
    connections: [
      { connection_id: "conn_all", selected_tools: null },
      { connection_id: "conn_some", selected_tools: ["allowed_tool"] },
    ],
  };
  const ctxWith = (
    permissions: Record<string, string[]>,
    overrides: Record<string, unknown> = {},
  ) =>
    ({
      organization: { id: "org_a" },
      boundAuth: { isApiKeyPrincipal: true },
      auth: { permissions, permissionsOrganizationId: "org_a" },
      storage: {
        virtualMcps: {
          findById: async (id: string) => (id === agent.id ? agent : null),
        },
      },
      ...overrides,
    }) as any;

  test("an agent wildcard covers its connections, within selected_tools", async () => {
    const ctx = ctxWith({ vir_agent: ["*"] });
    expect(await agentKeyCovers(ctx, "conn_all", "any_tool")).toBe(true);
    expect(await agentKeyCovers(ctx, "conn_some", "allowed_tool")).toBe(true);
    expect(await agentKeyCovers(ctx, "conn_some", "other_tool")).toBe(false);
    expect(await agentKeyCovers(ctx, "conn_elsewhere", "any_tool")).toBe(false);
  });

  test("an explicit agent grant covers only the named tools", async () => {
    const ctx = ctxWith({ vir_agent: ["a_tool"] });
    expect(await agentKeyCovers(ctx, "conn_all", "a_tool")).toBe(true);
    expect(await agentKeyCovers(ctx, "conn_all", "b_tool")).toBe(false);
  });

  test("never applies to non-key principals, other orgs, or inactive agents", async () => {
    const grant = { vir_agent: ["*"] };
    const session = ctxWith(grant, { boundAuth: { isApiKeyPrincipal: false } });
    const otherOrg = ctxWith(grant, { organization: { id: "org_b" } });
    const inactive = ctxWith(grant, {
      storage: {
        virtualMcps: {
          findById: async () => ({ ...agent, status: "inactive" }),
        },
      },
    });
    for (const ctx of [session, otherOrg, inactive]) {
      expect(await agentKeyCovers(ctx, "conn_all", "any_tool")).toBe(false);
    }
  });
});
