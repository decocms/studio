import {
  describe,
  it,
  expect,
  vi,
  mock,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { CredentialVault } from "../encryption/credential-vault";
import { DownstreamTokenStorage } from "../storage/downstream-token";
import { ConnectionStorage } from "../storage/connection";
import type { TokenRefreshResult } from "./refresh-access-token";
import type { DownstreamToken } from "../storage/types";

// Narrow justified mock per TESTING.md: refreshAccessToken makes a real
// HTTP call to a third-party OAuth token endpoint we can't wire up in
// tests. The DB side uses real Postgres.
const mockRefreshAccessToken =
  vi.fn<(...args: unknown[]) => Promise<TokenRefreshResult>>();
mock.module("./refresh-access-token", () => ({
  refreshAccessToken: mockRefreshAccessToken,
}));

// resolveOriginTokenEndpoint makes real metadata HTTP calls to the origin we
// can't wire up in tests; mock it to assert the re-resolution wiring.
const mockResolveOriginTokenEndpoint =
  vi.fn<(url: string) => Promise<string | null>>();
mock.module("./resolve-token-endpoint", () => ({
  resolveOriginTokenEndpoint: mockResolveOriginTokenEndpoint,
}));

const { refreshAndStore, clearRefreshBackoff } = await import(
  "./token-refresh"
);

let database: StudioDatabase;
let vault: CredentialVault;
let tokenStorage: DownstreamTokenStorage;
const connectionId = "conn_refresh_test";

beforeAll(async () => {
  database = await connectTestPgDatabase();
  await resetTestPgDatabase(database);
  await seedCommonTestPgFixtures(database);
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
});

afterAll(async () => {
  await closeTestPgDatabase(database);
});

beforeEach(async () => {
  mockRefreshAccessToken.mockReset();
  mockResolveOriginTokenEndpoint.mockReset();
  clearRefreshBackoff();
  await tokenStorage.delete(connectionId);
  await tokenStorage.upsert({
    connectionId,
    accessToken: "stale",
    refreshToken: "rt",
    scope: "repo",
    expiresAt: new Date(Date.now() - 1000),
    clientId: "cid",
    clientSecret: null,
    tokenEndpoint: "https://example.com/token",
  });
});

describe("refreshAndStore", () => {
  it("preserves the cached token on transient (5xx) failures", async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      success: false,
      permanent: false,
      status: 500,
      errorCode: "server_error",
      error: "Failed to process token request",
    });

    const token = await tokenStorage.get(connectionId);
    expect(token).not.toBeNull();
    const result = await refreshAndStore(token!, tokenStorage);

    expect(result).toBeNull();
    const after = await tokenStorage.get(connectionId);
    expect(after).not.toBeNull();
    expect(after?.refreshToken).toBe("rt");
  });

  it("deletes the cached token on permanent (400 invalid_grant) failure", async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      success: false,
      permanent: true,
      status: 400,
      errorCode: "invalid_grant",
      error: "refresh token revoked",
    });

    const token = await tokenStorage.get(connectionId);
    expect(token).not.toBeNull();
    const result = await refreshAndStore(token!, tokenStorage);

    expect(result).toBeNull();
    expect(await tokenStorage.get(connectionId)).toBeNull();
  });

  it("preserves the cached token when refresh result lacks the permanent flag (defensive: legacy callers)", async () => {
    // Older code paths or unmocked-in-prod callers might forget to set
    // `permanent`. Default behavior must be "preserve" so we don't
    // regress to the old delete-on-anything bug.
    mockRefreshAccessToken.mockResolvedValueOnce({
      success: false,
      error: "something broke",
    });

    const token = await tokenStorage.get(connectionId);
    const result = await refreshAndStore(token!, tokenStorage);

    expect(result).toBeNull();
    expect(await tokenStorage.get(connectionId)).not.toBeNull();
  });

  it("stores the refreshed token on success", async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      success: true,
      accessToken: "fresh",
      refreshToken: "rt2",
      expiresIn: 3600,
      scope: "repo",
    });

    const token = await tokenStorage.get(connectionId);
    const result = await refreshAndStore(token!, tokenStorage);

    expect(result).toBe("fresh");
    const after = await tokenStorage.get(connectionId);
    expect(after?.accessToken).toBe("fresh");
    expect(after?.refreshToken).toBe("rt2");
  });

  it("collapses concurrent refreshes for the same connection", async () => {
    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      mockRefreshAccessToken.mockImplementationOnce(
        () =>
          new Promise<TokenRefreshResult>((resolveRefresh) => {
            resolve();
            releaseRefresh = () =>
              resolveRefresh({
                success: true,
                accessToken: "fresh-single-flight",
                refreshToken: "rt-single-flight",
                expiresIn: 3600,
                scope: "repo",
              });
          }),
      );
    });

    const token = await tokenStorage.get(connectionId);
    expect(token).not.toBeNull();

    const first = refreshAndStore(token!, tokenStorage);
    await refreshStarted;
    const second = refreshAndStore(token!, tokenStorage);
    expect(first).toBe(second);
    releaseRefresh();

    await expect(first).resolves.toBe("fresh-single-flight");
    await expect(second).resolves.toBe("fresh-single-flight");
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it("suppresses a re-attempt after a failure (backoff window)", async () => {
    // First sequential call fails transiently → opens a backoff window.
    mockRefreshAccessToken.mockResolvedValueOnce({
      success: false,
      permanent: false,
      status: 525,
      error: "Origin SSL handshake failed",
    });

    const token = await tokenStorage.get(connectionId);
    expect(await refreshAndStore(token!, tokenStorage)).toBeNull();
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);

    // Second sequential call within the window must NOT hit the endpoint.
    expect(await refreshAndStore(token!, tokenStorage)).toBeNull();
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it("re-attempts once the backoff window is cleared", async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      success: false,
      permanent: false,
      status: 525,
      error: "Origin SSL handshake failed",
    });
    const token = await tokenStorage.get(connectionId);
    await refreshAndStore(token!, tokenStorage);
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);

    // Simulate the window elapsing (or a manual reconnect clearing it).
    clearRefreshBackoff(connectionId);

    mockRefreshAccessToken.mockResolvedValueOnce({
      success: true,
      accessToken: "fresh-after-backoff",
      refreshToken: "rt",
      expiresIn: 3600,
      scope: "repo",
    });
    expect(await refreshAndStore(token!, tokenStorage)).toBe(
      "fresh-after-backoff",
    );
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(2);
  });

  it("clears the backoff window after a successful refresh", async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      success: false,
      permanent: false,
      status: 525,
      error: "Origin SSL handshake failed",
    });
    const token = await tokenStorage.get(connectionId);
    await refreshAndStore(token!, tokenStorage);

    clearRefreshBackoff(connectionId);
    mockRefreshAccessToken.mockResolvedValueOnce({
      success: true,
      accessToken: "fresh",
      refreshToken: "rt",
      expiresIn: 3600,
      scope: "repo",
    });
    await refreshAndStore(token!, tokenStorage);

    // A subsequent failure should be allowed to hit the endpoint immediately
    // (the prior success reset the attempt counter / window).
    mockRefreshAccessToken.mockResolvedValueOnce({
      success: false,
      permanent: false,
      status: 525,
      error: "Origin SSL handshake failed",
    });
    const after = await tokenStorage.get(connectionId);
    expect(await refreshAndStore(after!, tokenStorage)).toBeNull();
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(3);
  });

  it("does not let a dead token's backoff throttle a freshly reconnected one", async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      success: false,
      permanent: true,
      status: 400,
      errorCode: "invalid_grant",
      error: "refresh token revoked",
    });

    const token = await tokenStorage.get(connectionId);
    expect(await refreshAndStore(token!, tokenStorage)).toBeNull();
    expect(await tokenStorage.get(connectionId)).toBeNull();

    // Manual reconnect stores a brand new token for the same connection.
    await tokenStorage.upsert({
      connectionId,
      accessToken: "reconnected",
      refreshToken: "rt-new",
      scope: "repo",
      expiresAt: new Date(Date.now() - 1000),
      clientId: "cid",
      clientSecret: null,
      tokenEndpoint: "https://example.com/token",
    });

    mockRefreshAccessToken.mockResolvedValueOnce({
      success: true,
      accessToken: "fresh",
      refreshToken: "rt-new",
      expiresIn: 3600,
      scope: "repo",
    });
    const reconnected = await tokenStorage.get(connectionId);
    expect(await refreshAndStore(reconnected!, tokenStorage)).toBe("fresh");
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(2);
  });
});

