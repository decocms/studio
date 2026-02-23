import { describe, expect, it } from "bun:test";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import { resolveInitialPhase } from "./slot-resolution";

function makeConn(
  overrides: Partial<ConnectionEntity> & { metadata?: Record<string, unknown> },
): ConnectionEntity {
  return {
    id: "conn_test",
    title: "Test",
    status: "inactive",
    connection_type: "HTTP",
    connection_url: null,
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    description: null,
    icon: null,
    app_name: null,
    app_id: null,
    tools: null,
    bindings: null,
    organization_id: "org_1",
    created_by: "user_1",
    updated_by: "user_1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as unknown as ConnectionEntity;
}

describe("resolveInitialPhase", () => {
  it("returns 'install' when no matching connections exist", () => {
    const connections: ConnectionEntity[] = [
      makeConn({ metadata: { registry_item_id: "other-item" } }),
    ];
    expect(resolveInitialPhase(connections, "my-item")).toBe("install");
  });

  it("returns 'done' when a matching active connection exists", () => {
    const connections: ConnectionEntity[] = [
      makeConn({
        id: "conn_active",
        status: "active",
        metadata: { registry_item_id: "my-item" },
      }),
    ];
    expect(resolveInitialPhase(connections, "my-item")).toBe("done");
  });

  it("returns 'picker' when matching connections exist but none are active", () => {
    const connections: ConnectionEntity[] = [
      makeConn({
        id: "conn_inactive",
        status: "inactive",
        metadata: { registry_item_id: "my-item" },
      }),
    ];
    expect(resolveInitialPhase(connections, "my-item")).toBe("picker");
  });

  it("returns 'done' for first active match when multiple exist", () => {
    const connections: ConnectionEntity[] = [
      makeConn({
        status: "inactive",
        metadata: { registry_item_id: "my-item" },
      }),
      makeConn({
        id: "conn_2",
        status: "active",
        metadata: { registry_item_id: "my-item" },
      }),
    ];
    expect(resolveInitialPhase(connections, "my-item")).toBe("done");
  });
});

describe("findMatchingConnections", () => {
  it("filters connections by registry_item_id", async () => {
    const connections: ConnectionEntity[] = [
      makeConn({ id: "conn_a", metadata: { registry_item_id: "item-1" } }),
      makeConn({ id: "conn_b", metadata: { registry_item_id: "item-2" } }),
      makeConn({ id: "conn_c", metadata: { registry_item_id: "item-1" } }),
    ];
    const { findMatchingConnections } = await import("./slot-resolution");
    const result = findMatchingConnections(connections, "item-1");
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual(["conn_a", "conn_c"]);
  });
});
