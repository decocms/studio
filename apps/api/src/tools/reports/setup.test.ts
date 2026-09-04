import { describe, expect, mock, test } from "bun:test";
import type { StudioContext } from "../../core/studio-context";

const USER_ID = "user_1";
const ORG_ID = "org_1";

// setup.ts imports fetchCommerceDiscoveryAuth at module top with no injection
// seam, so we stub the module before importing the tool. This lets us assert
// that SETUP always calls the per-site claim (/upgrade) even when a per-org
// connection already exists with a token.
const fetchAuthMock = mock(
  async (
    _input: unknown,
  ): Promise<{ authorizationToken: string; runId: string }> => ({
    authorizationToken: "dgn_fresh_token",
    runId: "run_setup",
  }),
);
const triggerRunMock = mock(
  async (): Promise<{ triggered: true; runId: string }> => ({
    triggered: true,
    runId: "run_triggered",
  }),
);

mock.module("./auth-client", () => ({
  fetchCommerceDiscoveryAuth: fetchAuthMock,
  triggerCommerceDiscoveryRun: triggerRunMock,
  resolveCommerceDiscoveryMcpUrl: () =>
    "https://reports-stg.decocms.com/api/v2/mcp",
}));

const { COMMERCE_DISCOVERY_SETUP } = await import("./setup");
const { COMMERCE_DISCOVERY_RUN } = await import("./run");

