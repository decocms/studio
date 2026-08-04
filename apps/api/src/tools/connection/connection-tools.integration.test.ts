import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "bun:test";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../../database/test-db-pg";
import type { StudioDatabase } from "../../database";
import { CredentialVault } from "../../encryption/credential-vault";
import {
  COLLECTION_CONNECTIONS_CREATE,
  COLLECTION_CONNECTIONS_LIST,
  COLLECTION_CONNECTIONS_GET,
  COLLECTION_CONNECTIONS_UPDATE,
  CONNECTION_TEST,
} from "./index";
import type { BoundAuthClient, StudioContext } from "../../core/studio-context";
import { ConnectionStorage } from "../../storage/connection";
import {
  ConnectionCredentialVaultStorage,
  CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
  CREDENTIAL_CONFIGURATION_READ_SCOPE,
} from "../../storage/connection-credential-vault";
import { DownstreamTokenStorage } from "../../storage/downstream-token";
import * as fetchToolsModule from "./fetch-tools";

// Create a mock BoundAuthClient for tests
const createMockBoundAuth = (): BoundAuthClient =>
  ({
    hasPermission: vi.fn().mockResolvedValue(true),
    organization: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      addMember: vi.fn(),
      removeMember: vi.fn(),
      listMembers: vi.fn(),
      updateMemberRole: vi.fn(),
    },
  }) as unknown as BoundAuthClient;

