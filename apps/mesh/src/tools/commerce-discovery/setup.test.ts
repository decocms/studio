import { describe, expect, mock, test } from "bun:test";
import type { StudioContext } from "../../core/studio-context";

const USER_ID = "user_1";
const ORG_ID = "org_1";

// setup.ts imports fetchCommerceDiscoveryAuth at module top with no injection
// seam, so we stub the module before importing the tool. This lets us assert
// that SETUP always calls the per-site claim (/upgrade) even when a per-org
// connection already exists with a token.
const fetchAuthMock = mock(
  async (_input: unknown): Promise<{ authorizationToken: string }> => ({
    authorizationToken: "dgn_fresh_token",
  }),
);

mock.module("./auth-client", () => ({
  fetchCommerceDiscoveryAuth: fetchAuthMock,
}));

const { COMMERCE_DISCOVERY_SETUP } = await import("./setup");

interface StubConnection {
  id: string;
  connection_token?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface StubVirtualMcp {
  id: string;
  pinned?: boolean;
}

function makeCtx(opts: {
  existingConnection?: StubConnection;
  existingVirtualMcp?: StubVirtualMcp;
  connectionUpdate: (id: string, data: Record<string, unknown>) => void;
}): StudioContext {
  let connection = opts.existingConnection ?? null;
  const virtualMcp = opts.existingVirtualMcp ?? { id: "vmcp_1", pinned: true };

  return {
    auth: {
      user: {
        id: USER_ID,
        email: "owner@example.com",
        name: "Owner",
        role: "user",
      },
    },
    access: {
      granted: () => true,
      check: async () => {},
      grant: () => {},
      setToolName: () => {},
    },
    organization: { id: ORG_ID, slug: "test-org", name: "Test Org" },
    baseUrl: "https://mesh.example.com",
    storage: {
      connections: {
        findById: async () => connection,
        update: async (id: string, data: Record<string, unknown>) => {
          opts.connectionUpdate(id, data);
          connection = { ...(connection ?? { id }), ...data } as StubConnection;
          return connection;
        },
        create: async (data: Record<string, unknown>) => {
          connection = { id: "conn_1", ...data } as StubConnection;
          return connection;
        },
      },
      virtualMcps: {
        findById: async () => virtualMcp,
        create: async () => virtualMcp,
        update: async () => virtualMcp,
      },
    },
    metadata: { requestId: "req_1", timestamp: new Date() },
  } as unknown as StudioContext;
}

describe("COMMERCE_DISCOVERY_SETUP", () => {
  test("claims the site and syncs token + metadata even when a connection with a token already exists", async () => {
    fetchAuthMock.mockClear();
    const updates: Array<{ id: string; data: Record<string, unknown> }> = [];

    const ctx = makeCtx({
      // Existing per-org connection that already has a (stale) token — the bug
      // was that this path skipped /upgrade entirely for a newly onboarded site.
      existingConnection: {
        id: "conn_1",
        connection_token: "dgn_stale_token",
        metadata: { siteUrl: "https://old-site.com" },
      },
      connectionUpdate: (id, data) => updates.push({ id, data }),
    });

    await COMMERCE_DISCOVERY_SETUP.handler(
      { siteUrl: "https://new-site.com" },
      ctx,
    );

    // The per-site claim (/upgrade) must be called for the current site.
    expect(fetchAuthMock).toHaveBeenCalledTimes(1);
    const claimArg = fetchAuthMock.mock.calls[0]?.[0] as {
      siteUrl: string;
      orgId: string;
    };
    expect(claimArg.siteUrl).toBe("https://new-site.com");
    expect(claimArg.orgId).toBe(ORG_ID);

    // The connection must be updated with the fresh token and the new siteUrl.
    expect(updates).toHaveLength(1);
    const update = updates[0]!;
    expect(update.id).toBe("conn_1");
    expect(update.data.connection_token).toBe("dgn_fresh_token");
    expect((update.data.metadata as Record<string, unknown>).siteUrl).toBe(
      "https://new-site.com",
    );
  });
});