interface StubConnection {
  id: string;
  connection_token?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface StubVirtualMcp {
  id: string;
  organization_id: string;
  pinned?: boolean;
  metadata?: { liveAgentId?: string | null } | null;
}

function makeCtx(opts: {
  existingConnection?: StubConnection;
  existingVirtualMcp?: StubVirtualMcp;
  projectCandidates?: StubVirtualMcp[];
  connectionUpdate?: (id: string, data: Record<string, unknown>) => void;
  /** Stored flags.reports_only value; undefined = settings row never created. */
  reportsOnly?: boolean | null;
  /** Stored flags.reviewer_enabled value; undefined = never set. */
  reviewerEnabled?: boolean | null;
  settingsUpsert?: (orgId: string, data: Record<string, unknown>) => void;
  recordRun?: (data: Record<string, string>) => void;
  /** Org row createdAt; defaults to "just now" (fresh onboarding-made org). */
  orgCreatedAt?: Date;
}): StudioContext {
  let connection = opts.existingConnection ?? null;
  const virtualMcp = opts.existingVirtualMcp ?? {
    id: `commerce-discovery_${ORG_ID}`,
    organization_id: ORG_ID,
    pinned: true,
  };
  const orgCreatedAt = opts.orgCreatedAt ?? new Date();
  const connections = {
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
  };
  const virtualMcps = {
    findById: async (id: string) =>
      opts.projectCandidates !== undefined
        ? (opts.projectCandidates.find((candidate) => candidate.id === id) ??
          null)
        : id === virtualMcp.id
          ? virtualMcp
          : null,
    create: async () => virtualMcp,
    update: async () => virtualMcp,
  };
  const transactionalReports = {
    recordRun: async (data: Record<string, string>) => opts.recordRun?.(data),
  };

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
      connections,
      commerceDiscoveryReports: {
        ...transactionalReports,
        withSetupLock: async (
          _organizationId: string,
          callback: (scope: {
            connections: typeof connections;
            virtualMcps: typeof virtualMcps;
            reports: typeof transactionalReports;
          }) => Promise<unknown>,
        ) =>
          callback({ connections, virtualMcps, reports: transactionalReports }),
      },
      virtualMcps,
      organizationSettings: {
        get: async () =>
          opts.reportsOnly === undefined && opts.reviewerEnabled === undefined
            ? null
            : {
                organizationId: ORG_ID,
                flags: {
                  reports_only: opts.reportsOnly,
                  reviewer_enabled: opts.reviewerEnabled,
                },
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
    const recordedRuns: Array<Record<string, string>> = [];
    const lifecycle: string[] = [];

    const ctx = makeCtx({
      // Existing per-org connection that already has a (stale) token — the bug
      // was that this path skipped /upgrade entirely for a newly onboarded site.
      existingConnection: {
        id: "conn_1",
        connection_token: "dgn_stale_token",
        metadata: { siteUrl: "https://old-site.com" },
      },
      connectionUpdate: (id, data) => {
        updates.push({ id, data });
        lifecycle.push(
          data.connection_token === null ? "credential-cleared" : "published",
        );
      },
      recordRun: (data) => {
        recordedRuns.push(data);
        lifecycle.push("snapshot-recorded");
      },
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

    /** The completion-email CTA ("diagnóstico completo") must deep-link to the
     *  report app view, not /commerce-onboarding; chatDefaultOpen selects Chat. */
    const reportUrl = (claimArg as unknown as { reportUrl?: string })
      .reportUrl!;
    expect(reportUrl).toBe(
      `https://studio.example.com/test-org/projects/commerce-discovery_${ORG_ID}/apps/${ORG_ID}_commerce-discovery/get_my_diagnostic`,
    );
    expect(reportUrl).not.toContain("virtualmcpid=");
    expect(reportUrl).not.toContain("connection=");
    expect(reportUrl).not.toContain("tool=");
    expect(reportUrl).not.toContain("sidepanel=");
    expect(reportUrl).not.toContain("commerce-onboarding");

    // The connection must be updated with the fresh token and the new siteUrl.
    expect(updates).toHaveLength(2);
    expect(updates[0]?.data.connection_token).toBeNull();
    const update = updates[1]!;
    expect(update.id).toBe("conn_1");
    expect(update.data.connection_token).toBe("dgn_fresh_token");
    expect((update.data.metadata as Record<string, unknown>).siteUrl).toBe(
      "https://new-site.com",
    );
    expect((update.data.metadata as Record<string, unknown>).projectId).toBe(
      `commerce-discovery_${ORG_ID}`,
    );
    expect(recordedRuns).toEqual([
      {
        organizationId: ORG_ID,
        runId: "run_setup",
        siteUrl: "https://new-site.com",
        virtualMcpId: `commerce-discovery_${ORG_ID}`,
      },
    ]);
    expect(lifecycle).toEqual([
      "credential-cleared",
      "snapshot-recorded",
      "published",
    ]);
  });

  test("omitting projectId retains an existing explicit owner", async () => {
    const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
    const project = {
      id: "vir_existing_owner",
      organization_id: ORG_ID,
      pinned: true,
    };
    const ctx = makeCtx({
      existingConnection: {
        id: "conn_1",
        connection_token: "dgn_old",
        metadata: {
          siteUrl: "https://old-site.com",
          projectId: project.id,
        },
      },
      projectCandidates: [project],
      connectionUpdate: (id, data) => updates.push({ id, data }),
    });

    await COMMERCE_DISCOVERY_SETUP.handler(
      { siteUrl: "https://new-site.com" },
      ctx,
    );

    const finalMetadata = updates.at(-1)?.data.metadata as Record<
      string,
      unknown
    >;
    expect(finalMetadata.projectId).toBe(project.id);
  });

  test("omitting projectId rejects a missing persisted owner instead of transferring it", async () => {
    fetchAuthMock.mockClear();
    const ctx = makeCtx({
      existingConnection: {
        id: "conn_1",
        connection_token: "dgn_old",
        metadata: {
          siteUrl: "https://old-site.com",
          projectId: "vir_deleted_owner",
        },
      },
      projectCandidates: [],
    });

    await expect(
      COMMERCE_DISCOVERY_SETUP.handler(
        { siteUrl: "https://new-site.com" },
        ctx,
      ),
    ).rejects.toThrow("Project not found in organization");
    expect(fetchAuthMock).not.toHaveBeenCalled();
  });

  test("canonicalizes an explicit development owner to its exact live project", async () => {
    const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
    const dev = {
      id: "vir_dev",
      organization_id: ORG_ID,
      pinned: true,
      metadata: { liveAgentId: "vir_live" },
    };
    const live = {
      id: "vir_live",
      organization_id: ORG_ID,
      pinned: true,
    };
    const ctx = makeCtx({
      existingConnection: { id: "conn_1" },
      projectCandidates: [dev, live],
      connectionUpdate: (id, data) => updates.push({ id, data }),
    });

    await COMMERCE_DISCOVERY_SETUP.handler(
      { siteUrl: "https://new-site.com", projectId: dev.id },
      ctx,
    );

    const finalMetadata = updates.at(-1)?.data.metadata as Record<
      string,
      unknown
    >;
    expect(finalMetadata.projectId).toBe(live.id);
    const claim = fetchAuthMock.mock.calls.at(-1)?.[0] as { reportUrl: string };
    expect(claim.reportUrl).toBe(
      `https://studio.example.com/test-org/projects/${live.id}/reports`,
    );
  });

  test("rejects a development owner whose live target is outside the organization", async () => {
    fetchAuthMock.mockClear();
    const dev = {
      id: "vir_dev",
      organization_id: ORG_ID,
      pinned: true,
      metadata: { liveAgentId: "vir_foreign_live" },
    };
    const foreignLive = {
      id: "vir_foreign_live",
      organization_id: "org_2",
      pinned: true,
    };
    const ctx = makeCtx({
      existingConnection: { id: "conn_1" },
      projectCandidates: [dev, foreignLive],
    });

    await expect(
      COMMERCE_DISCOVERY_SETUP.handler(
        { siteUrl: "https://new-site.com", projectId: dev.id },
        ctx,
      ),
    ).rejects.toThrow("Live project not found in organization");
    expect(fetchAuthMock).not.toHaveBeenCalled();
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
      {
        orgId: ORG_ID,
        data: {
          flags: {
            reports_only: true,
          },
        },
      },
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
      {
        orgId: ORG_ID,
        data: {
          flags: {
            reports_only: true,
          },
        },
      },
    ]);
  });

  test("defaults reports_only on without touching the default-on reviewer flag", async () => {
    const upserts: Array<{ orgId: string; data: Record<string, unknown> }> = [];
    const ctx = makeCtx({
      // Org opted review off by hand; setup only defaults reports_only.
      reviewerEnabled: false,
      settingsUpsert: (orgId, data) => upserts.push({ orgId, data }),
    });

    await COMMERCE_DISCOVERY_SETUP.handler(
      { siteUrl: "https://new-site.com" },
      ctx,
    );

    expect(upserts).toEqual([
      {
        orgId: ORG_ID,
        data: {
          flags: { reports_only: true },
        },
      },
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

describe("COMMERCE_DISCOVERY_RUN", () => {
  test("records the originating project snapshot for the returned run", async () => {
    triggerRunMock.mockClear();
    const recordedRuns: Array<Record<string, string>> = [];
    const project = {
      id: "vir_report_owner",
      organization_id: ORG_ID,
      pinned: true,
    };
    const ctx = makeCtx({
      existingConnection: {
        id: "conn_1",
        metadata: {
          siteUrl: "https://shop.com",
          projectId: project.id,
        },
      },
      projectCandidates: [project],
      recordRun: (data) => recordedRuns.push(data),
    });

    await expect(
      COMMERCE_DISCOVERY_RUN.handler({ siteUrl: "shop.com" }, ctx),
    ).resolves.toEqual({ triggered: true });
    expect(triggerRunMock).toHaveBeenCalledWith({
      siteUrl: "https://shop.com",
      orgId: ORG_ID,
      githubRepo: undefined,
    });
    expect(recordedRuns).toEqual([
      {
        organizationId: ORG_ID,
        runId: "run_triggered",
        siteUrl: "https://shop.com",
        virtualMcpId: project.id,
      },
    ]);
  });
});
