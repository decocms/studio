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
  createTestDatabase,
  closeTestDatabase,
  type TestDatabase,
} from "../database/test-db";
import {
  createTestSchema,
  seedCommonTestFixtures,
} from "../storage/test-helpers";
import { CredentialVault } from "../encryption/credential-vault";
import { DownstreamTokenStorage } from "../storage/downstream-token";
import { ConnectionStorage } from "../storage/connection";
import type { TokenRefreshResult } from "./refresh-access-token";

const mockRefreshAccessToken =
  vi.fn<(...args: unknown[]) => Promise<TokenRefreshResult>>();
mock.module("./refresh-access-token", () => ({
  refreshAccessToken: mockRefreshAccessToken,
}));

const { refreshAndStore } = await import("./token-refresh");

describe("refreshAndStore", () => {
  let database: TestDatabase;
  let vault: CredentialVault;
  let tokenStorage: DownstreamTokenStorage;
  const connectionId = "conn_refresh_test";

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
  });

  afterAll(async () => {
    await closeTestDatabase(database);
  });

  beforeEach(async () => {
    mockRefreshAccessToken.mockReset();
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
});
