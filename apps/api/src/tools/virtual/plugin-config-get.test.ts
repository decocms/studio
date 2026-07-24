import { describe, expect, it, mock } from "bun:test";
import { VIRTUAL_MCP_PLUGIN_CONFIG_GET } from "./plugin-config-get";

function makeCtx(opts: {
  organizationId: string;
  connections: Record<string, { id: string; organization_id: string }>;
}) {
  const get = mock(async () => ({
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
      },
      virtualMcpPluginConfigs: { get },
    },
  } as unknown as Parameters<typeof VIRTUAL_MCP_PLUGIN_CONFIG_GET.handler>[1];
  return { ctx, get };
}

describe("VIRTUAL_MCP_PLUGIN_CONFIG_GET", () => {
  it("returns null instead of leaking a config from another organization", async () => {
    // Regression: virtualMcpId was passed straight to storage with no check
    // against ctx.organization — access.check() only verifies the caller's
    // permissions within their own org.
    const { ctx, get } = makeCtx({
      organizationId: "org-a",
      connections: {
        vmcp_other: { id: "vmcp_other", organization_id: "org-b" },
      },
    });

    const result = await VIRTUAL_MCP_PLUGIN_CONFIG_GET.handler(
      { virtualMcpId: "vmcp_other", pluginId: "code-execution" },
      ctx,
    );

    expect(result.config).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("returns the config for a virtual MCP within the caller's own organization", async () => {
    const { ctx, get } = makeCtx({
      organizationId: "org-a",
      connections: { vmcp_a: { id: "vmcp_a", organization_id: "org-a" } },
    });

    const result = await VIRTUAL_MCP_PLUGIN_CONFIG_GET.handler(
      { virtualMcpId: "vmcp_a", pluginId: "code-execution" },
      ctx,
    );

    expect(result.config?.virtualMcpId).toBe("vmcp_a");
    expect(get).toHaveBeenCalledWith("vmcp_a", "code-execution");
  });
});
