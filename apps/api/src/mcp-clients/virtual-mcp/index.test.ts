import { describe, expect, mock, test } from "bun:test";
import type { ConnectionEntity } from "../../tools/connection/schema";
import type { VirtualMCPEntity } from "../../tools/virtual/schema";
import { createVirtualClientFrom } from "./index";

function makeConnection(id: string): ConnectionEntity {
  return {
    id,
    title: id,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    created_by: "user1",
    organization_id: "org1",
    description: null,
    icon: null,
    app_name: null,
    app_id: null,
    connection_type: "HTTP",
    connection_url: "http://localhost:3000",
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    metadata: null,
    tools: null,
    bindings: null,
    status: "active",
  } as ConnectionEntity;
}

function makeVirtualMcp(connectionIds: string[]): VirtualMCPEntity {
  return {
    id: "vmcp1",
    title: "Test VMCP",
    description: null,
    icon: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    created_by: "user1",
    organization_id: "",
    status: "active",
    pinned: false,
    metadata: {},
    connections: connectionIds.map((connection_id) => ({
      connection_id,
      selected_tools: null,
      selected_resources: null,
      selected_prompts: null,
    })),
  } as VirtualMCPEntity;
}

function makeCtx(findById: (id: string) => Promise<ConnectionEntity | null>) {
  return {
    tracer: {
      startActiveSpan: (
        _name: string,
        _opts: unknown,
        fn: (span: unknown) => unknown,
      ) =>
        fn({
          setStatus: () => {},
          recordException: () => {},
          end: () => {},
        }),
    },
    storage: {
      connections: { findById },
    },
  } as never;
}

describe("createVirtualClientFrom", () => {
  test("keeps the other connections' tools when one lookup rejects", async () => {
    const good = makeConnection("conn_ok");
    const findById = mock(async (id: string) => {
      if (id === "conn_bad") throw new Error("db unavailable");
      return good;
    });
    const ctx = makeCtx(findById);

    const client = await createVirtualClientFrom(
      makeVirtualMcp(["conn_ok", "conn_bad"]),
      ctx,
    );

    expect(client.getConnectionTitleMap().has("conn_ok")).toBe(true);
    expect(client.getConnectionTitleMap().has("conn_bad")).toBe(false);
  });
});
