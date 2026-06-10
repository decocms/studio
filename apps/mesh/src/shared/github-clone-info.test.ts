import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { StudioContext } from "../core/studio-context";
import type { DownstreamToken } from "../storage/types";
import { GITHUB_SCOPED_PERMISSIONS } from "./github-repo-scope";

const mockEnsureRepoScopedToken = mock(async () => "ghs_fresh_minted");
const mockTokenGet = mock(async (): Promise<DownstreamToken | null> => null);
const mockRefreshAndStore = mock(async () => "ghu_refreshed");

mock.module("../oauth/github-mint", () => ({
  ensureRepoScopedToken: mockEnsureRepoScopedToken,
}));

mock.module("../oauth/token-refresh", () => ({
  PROACTIVE_REFRESH_BUFFER_MS: 5 * 60 * 1000,
  RECONNECT_ERROR:
    "GitHub token refresh failed — reconnect the mcp-github integration.",
  canRefresh: (token: DownstreamToken) =>
    !!token.refreshToken && !!token.tokenEndpoint && !!token.clientId,
  refreshAndStore: mockRefreshAndStore,
}));

const { DownstreamTokenStorage: RealDownstreamTokenStorage } = await import(
  "../storage/downstream-token"
);

mock.module("../storage/downstream-token", () => ({
  DownstreamTokenStorage: class MockDownstreamTokenStorage extends RealDownstreamTokenStorage {
    override async get(connectionId: string) {
      return mockTokenGet(connectionId);
    }
  },
}));

const { resolveGitHubAccessToken } = await import("./github-clone-info");

function makeRepoScopedCtx(): StudioContext {
  return {
    organization: { id: "org_1", slug: "test", name: "Test" },
    storage: {
      connections: {
        findById: mock(async () => ({
          id: "conn_child",
          metadata: {
            repoScope: {
              sourceConnectionId: "conn_org",
              installationId: 42,
              owner: "acme",
              repo: "widget",
              permissions: GITHUB_SCOPED_PERMISSIONS,
            },
          },
        })),
      },
    },
  } as never;
}

describe("resolveGitHubAccessToken", () => {
  beforeEach(() => {
    mockEnsureRepoScopedToken.mockClear();
    mockTokenGet.mockClear();
    mockRefreshAndStore.mockClear();
  });

  it("re-mints repo-scoped tokens via ensureRepoScopedToken", async () => {
    const token = await resolveGitHubAccessToken(
      "conn_child",
      null as never,
      null as never,
      makeRepoScopedCtx(),
    );

    expect(token).toBe("ghs_fresh_minted");
    expect(mockEnsureRepoScopedToken).toHaveBeenCalledTimes(1);
    expect(mockTokenGet).not.toHaveBeenCalled();
  });

  it("refreshes expired OAuth tokens for org connections", async () => {
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    mockTokenGet.mockImplementation(async () => ({
      id: "dtok_1",
      connectionId: "conn_org",
      accessToken: "ghu_stale",
      refreshToken: "ghr_refresh",
      scope: "repo",
      expiresAt: pastExpiry,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      clientId: "Iv1.test",
      clientSecret: "secret",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
    }));

    const token = await resolveGitHubAccessToken(
      "conn_org",
      null as never,
      null as never,
      {
        organization: { id: "org_1", slug: "test", name: "Test" },
        storage: {
          connections: {
            findById: mock(async () => ({ metadata: null })),
          },
        },
      } as never,
    );

    expect(token).toBe("ghu_refreshed");
    expect(mockRefreshAndStore).toHaveBeenCalledTimes(1);
    expect(mockEnsureRepoScopedToken).not.toHaveBeenCalled();
  });

  it("throws when a minted token is expired and ctx is unavailable", async () => {
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    mockTokenGet.mockImplementation(async () => ({
      id: "dtok_1",
      connectionId: "conn_child",
      accessToken: "ghs_stale",
      refreshToken: null,
      scope: null,
      expiresAt: pastExpiry,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      clientId: null,
      clientSecret: null,
      tokenEndpoint: null,
    }));

    await expect(
      resolveGitHubAccessToken("conn_child", null as never, null as never),
    ).rejects.toThrow(
      "GitHub token refresh failed — reconnect the mcp-github integration.",
    );
  });
});
