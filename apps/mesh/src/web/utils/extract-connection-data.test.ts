import { describe, expect, it } from "bun:test";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import type { RegistryItem } from "@/web/components/store/types";
import { findMatchingConnections } from "@/web/components/connections-setup/slot-resolution";
import { extractConnectionData } from "./extract-connection-data";

const MCP_MESH_KEY = "mcp.mesh";

function makeRegistryItem(overrides: Partial<RegistryItem> = {}): RegistryItem {
  return {
    id: "test-uuid-1234",
    title: "Test MCP",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    server: {
      name: "deco/test-mcp",
      ...(overrides.server ?? {}),
    },
    ...overrides,
  } as RegistryItem;
}

function makeConn(
  overrides: Partial<ConnectionEntity> & {
    metadata?: Record<string, unknown>;
  } = {},
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

// ── title extraction ────────────────────────────────────────────────────────

describe("extractConnectionData title", () => {
  it("uses friendlyName from mcp.mesh meta", () => {
    const item = makeRegistryItem({
      _meta: { [MCP_MESH_KEY]: { id: "some-id", friendlyName: "OpenRouter" } },
    });
    expect(extractConnectionData(item, "org_1", "user_1").title).toBe(
      "OpenRouter",
    );
  });

  it("falls back to item.title when no meta friendlyName", () => {
    const item = makeRegistryItem({ title: "GitHub" });
    expect(extractConnectionData(item, "org_1", "user_1").title).toBe("GitHub");
  });

  it("falls back to server.name when no item.title", () => {
    const item = makeRegistryItem({
      title: undefined,
      server: { name: "deco/test" },
    });
    expect(extractConnectionData(item, "org_1", "user_1").title).toBe(
      "deco/test",
    );
  });

  it("always produces a non-empty title for any valid registry item", () => {
    const data = extractConnectionData(makeRegistryItem(), "org_1", "user_1");
    expect(data.title.length).toBeGreaterThan(0);
  });
});

// ── registry_item_id ────────────────────────────────────────────────────────

describe("extractConnectionData registry_item_id", () => {
  it("uses server.name so it matches slot.item_id (appName format)", () => {
    const item = makeRegistryItem({ server: { name: "deco/openrouter" } });
    const data = extractConnectionData(item, "org_1", "user_1");
    expect(data.metadata.registry_item_id).toBe("deco/openrouter");
  });

  it("round-trips: connections installed from a registry item are found by findMatchingConnections when searching by slot.item_id", () => {
    const slotItemId = "deco/github";
    const item = makeRegistryItem({ server: { name: slotItemId } });
    const connectionData = extractConnectionData(item, "org_1", "user_1");

    // Simulate what the DB stores after creation
    const storedConn = makeConn({
      metadata: {
        registry_item_id: connectionData.metadata.registry_item_id,
      },
    });

    // slot.item_id is the appName — must match what was stored
    const matches = findMatchingConnections([storedConn], slotItemId);
    expect(matches).toHaveLength(1);
  });

  it("falls back to item.id when server.name is absent", () => {
    const item = makeRegistryItem({
      id: "some-uuid-1234",
      server: { name: undefined as unknown as string },
    });
    const data = extractConnectionData(item, "org_1", "user_1");
    expect(data.metadata.registry_item_id).toBe("some-uuid-1234");
  });

  it("prefers mcp.mesh appName over server.name when present", () => {
    const item = makeRegistryItem({
      server: { name: "deco/openrouter" },
      _meta: { [MCP_MESH_KEY]: { id: "some-id", appName: "deco/openrouter" } },
    });
    const data = extractConnectionData(item, "org_1", "user_1");
    expect(data.metadata.registry_item_id).toBe("deco/openrouter");
  });
});
