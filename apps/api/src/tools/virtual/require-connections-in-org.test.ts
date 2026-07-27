import { describe, expect, it, mock } from "bun:test";
import { requireConnectionsInOrganization } from "./require-connections-in-org";

function makeCtx(connections: Record<string, { organization_id: string }>) {
  return {
    storage: {
      connections: {
        findById: mock(async (id: string, organizationId?: string) => {
          const conn = connections[id];
          if (!conn) return null;
          if (organizationId && conn.organization_id !== organizationId) {
            return null;
          }
          return conn;
        }),
      },
    },
  } as unknown as Parameters<typeof requireConnectionsInOrganization>[0];
}

describe("requireConnectionsInOrganization", () => {
  it("throws when a connection id belongs to a different organization", async () => {
    // Regression: COLLECTION_VIRTUAL_MCP_CREATE/UPDATE used to insert
    // connection_aggregations rows for caller-supplied connection ids with no
    // ownership check, and the aggregator later loads children via
    // connections.findById(id) with no org filter — letting an org member
    // wire another org's connection into their own virtual MCP.
    const ctx = makeCtx({
      conn_a: { organization_id: "org-a" },
      conn_other: { organization_id: "org-b" },
    });

    await expect(
      requireConnectionsInOrganization(ctx, "org-a", ["conn_a", "conn_other"]),
    ).rejects.toThrow(/conn_other/);
  });

  it("throws when a connection id does not exist", async () => {
    const ctx = makeCtx({ conn_a: { organization_id: "org-a" } });

    await expect(
      requireConnectionsInOrganization(ctx, "org-a", ["conn_missing"]),
    ).rejects.toThrow(/conn_missing/);
  });

  it("resolves when every connection belongs to the caller's organization", async () => {
    const ctx = makeCtx({
      conn_a: { organization_id: "org-a" },
      conn_b: { organization_id: "org-a" },
    });

    await expect(
      requireConnectionsInOrganization(ctx, "org-a", ["conn_a", "conn_b"]),
    ).resolves.toBeUndefined();
  });
});