describe("Connection Tools", () => {
  let database: StudioDatabase;
  let ctx: StudioContext;
  let vault: CredentialVault;

  const setMockMcpClient = (client: unknown) => {
    (
      ctx.getOrCreateClient as unknown as {
        mockResolvedValue: (value: unknown) => void;
      }
    ).mockResolvedValue(client);
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);

    vault = new CredentialVault(CredentialVault.generateKey());

    // Create mock context
    ctx = {
      timings: {
        measure: async <T>(_name: string, cb: () => Promise<T>) => await cb(),
      },
      auth: {
        user: {
          id: "user_1",
          email: "[email protected]",
          name: "Test",
          role: "admin",
        },
      },
      organization: {
        id: "org_123",
        slug: "test-org",
        name: "Test Organization",
      },
      storage: {
        connections: new ConnectionStorage(database.db, vault),
        connectionCredentialVault: new ConnectionCredentialVaultStorage(
          database.db,
        ),
        subsidizedGatewayKeys: null as never,
        organizationSettings: {
          get: async () => null,
          upsert: async (_orgId: string) => ({
            organizationId: _orgId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        } as never,
        userModelPreferences: null as never,
        organizationBilling: null as never,
        monitoring: null as never,
        threads: null as never,
        asyncResearchJobs: null as never,
        virtualMcps: null as never,
        users: null as never,
        tags: null as never,
        virtualMcpPluginConfigs: null as never,
        aiProviderKeys: null as never,
        secrets: null as never,
        orgFileConfigs: null as never,
        orgSites: null as never,
        taskBoard: null as never,
        orgFsEntries: null as never,
        oauthPkceStates: null as never,
        automations: null as never,
        orgSsoConfig: null as never,
        orgSsoSessions: null as never,
        triggerCallbackTokens: null as never,
        registry: null as never,
        brandContext: null as never,
        organizationDomains: null as never,
        organizationJoinRequests: null as never,
        kv: null as never,
        interests: null as never,
      },
      vault,
      authInstance: null as never,
      boundAuth: createMockBoundAuth(),
      access: {
        granted: () => true,
        check: async () => {},
        grant: () => {},
        setToolName: () => {},
      } as never,
      db: database.db,
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
      } as never,
      meter: {
        createHistogram: () => ({ record: () => {} }),
        createCounter: () => ({ add: () => {} }),
      } as never,
      baseUrl: "https://studio.example.com",
      metadata: {
        requestId: "req_123",
        timestamp: new Date(),
      },
      objectStorage: null as never,
      orgFs: null,
      aiProviders: null as never,
      createMCPProxy: vi.fn().mockResolvedValue({}),
      getOrCreateClient: vi.fn().mockResolvedValue({
        callTool: vi.fn().mockResolvedValue({}),
      }),
      pendingRevalidations: [],
    };
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setMockMcpClient({
      callTool: vi.fn().mockResolvedValue({}),
    });
  });

  describe("COLLECTION_CONNECTIONS_CREATE", () => {
    it("should create organization-scoped connection", async () => {
      const result = await COLLECTION_CONNECTIONS_CREATE.execute(
        {
          data: {
            title: "Company Slack",
            description: "Organization-wide Slack",
            connection_type: "HTTP",
            // Use a guaranteed-unresolvable host (RFC 6761 `.invalid` TLD) so
            // the best-effort tool fetch (create.ts → fetchToolsFromMCP) fails
            // fast instead of hanging on a live handshake. A real reachable URL
            // (e.g. slack.com) can stall past the 5s test timeout in CI; this
            // test only asserts connection creation, not tool fetching (which
            // the UPDATE test covers with a mock). Mirrors CONNECTION_TEST.
            connection_url: "https://slack.invalid/mcp",
            connection_token: "slack-token",
          },
        },
        ctx,
      );

      expect(result.item.id).toMatch(/^conn_/);
      expect(result.item.title).toBe("Company Slack");
      expect(result.item.organization_id).toBe("org_123");
      expect(result.item.status).toBe("active");
    });

    it("derives credential grants and delivers vault bootstrap for initial configuration scopes", async () => {
      const target = await ctx.storage.connections.create({
        id: "conn_create_vault_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Create Vault Target",
        connection_type: "HTTP",
        connection_url: "https://create-vault-target.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      const callTool = vi.fn().mockResolvedValue({});
      setMockMcpClient({
        callTool,
      });

      vi.spyOn(fetchToolsModule, "fetchToolsFromMCP").mockResolvedValue({
        tools: null,
        scopes: null,
      });

      const result = await COLLECTION_CONNECTIONS_CREATE.execute(
        {
          data: {
            id: "conn_create_vault_subject",
            title: "Create Vault Subject",
            connection_type: "HTTP",
            connection_url: "https://create-vault-subject.invalid/mcp",
            connection_token: null,
            configuration_state: {
              github: { __type: "@deco/github", value: target.id },
            },
            configuration_scopes: [
              `github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
            ],
          },
        },
        ctx,
      );

      await expect(
        ctx.storage.connectionCredentialVault.hasGrant({
          organizationId: "org_123",
          subjectConnectionId: result.item.id,
          targetConnectionId: target.id,
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        }),
      ).resolves.toBe(true);

      const callback = callTool.mock.calls[0]?.[0];
      expect(callback).toBeDefined();
      if (!callback) {
        throw new Error("Expected ON_MCP_CONFIGURATION callback");
      }
      expect(callback.name).toBe("ON_MCP_CONFIGURATION");
      expect(callback.arguments.firstRun).toBe(true);
      expect(callback.arguments.vault).toMatchObject({
        baseUrl: "https://studio.example.com",
        org: "test-org",
        subjectConnectionId: result.item.id,
      });
      expect(callback.arguments.vault.token).toStartWith("stv_");
    });

    it("cleans up a newly created connection when initial vault bootstrap delivery fails", async () => {
      const target = await ctx.storage.connections.create({
        id: "conn_create_vault_failure_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Create Vault Failure Target",
        connection_type: "HTTP",
        connection_url: "https://create-vault-failure-target.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      setMockMcpClient({
        callTool: vi.fn().mockRejectedValue(new Error("callback unavailable")),
      });

      vi.spyOn(fetchToolsModule, "fetchToolsFromMCP").mockResolvedValue({
        tools: null,
        scopes: null,
      });

      await expect(
        COLLECTION_CONNECTIONS_CREATE.execute(
          {
            data: {
              id: "conn_create_vault_failure_subject",
              title: "Create Vault Failure Subject",
              connection_type: "HTTP",
              connection_url:
                "https://create-vault-failure-subject.invalid/mcp",
              connection_token: null,
              configuration_state: {
                github: { __type: "@deco/github", value: target.id },
              },
              configuration_scopes: [
                `github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
              ],
            },
          },
          ctx,
        ),
      ).rejects.toThrow("callback unavailable");

      await expect(
        ctx.storage.connections.findById("conn_create_vault_failure_subject"),
      ).resolves.toBeNull();
      const tokenRows = await database.db
        .selectFrom("connection_workload_tokens")
        .select("id")
        .where("organization_id", "=", "org_123")
        .where(
          "subject_connection_id",
          "=",
          "conn_create_vault_failure_subject",
        )
        .where("revoked_at", "is", null)
        .execute();
      expect(tokenRows).toEqual([]);
    });

    it("rejects duplicate IDs before bootstrap and preserves the existing connection", async () => {
      const target = await ctx.storage.connections.create({
        id: "conn_create_vault_duplicate_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Create Vault Duplicate Target",
        connection_type: "HTTP",
        connection_url: "https://create-vault-duplicate-target.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      const existing = await ctx.storage.connections.create({
        id: "conn_create_vault_duplicate_subject",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Original Duplicate Subject",
        connection_type: "HTTP",
        connection_url: "https://original-duplicate-subject.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      const callTool = vi
        .fn()
        .mockRejectedValue(new Error("callback unavailable"));
      setMockMcpClient({ callTool });

      vi.spyOn(fetchToolsModule, "fetchToolsFromMCP").mockResolvedValue({
        tools: null,
        scopes: null,
      });

      await expect(
        COLLECTION_CONNECTIONS_CREATE.execute(
          {
            data: {
              id: existing.id,
              title: "Replacement Duplicate Subject",
              connection_type: "HTTP",
              connection_url:
                "https://replacement-duplicate-subject.invalid/mcp",
              connection_token: null,
              configuration_state: {
                github: { __type: "@deco/github", value: target.id },
              },
              configuration_scopes: [
                `github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
              ],
            },
          },
          ctx,
        ),
      ).rejects.toThrow("Connection already exists in organization");

      expect(callTool).not.toHaveBeenCalled();
      const preserved = await ctx.storage.connections.findById(existing.id);
      expect(preserved?.title).toBe("Original Duplicate Subject");
      expect(preserved?.connection_url).toBe(
        "https://original-duplicate-subject.invalid/mcp",
      );
    });
  });

  describe("COLLECTION_CONNECTIONS_UPDATE (OAuth tool refresh)", () => {
    it("should refresh tools using downstream OAuth token when connection_token is not set", async () => {
      const connection = await ctx.storage.connections.create({
        id: "conn_oauth_tools",
        organization_id: "org_123",
        created_by: "user_1",
        title: "OAuth MCP",
        connection_type: "HTTP",
        connection_url: "https://example.com/mcp",
        connection_token: null,
        tools: null,
      });

      const tokenStorage = new DownstreamTokenStorage(database.db, vault);
      await tokenStorage.upsert({
        connectionId: connection.id,
        accessToken: "oauth-access-token",
        refreshToken: null,
        scope: null,
        expiresAt: new Date(Date.now() + 60_000),
        clientId: null,
        clientSecret: null,
        tokenEndpoint: null,
      });

      const fetchSpy = vi
        .spyOn(fetchToolsModule, "fetchToolsFromMCP")
        .mockImplementation(async (input) => {
          expect(input.connection_token).toBe("oauth-access-token");
          return {
            tools: [
              {
                name: "COLLECTION_LLM_LIST",
                description: "List models",
                inputSchema: { type: "object" as const },
              },
            ],
            scopes: null,
          };
        });

      const result = await COLLECTION_CONNECTIONS_UPDATE.execute(
        { id: connection.id, data: {} },
        ctx,
      );

      expect(fetchSpy).toHaveBeenCalled();
      // Tools are no longer stored in the DB — they go to NATS KV cache
      // The connection record should have tools: null
      expect(result.item.tools).toBeNull();
    });
  });

  describe("COLLECTION_CONNECTIONS_UPDATE (credential vault grants)", () => {
    it("derives separate grants for downstream access token and configuration scopes", async () => {
      await ctx.storage.connections.create({
        id: "conn_vault_configuration_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Configuration Target",
        connection_type: "HTTP",
        connection_url: "https://vault-configuration-target.invalid/mcp",
        status: "active",
      });

      const subject = await ctx.storage.connections.create({
        id: "conn_vault_configuration_subject",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Configuration Subject",
        connection_type: "HTTP",
        connection_url: "https://vault-configuration-subject.invalid/mcp",
        status: "active",
      });

      setMockMcpClient({
        callTool: vi.fn().mockResolvedValue({}),
      });

      await COLLECTION_CONNECTIONS_UPDATE.execute(
        {
          id: subject.id,
          data: {
            configuration_state: {
              github: {
                __type: "@deco/github",
                value: "conn_vault_configuration_target",
              },
            },
            configuration_scopes: [
              `github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
              `github::${CREDENTIAL_CONFIGURATION_READ_SCOPE}`,
            ],
          },
        },
        ctx,
      );

      await expect(
        ctx.storage.connectionCredentialVault.hasGrant({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
          targetConnectionId: "conn_vault_configuration_target",
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        }),
      ).resolves.toBe(true);

      await expect(
        ctx.storage.connectionCredentialVault.hasGrant({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
          targetConnectionId: "conn_vault_configuration_target",
          scope: CREDENTIAL_CONFIGURATION_READ_SCOPE,
        }),
      ).resolves.toBe(true);
    });

    it("replaces credential grants and creates a workload token from configuration scopes", async () => {
      const subject = await ctx.storage.connections.create({
        id: "conn_vault_subject",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Subject",
        connection_type: "HTTP",
        connection_url: "https://subject.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      const target = await ctx.storage.connections.create({
        id: "conn_vault_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Target",
        connection_type: "HTTP",
        connection_url: "https://target.invalid/mcp",
        connection_token: null,
        tools: null,
      });

      const fetchSpy = vi
        .spyOn(fetchToolsModule, "fetchToolsFromMCP")
        .mockResolvedValue({ tools: null, scopes: null });

      await COLLECTION_CONNECTIONS_UPDATE.execute(
        {
          id: subject.id,
          data: {
            configuration_state: {
              github: { __type: "@deco/github", value: target.id },
            },
            configuration_scopes: [
              `github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
            ],
          },
        },
        ctx,
      );

      expect(fetchSpy).toHaveBeenCalled();
      await expect(
        ctx.storage.connectionCredentialVault.hasGrant({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
          targetConnectionId: target.id,
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        }),
      ).resolves.toBe(true);

      const tokenRow = await database.db
        .selectFrom("connection_workload_tokens")
        .select(["id", "revoked_at"])
        .where("organization_id", "=", "org_123")
        .where("subject_connection_id", "=", subject.id)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      expect(tokenRow).toBeDefined();

      await COLLECTION_CONNECTIONS_UPDATE.execute(
        {
          id: subject.id,
          data: {
            configuration_scopes: [],
          },
        },
        ctx,
      );

      await expect(
        ctx.storage.connectionCredentialVault.hasGrant({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
          targetConnectionId: target.id,
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        }),
      ).resolves.toBe(false);
    });

    it("restores previous saved config and grants when workload token rotation fails", async () => {
      const previousTarget = await ctx.storage.connections.create({
        id: "conn_vault_rollback_previous_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Rollback Previous Target",
        connection_type: "HTTP",
        connection_url: "https://rollback-previous-target.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      const subject = await ctx.storage.connections.create({
        id: "conn_vault_rollback_subject",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Rollback Subject",
        connection_type: "HTTP",
        connection_url: "https://rollback-subject.invalid/mcp",
        connection_token: null,
        tools: null,
        configuration_state: {
          previous: { value: previousTarget.id },
        },
        configuration_scopes: [
          `previous::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
        ],
      });
      const target = await ctx.storage.connections.create({
        id: "conn_vault_rollback_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Rollback Target",
        connection_type: "HTTP",
        connection_url: "https://rollback-target.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      await ctx.storage.connectionCredentialVault.replaceGrantsForSubject({
        organizationId: "org_123",
        subjectConnectionId: subject.id,
        createdBy: "user_1",
        grants: [
          {
            targetConnectionId: previousTarget.id,
            scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
          },
        ],
      });

      vi.spyOn(fetchToolsModule, "fetchToolsFromMCP").mockResolvedValue({
        tools: null,
        scopes: null,
      });
      vi.spyOn(
        ctx.storage.connectionCredentialVault,
        "createOrRotateWorkloadToken",
      ).mockRejectedValue(new Error("vault unavailable"));

      await expect(
        COLLECTION_CONNECTIONS_UPDATE.execute(
          {
            id: subject.id,
            data: {
              configuration_state: {
                github: { __type: "@deco/github", value: target.id },
              },
              configuration_scopes: [
                `github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
              ],
            },
          },
          ctx,
        ),
      ).rejects.toThrow("vault unavailable");

      const restored = await ctx.storage.connections.findById(subject.id);
      expect(restored?.configuration_state).toEqual({
        previous: { value: previousTarget.id },
      });
      expect(restored?.configuration_scopes).toEqual([
        `previous::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
      ]);
      await expect(
        ctx.storage.connectionCredentialVault.hasGrant({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
          targetConnectionId: previousTarget.id,
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        }),
      ).resolves.toBe(true);
      await expect(
        ctx.storage.connectionCredentialVault.hasGrant({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
          targetConnectionId: target.id,
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        }),
      ).resolves.toBe(false);
    });

    it("creates credential grants from auto-discovered configuration scopes", async () => {
      const target = await ctx.storage.connections.create({
        id: "conn_vault_auto_scope_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Auto Scope Target",
        connection_type: "HTTP",
        connection_url: "https://auto-scope-target.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      const subject = await ctx.storage.connections.create({
        id: "conn_vault_auto_scope_subject",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Auto Scope Subject",
        connection_type: "HTTP",
        connection_url: "https://auto-scope-subject.invalid/mcp",
        connection_token: null,
        tools: null,
        configuration_state: {
          github: { __type: "@deco/github", value: target.id },
        },
        configuration_scopes: [],
      });

      vi.spyOn(fetchToolsModule, "fetchToolsFromMCP").mockResolvedValue({
        tools: null,
        scopes: [`github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`],
      });

      await COLLECTION_CONNECTIONS_UPDATE.execute(
        {
          id: subject.id,
          data: {},
        },
        ctx,
      );

      await expect(
        ctx.storage.connectionCredentialVault.hasGrant({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
          targetConnectionId: target.id,
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        }),
      ).resolves.toBe(true);

      const updated = await ctx.storage.connections.findById(subject.id);
      expect(updated?.configuration_scopes).toEqual([
        `github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
      ]);
    });

    it("rejects auto-discovered credential scopes when referenced connection access is denied", async () => {
      const target = await ctx.storage.connections.create({
        id: "conn_vault_auto_scope_denied_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Auto Scope Denied Target",
        connection_type: "HTTP",
        connection_url: "https://auto-scope-denied-target.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      const subject = await ctx.storage.connections.create({
        id: "conn_vault_auto_scope_denied_subject",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Auto Scope Denied Subject",
        connection_type: "HTTP",
        connection_url: "https://auto-scope-denied-subject.invalid/mcp",
        connection_token: null,
        tools: null,
        configuration_state: {
          github: { __type: "@deco/github", value: target.id },
        },
        configuration_scopes: [],
      });

      vi.spyOn(fetchToolsModule, "fetchToolsFromMCP").mockResolvedValue({
        tools: null,
        scopes: [`github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`],
      });
      vi.spyOn(ctx.access, "check").mockImplementation(
        async (connectionId?: string) => {
          if (connectionId === target.id) {
            throw new Error("denied");
          }
        },
      );

      await expect(
        COLLECTION_CONNECTIONS_UPDATE.execute(
          {
            id: subject.id,
            data: {},
          },
          ctx,
        ),
      ).rejects.toThrow(`Access denied to referenced connection: ${target.id}`);

      await expect(
        ctx.storage.connectionCredentialVault.hasGrant({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
          targetConnectionId: target.id,
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        }),
      ).resolves.toBe(false);
      const unchanged = await ctx.storage.connections.findById(subject.id);
      expect(unchanged?.configuration_scopes).toEqual([]);
    });

    it("keeps an existing active workload token on ordinary configuration updates", async () => {
      const firstTarget = await ctx.storage.connections.create({
        id: "conn_vault_no_rotate_target_1",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault No Rotate Target 1",
        connection_type: "HTTP",
        connection_url: "https://no-rotate-target-1.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      const secondTarget = await ctx.storage.connections.create({
        id: "conn_vault_no_rotate_target_2",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault No Rotate Target 2",
        connection_type: "HTTP",
        connection_url: "https://no-rotate-target-2.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      const subject = await ctx.storage.connections.create({
        id: "conn_vault_no_rotate_subject",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault No Rotate Subject",
        connection_type: "HTTP",
        connection_url: "https://no-rotate-subject.invalid/mcp",
        connection_token: null,
        tools: null,
        configuration_state: {
          github: { __type: "@deco/github", value: firstTarget.id },
        },
        configuration_scopes: [`github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`],
      });
      await ctx.storage.connectionCredentialVault.replaceGrantsForSubject({
        organizationId: "org_123",
        subjectConnectionId: subject.id,
        createdBy: "user_1",
        grants: [
          {
            targetConnectionId: firstTarget.id,
            scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
          },
        ],
      });
      const existingToken =
        await ctx.storage.connectionCredentialVault.createOrRotateWorkloadToken(
          {
            organizationId: "org_123",
            subjectConnectionId: subject.id,
          },
        );

      vi.spyOn(fetchToolsModule, "fetchToolsFromMCP").mockResolvedValue({
        tools: null,
        scopes: null,
      });

      await COLLECTION_CONNECTIONS_UPDATE.execute(
        {
          id: subject.id,
          data: {
            configuration_state: {
              github: { __type: "@deco/github", value: secondTarget.id },
            },
            configuration_scopes: [
              `github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
            ],
          },
        },
        ctx,
      );

      const activeToken =
        await ctx.storage.connectionCredentialVault.findActiveWorkloadToken({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
        });
      expect(activeToken?.id).toBe(existingToken.record.id);
      expect(
        await ctx.storage.connectionCredentialVault.authenticateWorkloadToken(
          existingToken.plaintextToken,
        ),
      ).toMatchObject({
        subjectConnectionId: subject.id,
      });
      await expect(
        ctx.storage.connectionCredentialVault.hasGrant({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
          targetConnectionId: secondTarget.id,
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        }),
      ).resolves.toBe(true);
    });

    it("preserves an existing active token on first-run configuration updates", async () => {
      const target = await ctx.storage.connections.create({
        id: "conn_vault_first_run_existing_token_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault First Run Existing Token Target",
        connection_type: "HTTP",
        connection_url: "https://first-run-existing-token-target.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      const subject = await ctx.storage.connections.create({
        id: "conn_vault_first_run_existing_token_subject",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault First Run Existing Token Subject",
        connection_type: "HTTP",
        connection_url: "https://first-run-existing-token-subject.invalid/mcp",
        connection_token: null,
        tools: null,
        configuration_state: null,
        configuration_scopes: [],
      });
      const existingToken =
        await ctx.storage.connectionCredentialVault.createOrRotateWorkloadToken(
          {
            organizationId: "org_123",
            subjectConnectionId: subject.id,
          },
        );
      const callTool = vi.fn().mockResolvedValue({});
      setMockMcpClient({ callTool });

      vi.spyOn(fetchToolsModule, "fetchToolsFromMCP").mockResolvedValue({
        tools: null,
        scopes: null,
      });

      await COLLECTION_CONNECTIONS_UPDATE.execute(
        {
          id: subject.id,
          data: {
            configuration_state: {
              github: { __type: "@deco/github", value: target.id },
            },
            configuration_scopes: [
              `github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
            ],
          },
        },
        ctx,
      );

      const activeToken =
        await ctx.storage.connectionCredentialVault.findActiveWorkloadToken({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
        });
      expect(activeToken?.id).toBe(existingToken.record.id);
      await expect(
        ctx.storage.connectionCredentialVault.authenticateWorkloadToken(
          existingToken.plaintextToken,
        ),
      ).resolves.toMatchObject({
        subjectConnectionId: subject.id,
      });
      const callback = callTool.mock.calls[0]?.[0];
      expect(callback?.arguments.vault).toBeUndefined();
    });

    it("revokes a newly created workload token and restores config when bootstrap callback fails", async () => {
      const previousTarget = await ctx.storage.connections.create({
        id: "conn_vault_callback_rollback_previous_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Callback Rollback Previous Target",
        connection_type: "HTTP",
        connection_url: "https://callback-rollback-previous-target.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      const subject = await ctx.storage.connections.create({
        id: "conn_vault_callback_rollback_subject",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Callback Rollback Subject",
        connection_type: "HTTP",
        connection_url: "https://callback-rollback-subject.invalid/mcp",
        connection_token: null,
        tools: null,
        configuration_state: {
          previous: { value: previousTarget.id },
        },
        configuration_scopes: [
          `previous::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
        ],
      });
      const target = await ctx.storage.connections.create({
        id: "conn_vault_callback_rollback_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Callback Rollback Target",
        connection_type: "HTTP",
        connection_url: "https://callback-rollback-target.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      await ctx.storage.connectionCredentialVault.replaceGrantsForSubject({
        organizationId: "org_123",
        subjectConnectionId: subject.id,
        createdBy: "user_1",
        grants: [
          {
            targetConnectionId: previousTarget.id,
            scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
          },
        ],
      });

      vi.spyOn(fetchToolsModule, "fetchToolsFromMCP").mockResolvedValue({
        tools: null,
        scopes: null,
      });
      setMockMcpClient({
        callTool: vi.fn().mockRejectedValue(new Error("callback unavailable")),
      });

      await expect(
        COLLECTION_CONNECTIONS_UPDATE.execute(
          {
            id: subject.id,
            data: {
              configuration_state: {
                github: { __type: "@deco/github", value: target.id },
              },
              configuration_scopes: [
                `github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
              ],
            },
          },
          ctx,
        ),
      ).rejects.toThrow("callback unavailable");

      const restored = await ctx.storage.connections.findById(subject.id);
      expect(restored?.configuration_state).toEqual({
        previous: { value: previousTarget.id },
      });
      expect(restored?.configuration_scopes).toEqual([
        `previous::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
      ]);
      await expect(
        ctx.storage.connectionCredentialVault.findActiveWorkloadToken({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
        }),
      ).resolves.toBeNull();
      await expect(
        ctx.storage.connectionCredentialVault.hasGrant({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
          targetConnectionId: previousTarget.id,
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        }),
      ).resolves.toBe(true);
      await expect(
        ctx.storage.connectionCredentialVault.hasGrant({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
          targetConnectionId: target.id,
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        }),
      ).resolves.toBe(false);
    });

    it("restores non-configuration fields when bootstrap callback fails", async () => {
      const previousTarget = await ctx.storage.connections.create({
        id: "conn_vault_full_rollback_previous_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Full Rollback Previous Target",
        connection_type: "HTTP",
        connection_url: "https://full-rollback-previous-target.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      const subject = await ctx.storage.connections.create({
        id: "conn_vault_full_rollback_subject",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Full Rollback Subject",
        connection_type: "HTTP",
        connection_url: "https://full-rollback-subject.invalid/mcp",
        connection_token: null,
        tools: null,
        configuration_state: {
          previous: { value: previousTarget.id },
        },
        configuration_scopes: [
          `previous::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
        ],
      });
      const target = await ctx.storage.connections.create({
        id: "conn_vault_full_rollback_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Full Rollback Target",
        connection_type: "HTTP",
        connection_url: "https://full-rollback-target.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      await ctx.storage.connectionCredentialVault.replaceGrantsForSubject({
        organizationId: "org_123",
        subjectConnectionId: subject.id,
        createdBy: "user_1",
        grants: [
          {
            targetConnectionId: previousTarget.id,
            scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
          },
        ],
      });

      vi.spyOn(fetchToolsModule, "fetchToolsFromMCP").mockResolvedValue({
        tools: null,
        scopes: null,
      });
      setMockMcpClient({
        callTool: vi.fn().mockRejectedValue(new Error("callback unavailable")),
      });

      await expect(
        COLLECTION_CONNECTIONS_UPDATE.execute(
          {
            id: subject.id,
            data: {
              title: "Changed But Rolled Back",
              connection_url: "https://changed-full-rollback.invalid/mcp",
              configuration_state: {
                github: { __type: "@deco/github", value: target.id },
              },
              configuration_scopes: [
                `github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
              ],
            },
          },
          ctx,
        ),
      ).rejects.toThrow("callback unavailable");

      const restored = await ctx.storage.connections.findById(subject.id);
      expect(restored?.title).toBe("Vault Full Rollback Subject");
      expect(restored?.connection_url).toBe(
        "https://full-rollback-subject.invalid/mcp",
      );
      expect(restored?.configuration_state).toEqual({
        previous: { value: previousTarget.id },
      });
      expect(restored?.configuration_scopes).toEqual([
        `previous::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
      ]);
    });

    it("restores grants and revokes a new token when the final connection update fails", async () => {
      const previousTarget = await ctx.storage.connections.create({
        id: "conn_vault_final_update_previous_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Final Update Previous Target",
        connection_type: "HTTP",
        connection_url: "https://final-update-previous-target.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      const subject = await ctx.storage.connections.create({
        id: "conn_vault_final_update_subject",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Final Update Subject",
        connection_type: "HTTP",
        connection_url: "https://final-update-subject.invalid/mcp",
        connection_token: null,
        tools: null,
        configuration_state: {
          previous: { value: previousTarget.id },
        },
        configuration_scopes: [
          `previous::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
        ],
      });
      const target = await ctx.storage.connections.create({
        id: "conn_vault_final_update_target",
        organization_id: "org_123",
        created_by: "user_1",
        title: "Vault Final Update Target",
        connection_type: "HTTP",
        connection_url: "https://final-update-target.invalid/mcp",
        connection_token: null,
        tools: null,
      });
      await ctx.storage.connectionCredentialVault.replaceGrantsForSubject({
        organizationId: "org_123",
        subjectConnectionId: subject.id,
        createdBy: "user_1",
        grants: [
          {
            targetConnectionId: previousTarget.id,
            scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
          },
        ],
      });

      vi.spyOn(fetchToolsModule, "fetchToolsFromMCP").mockResolvedValue({
        tools: null,
        scopes: null,
      });
      setMockMcpClient({
        callTool: vi.fn().mockResolvedValue({}),
      });
      vi.spyOn(ctx.storage.connections, "update").mockRejectedValueOnce(
        new Error("db write failed"),
      );

      await expect(
        COLLECTION_CONNECTIONS_UPDATE.execute(
          {
            id: subject.id,
            data: {
              title: "Changed But Not Persisted",
              configuration_state: {
                github: { __type: "@deco/github", value: target.id },
              },
              configuration_scopes: [
                `github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
              ],
            },
          },
          ctx,
        ),
      ).rejects.toThrow("db write failed");

      const restored = await ctx.storage.connections.findById(subject.id);
      expect(restored?.title).toBe("Vault Final Update Subject");
      expect(restored?.configuration_state).toEqual({
        previous: { value: previousTarget.id },
      });
      await expect(
        ctx.storage.connectionCredentialVault.findActiveWorkloadToken({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
        }),
      ).resolves.toBeNull();
      await expect(
        ctx.storage.connectionCredentialVault.hasGrant({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
          targetConnectionId: previousTarget.id,
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        }),
      ).resolves.toBe(true);
      await expect(
        ctx.storage.connectionCredentialVault.hasGrant({
          organizationId: "org_123",
          subjectConnectionId: subject.id,
          targetConnectionId: target.id,
          scope: CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
        }),
      ).resolves.toBe(false);
    });
  });

  describe("COLLECTION_CONNECTIONS_LIST", () => {
    it("should list all connections in organization", async () => {
      const result = await COLLECTION_CONNECTIONS_LIST.execute({}, ctx);

      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.every((c) => c.organization_id === "org_123")).toBe(
        true,
      );
    });

    it("should include connection details", async () => {
      const result = await COLLECTION_CONNECTIONS_LIST.execute({}, ctx);

      const conn = result.items[0];
      expect(conn).toHaveProperty("id");
      expect(conn).toHaveProperty("title");
      expect(conn).toHaveProperty("organization_id");
      expect(conn).toHaveProperty("connection_type");
      expect(conn).toHaveProperty("connection_url");
      expect(conn).toHaveProperty("status");
    });
  });

  describe("COLLECTION_CONNECTIONS_GET", () => {
    it("should get connection by ID", async () => {
      const created = await COLLECTION_CONNECTIONS_CREATE.execute(
        {
          data: {
            title: "Get Test",
            connection_type: "HTTP",
            connection_url: "https://test.com",
          },
        },
        ctx,
      );

      const result = await COLLECTION_CONNECTIONS_GET.execute(
        {
          id: created.item.id,
        },
        ctx,
      );

      expect(result.item?.id).toBe(created.item.id);
      expect(result.item?.title).toBe("Get Test");
    });

    it("should return null when connection not found", async () => {
      const result = await COLLECTION_CONNECTIONS_GET.execute(
        {
          id: "conn_nonexistent",
        },
        ctx,
      );

      expect(result.item).toBeNull();
    });
  });

  describe("COLLECTION_CONNECTIONS_DELETE", () => {
    // Delete test removed - was timing out due to network calls
  });

  describe("CONNECTION_TEST", () => {
    it("should test connection health", async () => {
      const created = await COLLECTION_CONNECTIONS_CREATE.execute(
        {
          data: {
            title: "Test Health",
            connection_type: "HTTP",
            connection_url: "https://this-will-fail.invalid",
          },
        },
        ctx,
      );

      const result = await CONNECTION_TEST.execute(
        {
          id: created.item.id,
        },
        ctx,
      );

      expect(result.id).toBe(created.item.id);
      expect(result).toHaveProperty("healthy");
      expect(result).toHaveProperty("latencyMs");
      expect(typeof result.latencyMs).toBe("number");
    });

    it("should throw when connection not found", async () => {
      await expect(
        CONNECTION_TEST.execute(
          {
            id: "conn_nonexistent",
          },
          ctx,
        ),
      ).rejects.toThrow("Connection not found");
    });
  });
});
