import { describe, expect, it, mock } from "bun:test";
import { VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE } from "./plugin-config-update";

function makeCtx(opts: {
  organizationId: string;
  connections: Record<string, { id: string; organization_id: string }>;
}) {
  const upsert = mock(async () => ({
    id: "vpc_1",
    virtualMcpId: "vmcp_a",
    pluginId: "code-execution",
    connectionId: null,
    settings: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }));
  const ctx = {
    auth: { user: { id: "user-1" } },
    organization: { id: opts.organizationId },
    access: { check: mock(async () => {}) },
    storage: {
      connections: {
        findById: mock(async (id: string) => opts.connections[id] ?? null),
        create: mock(async () => {}),
      },
      virtualMcpPluginConfigs: { upsert },
    },
  } as unknown as Parameters<
    typeof VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE.handler
  >[1];
  return { ctx, upsert };
}

describe("VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE", () => {
  it("rejects a virtual MCP id belonging to a different organization", async () => {
    // Regression: neither the virtual-MCP row nor the connection being bound
    // was checked against ctx.organization — access.check() only verifies
    // the caller's permissions within their own org, so a caller could
    // reconfigure another org's virtual MCP plugin by guessing its ID.
    const { ctx, upsert } = makeCtx({
      organizationId: "org-a",
      connections: {
        vmcp_other: { id: "vmcp_other", organization_id: "org-b" },
      },
    });

    await expect(
      VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE.handler(
        { virtualMcpId: "vmcp_other", pluginId: "code-execution" },
        ctx,
      ),
    ).rejects.toThrow(/not found/i);

    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects binding a connection owned by a different organization", async () => {
    const { ctx, upsert } = makeCtx({
      organizationId: "org-a",
      connections: {
        vmcp_a: { id: "vmcp_a", organization_id: "org-a" },
        conn_other: { id: "conn_other", organization_id: "org-b" },
      },
    });

    await expect(
      VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE.handler(
        {
          virtualMcpId: "vmcp_a",
          pluginId: "code-execution",
          connectionId: "conn_other",
        },
        ctx,
      ),
    ).rejects.toThrow(/not found/i);

    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a connectionId that does not exist instead of hitting the FK constraint", async () => {
    // Regression: a non-existent, non-dev-assets connectionId used to fall
    // through to virtualMcpPluginConfigs.upsert(), which would surface as a
    // raw FK constraint-violation error rather than a clean "not found".
    const { ctx, upsert } = makeCtx({
      organizationId: "org-a",
      connections: {
        vmcp_a: { id: "vmcp_a", organization_id: "org-a" },
      },
    });

    await expect(
      VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE.handler(
        {
          virtualMcpId: "vmcp_a",
          pluginId: "code-execution",
          connectionId: "conn_missing",
        },
        ctx,
      ),
    ).rejects.toThrow(/not found/i);

    expect(upsert).not.toHaveBeenCalled();
  });

  it("allows updating a plugin config within the caller's own organization", async () => {
    const { ctx, upsert } = makeCtx({
      organizationId: "org-a",
      connections: {
        vmcp_a: { id: "vmcp_a", organization_id: "org-a" },
        conn_a: { id: "conn_a", organization_id: "org-a" },
      },
    });

    const result = await VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE.handler(
      {
        virtualMcpId: "vmcp_a",
        pluginId: "code-execution",
        connectionId: "conn_a",
      },
      ctx,
    );

    expect(result.config.virtualMcpId).toBe("vmcp_a");
    expect(upsert).toHaveBeenCalledWith("vmcp_a", "code-execution", {
      connectionId: "conn_a",
      settings: undefined,
    });
  });
});
