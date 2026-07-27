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
  resolveCommerceDiscoveryMcpUrl: () =>
    "https://reports-stg.decocms.com/api/v2/mcp",
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
  connectionUpdate?: (id: string, data: Record<string, unknown>) => void;
  /** Stored flags.reports_only value; undefined = settings row never created. */
  reportsOnly?: boolean | null;
  settingsUpsert?: (orgId: string, data: Record<string, unknown>) => void;
  /** Org row createdAt; defaults to "just now" (fresh onboarding-made org). */
  orgCreatedAt?: Date;
}): StudioContext {
  let connection = opts.existingConnection ?? null;
  const virtualMcp = opts.existingVirtualMcp ?? { id: "vmcp_1", pinned: true };
  const orgCreatedAt = opts.orgCreatedAt ?? new Date();

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
    baseUrl: "https://studio.example.com",
    db: {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: async () => ({ createdAt: orgCreatedAt }),
          }),
        }),
      }),
    },
    storage: {
      connections: {
        findById: async () => connection,
        update: async (id: string, data: Record<string, unknown>) => {
          opts.connectionUpdate?.(id, data);
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
      organizationSettings: {
        get: async () =>
          opts.reportsOnly === undefined
            ? null
            : {
                organizationId: ORG_ID,
                flags: { reports_only: opts.reportsOnly },
              },
        upsert: async (orgId: string, data: Record<string, unknown>) => {
          opts.settingsUpsert?.(orgId, data);
          return { organizationId: orgId, ...data };
        },
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

    // The completion-email CTA ("diagnóstico completo") must deep-link to the
    // report APP VIEW, not the /commerce-onboarding page: /$org/$taskId with the
    // vMCP selected and its report view pinned open. No chat param — the
    // The vMCP's chatDefaultOpen metadata selects Chat in the side panel.
    const reportUrl = (claimArg as unknown as { reportUrl?: string })
      .reportUrl!;
    expect(reportUrl).toContain("https://studio.example.com/test-org/");
    expect(reportUrl).toContain("virtualmcpid=commerce-discovery_");
    expect(reportUrl).toContain("main=app"); // "app:<connId>:<toolName>" pinned view
    expect(reportUrl).not.toContain("sidepanel=");
    expect(reportUrl).not.toContain("commerce-onboarding");

    // The connection must be updated with the fresh token and the new siteUrl.
    expect(updates).toHaveLength(1);
    const update = updates[0]!;
    expect(update.id).toBe("conn_1");
    expect(update.data.connection_token).toBe("dgn_fresh_token");
    expect((update.data.metadata as Record<string, unknown>).siteUrl).toBe(
      "https://new-site.com",
    );
  });

  test("defaults reports_only on for an org the flow just created", async () => {
    const upserts: Array<{ orgId: string; data: Record<string, unknown> }> = [];
    const ctx = makeCtx({
      // orgCreatedAt defaults to "just now" — the flow-minted org.
      settingsUpsert: (orgId, data) => upserts.push({ orgId, data }),
    });

    await COMMERCE_DISCOVERY_SETUP.handler(
      { siteUrl: "https://new-site.com" },
      ctx,
    );

    expect(upserts).toEqual([
      { orgId: ORG_ID, data: { flags: { reports_only: true } } },
    ]);
  });

  test("setup retry on a fresh org still defaults the flag", async () => {
    const upserts: Array<{ orgId: string; data: Record<string, unknown> }> = [];
    const ctx = makeCtx({
      // Connection already exists (first attempt failed mid-way) but the org
      // is minutes old — the retry must still finish the reports_only default.
      existingConnection: { id: "conn_1", connection_token: "dgn_token" },
      settingsUpsert: (orgId, data) => upserts.push({ orgId, data }),
    });

    await COMMERCE_DISCOVERY_SETUP.handler(
      { siteUrl: "https://new-site.com" },
      ctx,
    );

    expect(upserts).toEqual([
      { orgId: ORG_ID, data: { flags: { reports_only: true } } },
    ]);
  });

  test("does not clobber an explicit reports_only=false on a fresh org", async () => {
    const upserts: Array<{ orgId: string; data: Record<string, unknown> }> = [];
    const ctx = makeCtx({
      reportsOnly: false,
      settingsUpsert: (orgId, data) => upserts.push({ orgId, data }),
    });

    await COMMERCE_DISCOVERY_SETUP.handler(
      { siteUrl: "https://new-site.com" },
      ctx,
    );

    expect(upserts).toHaveLength(0);
  });

  test("never flips reports_only on an established org doing its first onboarding", async () => {
    const upserts: Array<{ orgId: string; data: Record<string, unknown> }> = [];
    const ctx = makeCtx({
      // Org created days ago, no report connection yet — a pre-existing org
      // (with its own agents/MCPs) picking itself in the onboarding org
      // choice must NOT be collapsed to the report surface.
      orgCreatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      settingsUpsert: (orgId, data) => upserts.push({ orgId, data }),
    });

    await COMMERCE_DISCOVERY_SETUP.handler(
      { siteUrl: "https://new-site.com" },
      ctx,
    );

    expect(upserts).toHaveLength(0);
  });
});
