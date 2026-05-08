import {
  describe,
  it,
  expect,
  vi,
  mock,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import {
  createTestDatabase,
  closeTestDatabase,
  type TestDatabase,
} from "../../database/test-db";
import {
  createTestSchema,
  seedCommonTestFixtures,
} from "../../storage/test-helpers";
import { CredentialVault } from "../../encryption/credential-vault";
import { DownstreamTokenStorage } from "../../storage/downstream-token";
import { ConnectionStorage } from "../../storage/connection";
import type { BoundAuthClient, MeshContext } from "../../core/mesh-context";
import type { EventBus } from "../../event-bus/interface";
import type { TokenRefreshResult } from "@/oauth/refresh-access-token";

const mockRefreshAccessToken =
  vi.fn<
    (
      ...args: Parameters<
        typeof import("@/oauth/refresh-access-token").refreshAccessToken
      >
    ) => Promise<TokenRefreshResult>
  >();
mock.module("@/oauth/refresh-access-token", () => ({
  refreshAccessToken: mockRefreshAccessToken,
}));

const { GITHUB_LIST_USER_ORGS } = await import("./list-user-orgs");

const createMockBoundAuth = (): BoundAuthClient =>
  ({
    hasPermission: vi.fn().mockResolvedValue(true),
  }) as unknown as BoundAuthClient;

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

type FetchResponder = (call: FetchCall) => Response | Promise<Response>;

describe("GITHUB_LIST_USER_ORGS", () => {
  let database: TestDatabase;
  let ctx: MeshContext;
  let vault: CredentialVault;
  let tokenStorage: DownstreamTokenStorage;
  const connectionId = "conn_github_test";
  const originalFetch = globalThis.fetch;
  let fetchCalls: FetchCall[] = [];

  const installHandler = (
    ...responders: FetchResponder[]
  ): Array<() => void> => {
    const queue = [...responders];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers: Record<string, string> = {};
      const rawHeaders = init?.headers as
        | Record<string, string>
        | Headers
        | undefined;
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (rawHeaders) {
        for (const [k, v] of Object.entries(rawHeaders)) {
          headers[k.toLowerCase()] = v;
        }
      }
      const call = { url, headers };
      fetchCalls.push(call);
      const responder = queue.shift();
      if (!responder) {
        throw new Error(`Unexpected fetch to ${url} — no responder queued`);
      }
      return await responder(call);
    }) as typeof globalThis.fetch;
    return [() => (globalThis.fetch = originalFetch)];
  };

  const githubOkResponse = (installations: unknown[]) =>
    new Response(
      JSON.stringify({ installations, total_count: installations.length }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  const github401 = () =>
    new Response(JSON.stringify({ message: "Bad credentials" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });

  beforeAll(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);

    vault = new CredentialVault(CredentialVault.generateKey());
    tokenStorage = new DownstreamTokenStorage(database.db, vault);

    const connectionStorage = new ConnectionStorage(database.db, vault);
    await connectionStorage.create({
      id: connectionId,
      organization_id: "org_123",
      created_by: "user_1",
      title: "GitHub",
      connection_type: "HTTP",
      connection_url: "https://mcp.example.com/github",
      connection_token: null,
      tools: null,
    });

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
      storage: {} as never,
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
      baseUrl: "https://mesh.example.com",
      metadata: {
        requestId: "req_123",
        timestamp: new Date(),
      },
      eventBus: {} as EventBus,
      objectStorage: null as never,
      aiProviders: null as never,
      createMCPProxy: vi.fn().mockResolvedValue({}),
      getOrCreateClient: vi.fn().mockResolvedValue({}),
      pendingRevalidations: [],
    };
  });

  afterAll(async () => {
    await closeTestDatabase(database);
    globalThis.fetch = originalFetch;
  });

  beforeEach(async () => {
    fetchCalls = [];
    mockRefreshAccessToken.mockReset();
    await tokenStorage.delete(connectionId);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns installations on happy path with valid token", async () => {
    await tokenStorage.upsert({
      connectionId,
      accessToken: "valid-token",
      refreshToken: "rt",
      scope: "repo",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      clientId: "cid",
      clientSecret: "csecret",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
    });

    installHandler(() =>
      githubOkResponse([
        {
          id: 42,
          account: {
            login: "octocat",
            avatar_url: "https://example.com/a.png",
            type: "User",
          },
          app_slug: "mcp-github",
        },
      ]),
    );

    const result = await GITHUB_LIST_USER_ORGS.execute({ connectionId }, ctx);

    expect(result.installations).toEqual([
      {
        installationId: 42,
        login: "octocat",
        avatarUrl: "https://example.com/a.png",
        type: "User",
      },
    ]);
    expect(result.appSlug).toBe("mcp-github");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.headers["authorization"]).toBe("Bearer valid-token");
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });

  it("proactively refreshes an expired token before fetching", async () => {
    await tokenStorage.upsert({
      connectionId,
      accessToken: "stale-token",
      refreshToken: "rt",
      scope: "repo",
      expiresAt: new Date(Date.now() - 60 * 1000),
      clientId: "cid",
      clientSecret: "csecret",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
    });

    mockRefreshAccessToken.mockResolvedValueOnce({
      success: true,
      accessToken: "fresh-token",
      refreshToken: "rt2",
      expiresIn: 3600,
      scope: "repo",
    });

    installHandler(() => githubOkResponse([]));

    const result = await GITHUB_LIST_USER_ORGS.execute({ connectionId }, ctx);

    expect(result.installations).toEqual([]);
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.headers["authorization"]).toBe("Bearer fresh-token");

    const persisted = await tokenStorage.get(connectionId);
    expect(persisted?.accessToken).toBe("fresh-token");
    expect(persisted?.refreshToken).toBe("rt2");
  });

  it("deletes the cached token and throws when proactive refresh fails permanently (invalid_grant)", async () => {
    await tokenStorage.upsert({
      connectionId,
      accessToken: "stale-token",
      refreshToken: "rt",
      scope: "repo",
      expiresAt: new Date(Date.now() - 60 * 1000),
      clientId: "cid",
      clientSecret: "csecret",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
    });

    mockRefreshAccessToken.mockResolvedValueOnce({
      success: false,
      permanent: true,
      status: 400,
      errorCode: "invalid_grant",
      error: "refresh token revoked",
    });

    installHandler();

    await expect(
      GITHUB_LIST_USER_ORGS.execute({ connectionId }, ctx),
    ).rejects.toThrow(/reconnect/i);

    expect(await tokenStorage.get(connectionId)).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  it("preserves the cached token and throws when proactive refresh fails transiently (5xx)", async () => {
    // The whole point of the fix: a 500 from the OAuth server must not
    // wipe the user's auth — the refresh_token might still be valid.
    await tokenStorage.upsert({
      connectionId,
      accessToken: "stale-token",
      refreshToken: "rt",
      scope: "repo",
      expiresAt: new Date(Date.now() - 60 * 1000),
      clientId: "cid",
      clientSecret: "csecret",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
    });

    mockRefreshAccessToken.mockResolvedValueOnce({
      success: false,
      permanent: false,
      status: 500,
      errorCode: "server_error",
      error: "Failed to process token request",
    });

    installHandler();

    await expect(
      GITHUB_LIST_USER_ORGS.execute({ connectionId }, ctx),
    ).rejects.toThrow(/reconnect/i);

    const persisted = await tokenStorage.get(connectionId);
    expect(persisted).not.toBeNull();
    expect(persisted?.refreshToken).toBe("rt");
    expect(fetchCalls).toHaveLength(0);
  });

  it("reactively refreshes on 401 from GitHub and retries once", async () => {
    await tokenStorage.upsert({
      connectionId,
      accessToken: "seemingly-valid-token",
      refreshToken: "rt",
      scope: "repo",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      clientId: "cid",
      clientSecret: "csecret",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
    });

    mockRefreshAccessToken.mockResolvedValueOnce({
      success: true,
      accessToken: "fresh-token",
      refreshToken: "rt2",
      expiresIn: 3600,
      scope: "repo",
    });

    installHandler(
      () => github401(),
      () =>
        githubOkResponse([
          {
            id: 7,
            account: {
              login: "acme",
              avatar_url: "https://example.com/b.png",
              type: "Organization",
            },
            app_slug: "mcp-github",
          },
        ]),
    );

    const result = await GITHUB_LIST_USER_ORGS.execute({ connectionId }, ctx);

    expect(result.installations).toHaveLength(1);
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]?.headers["authorization"]).toBe(
      "Bearer seemingly-valid-token",
    );
    expect(fetchCalls[1]?.headers["authorization"]).toBe("Bearer fresh-token");

    const persisted = await tokenStorage.get(connectionId);
    expect(persisted?.accessToken).toBe("fresh-token");
  });

  it("throws reconnect error without deleting the row when retry after 401 still 401s", async () => {
    // The refresh succeeded, so the refresh_token is fine. Even if GitHub
    // keeps returning 401 with the new access_token, deleting the cached
    // row would lose the (still-valid) refresh_token. Throw the reconnect
    // error so the user re-OAuths, which will overwrite the row anyway.
    await tokenStorage.upsert({
      connectionId,
      accessToken: "seemingly-valid-token",
      refreshToken: "rt",
      scope: "repo",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      clientId: "cid",
      clientSecret: "csecret",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
    });

    mockRefreshAccessToken.mockResolvedValueOnce({
      success: true,
      accessToken: "fresh-token",
      refreshToken: "rt2",
      expiresIn: 3600,
      scope: "repo",
    });

    installHandler(
      () => github401(),
      () => github401(),
    );

    await expect(
      GITHUB_LIST_USER_ORGS.execute({ connectionId }, ctx),
    ).rejects.toThrow(/reconnect/i);

    expect(fetchCalls).toHaveLength(2);
    const persisted = await tokenStorage.get(connectionId);
    expect(persisted).not.toBeNull();
    expect(persisted?.accessToken).toBe("fresh-token");
  });

  it("deletes the token and throws when reactive refresh fails permanently", async () => {
    await tokenStorage.upsert({
      connectionId,
      accessToken: "seemingly-valid-token",
      refreshToken: "rt",
      scope: "repo",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      clientId: "cid",
      clientSecret: "csecret",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
    });

    mockRefreshAccessToken.mockResolvedValueOnce({
      success: false,
      permanent: true,
      status: 400,
      errorCode: "invalid_grant",
      error: "refresh token revoked",
    });

    installHandler(() => github401());

    await expect(
      GITHUB_LIST_USER_ORGS.execute({ connectionId }, ctx),
    ).rejects.toThrow(/reconnect/i);

    expect(fetchCalls).toHaveLength(1);
    expect(await tokenStorage.get(connectionId)).toBeNull();
  });

  it("preserves the cached token when reactive refresh fails transiently", async () => {
    // GitHub returned 401 (current access_token is bad), but the OAuth
    // server's refresh endpoint returned a 5xx. The refresh_token may still
    // be valid — keep it so the next request can try to refresh again.
    await tokenStorage.upsert({
      connectionId,
      accessToken: "seemingly-valid-token",
      refreshToken: "rt",
      scope: "repo",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      clientId: "cid",
      clientSecret: "csecret",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
    });

    mockRefreshAccessToken.mockResolvedValueOnce({
      success: false,
      permanent: false,
      status: 500,
      errorCode: "server_error",
      error: "Failed to process token request",
    });

    installHandler(() => github401());

    await expect(
      GITHUB_LIST_USER_ORGS.execute({ connectionId }, ctx),
    ).rejects.toThrow(/reconnect/i);

    expect(fetchCalls).toHaveLength(1);
    const persisted = await tokenStorage.get(connectionId);
    expect(persisted).not.toBeNull();
    expect(persisted?.refreshToken).toBe("rt");
  });

  it("throws a clear error when no GitHub token is stored", async () => {
    installHandler();

    await expect(
      GITHUB_LIST_USER_ORGS.execute({ connectionId }, ctx),
    ).rejects.toThrow(/No GitHub token found/i);

    expect(fetchCalls).toHaveLength(0);
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });

  it("still propagates non-401 GitHub errors", async () => {
    await tokenStorage.upsert({
      connectionId,
      accessToken: "valid-token",
      refreshToken: "rt",
      scope: "repo",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      clientId: "cid",
      clientSecret: "csecret",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
    });

    installHandler(
      () =>
        new Response(JSON.stringify({ message: "Server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(
      GITHUB_LIST_USER_ORGS.execute({ connectionId }, ctx),
    ).rejects.toThrow(/500/);

    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });

  it("reactively refreshes on 401 that surfaces on a later page", async () => {
    await tokenStorage.upsert({
      connectionId,
      accessToken: "seemingly-valid-token",
      refreshToken: "rt",
      scope: "repo",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      clientId: "cid",
      clientSecret: "csecret",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
    });

    mockRefreshAccessToken.mockResolvedValueOnce({
      success: true,
      accessToken: "fresh-token",
      refreshToken: "rt2",
      expiresIn: 3600,
      scope: "repo",
    });

    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      account: {
        login: `org-${i + 1}`,
        avatar_url: `https://example.com/${i + 1}.png`,
        type: "Organization",
      },
      app_slug: "mcp-github",
    }));

    installHandler(
      () => githubOkResponse(fullPage),
      () => github401(),
      () =>
        githubOkResponse([
          {
            id: 101,
            account: {
              login: "late",
              avatar_url: "https://example.com/late.png",
              type: "Organization",
            },
            app_slug: "mcp-github",
          },
        ]),
    );

    const result = await GITHUB_LIST_USER_ORGS.execute({ connectionId }, ctx);

    expect(result.installations).toHaveLength(101);
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(3);
    expect(fetchCalls[0]?.headers["authorization"]).toBe(
      "Bearer seemingly-valid-token",
    );
    expect(fetchCalls[1]?.headers["authorization"]).toBe(
      "Bearer seemingly-valid-token",
    );
    expect(fetchCalls[2]?.headers["authorization"]).toBe("Bearer fresh-token");
    expect(fetchCalls[1]?.url).toContain("page=2");
    expect(fetchCalls[2]?.url).toContain("page=2");
  });
});