const { getValidDownstreamAccessToken } = await import("./token-refresh");

describe("getValidDownstreamAccessToken", () => {
  it("returns a cached valid token without refreshing", async () => {
    await tokenStorage.delete(connectionId);
    await tokenStorage.upsert({
      connectionId,
      accessToken: "valid",
      refreshToken: "rt",
      scope: "repo",
      expiresAt: new Date(Date.now() + 3600_000),
      clientId: "cid",
      clientSecret: null,
      tokenEndpoint: "https://example.com/token",
    });

    const result = await getValidDownstreamAccessToken({
      connectionId,
      tokenStorage,
    });

    expect(result).toEqual({ state: "valid", accessToken: "valid" });
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });

  it("deletes expired tokens that cannot refresh", async () => {
    await tokenStorage.delete(connectionId);
    await tokenStorage.upsert({
      connectionId,
      accessToken: "expired",
      refreshToken: null,
      scope: null,
      expiresAt: new Date(Date.now() - 1000),
      clientId: null,
      clientSecret: null,
      tokenEndpoint: null,
    });

    const result = await getValidDownstreamAccessToken({
      connectionId,
      tokenStorage,
    });

    expect(result).toEqual({
      state: "expired_without_refresh",
      accessToken: null,
    });
    expect(await tokenStorage.get(connectionId)).toBeNull();
  });

  it("re-resolves a stale-host token endpoint and self-heals the stored row", async () => {
    // Captured at authorize time against the canonical `*.decocache.com` host,
    // which now 525s; the connection lives on the working `*.deco.site` alias.
    await tokenStorage.delete(connectionId);
    await tokenStorage.upsert({
      connectionId,
      accessToken: "stale",
      refreshToken: "rt",
      scope: "repo",
      expiresAt: new Date(Date.now() - 1000),
      clientId: "cid",
      clientSecret: null,
      tokenEndpoint: "https://sites-google-calendar.decocache.com/token",
    });
    mockResolveOriginTokenEndpoint.mockResolvedValueOnce(
      "https://sites-google-calendar.deco.site/token",
    );
    mockRefreshAccessToken.mockResolvedValueOnce({
      success: true,
      accessToken: "fresh",
      refreshToken: "rt",
      expiresIn: 3600,
      scope: "repo",
    });

    const result = await getValidDownstreamAccessToken({
      connectionId,
      connectionUrl: "https://sites-google-calendar.deco.site/mcp",
      tokenStorage,
    });

    expect(result).toEqual({ state: "refreshed", accessToken: "fresh" });
    expect(mockResolveOriginTokenEndpoint).toHaveBeenCalledWith(
      "https://sites-google-calendar.deco.site/mcp",
    );
    // Refreshed against the re-resolved endpoint, not the stale one.
    expect(
      (mockRefreshAccessToken.mock.calls[0]![0] as DownstreamToken)
        .tokenEndpoint,
    ).toBe("https://sites-google-calendar.deco.site/token");
    // Self-heal: the persisted endpoint is the good one.
    expect((await tokenStorage.get(connectionId))?.tokenEndpoint).toBe(
      "https://sites-google-calendar.deco.site/token",
    );
  });

  it("does not re-resolve when the stored endpoint host matches the connection", async () => {
    await tokenStorage.delete(connectionId);
    await tokenStorage.upsert({
      connectionId,
      accessToken: "stale",
      refreshToken: "rt",
      scope: "repo",
      expiresAt: new Date(Date.now() - 1000),
      clientId: "cid",
      clientSecret: null,
      tokenEndpoint: "https://sites-google-calendar.deco.site/token",
    });
    mockRefreshAccessToken.mockResolvedValueOnce({
      success: true,
      accessToken: "fresh",
      refreshToken: "rt",
      expiresIn: 3600,
      scope: "repo",
    });

    await getValidDownstreamAccessToken({
      connectionId,
      connectionUrl: "https://sites-google-calendar.deco.site/mcp",
      tokenStorage,
    });

    expect(mockResolveOriginTokenEndpoint).not.toHaveBeenCalled();
  });
});
