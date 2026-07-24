import { describe, expect, it, mock } from "bun:test";
import type { PrivateRegistryItemEntity } from "@/storage/registry";
import { ensureMonitorConnection } from "./monitor-run-start";

function makeItem(url: string): PrivateRegistryItemEntity {
  return {
    id: "item-1",
    title: "Test item",
    description: null,
    server: { name: "test", remotes: [{ type: "http", url }] },
    is_public: true,
    is_unlisted: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function makeCtx(create = mock(async () => ({ id: "conn-1" }))) {
  return {
    organization: { id: "org-1" },
    user: { id: "user-1" },
    storage: {
      registry: {
        monitorConnections: {
          findByItemId: mock(async () => null),
          upsert: mock(async () => {}),
        },
      },
      connections: {
        findById: mock(async () => null),
        create,
      },
    },
  } as unknown as Parameters<typeof ensureMonitorConnection>[0];
}

describe("ensureMonitorConnection", () => {
  it("refuses to create a connection for a private-network remote URL", async () => {
    // Publish requests carry an unreviewed, user-supplied URL — without this
    // guard the monitor connects server-side to whatever was submitted.
    const create = mock(async () => ({ id: "conn-1" }));
    const ctx = makeCtx(create);
    const item = makeItem("http://169.254.169.254/latest/meta-data/");

    await expect(ensureMonitorConnection(ctx, item)).rejects.toThrow(
      /private network/,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a connection for an ordinary public remote URL", async () => {
    const create = mock(async () => ({ id: "conn-1" }));
    const ctx = makeCtx(create);
    const item = makeItem("https://example.com/mcp");

    const connectionId = await ensureMonitorConnection(ctx, item);

    expect(connectionId).toBe("conn-1");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
