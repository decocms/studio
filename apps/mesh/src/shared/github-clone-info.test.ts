import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import type { StudioContext } from "../core/studio-context";
import type { DownstreamToken } from "../storage/types";

const mockEnsureRepoScopedToken = mock(async () => "ghs_repo_token");
mock.module("../oauth/github-mint", () => ({
  ensureRepoScopedToken: mockEnsureRepoScopedToken,
}));

const { buildCloneInfo, ensureGithubCloneToken } = await import(
  "./github-clone-info"
);
const { RECONNECT_ERROR } = await import("../oauth/token-refresh");

const originalFetch = globalThis.fetch;

function makeRefreshableExpiredToken(): DownstreamToken {
  return {
    id: "dtok_1",
    connectionId: "conn_repo",
    accessToken: "ghu_expired_token",
    refreshToken: "ghr_refresh_token",
    scope: "repo",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    clientId: "Iv1.test_client",
    clientSecret: "test_secret",
    tokenEndpoint: "https://github.example.test/login/oauth/access_token",
  };
}

function makeDb(token: DownstreamToken | null) {
  return {
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({
          executeTakeFirst: async () => token,
        }),
      }),
    }),
    deleteFrom: () => ({
      where: () => ({
        execute: async () => {},
      }),
    }),
  };
}

const vault = {
  decrypt: async (value: string) => value,
};

afterAll(() => {
  for (const cachePath of Object.keys(require.cache)) {
    if (
      cachePath.endsWith("/apps/mesh/src/oauth/token-refresh.ts") ||
      cachePath.endsWith("/apps/mesh/src/oauth/refresh-access-token.ts") ||
      cachePath.endsWith("/apps/mesh/src/shared/github-clone-info.ts")
    ) {
      delete require.cache[cachePath];
    }
  }
});

function makeCtx(connection: { metadata: Record<string, unknown> | null }) {
  return {
    storage: {
      connections: {
        findById: mock(
          async (_connectionId: string, _organizationId: string) => connection,
        ),
      },
    },
  } as unknown as StudioContext;
}

describe("ensureGithubCloneToken", () => {
  beforeEach(() => {
    mockEnsureRepoScopedToken.mockReset();
  });

  it("calls legacy minting for source-linked repo scopes", async () => {
    const connection = {
      metadata: {
        repoScope: {
          sourceConnectionId: "conn_source",
          installationId: 123,
          owner: "acme",
          repo: "app",
          permissions: { contents: "write" },
        },
      },
    };
    const ctx = makeCtx(connection);

    await ensureGithubCloneToken({
      ctx,
      connectionId: "conn_repo",
      organizationId: "org_1",
    });

    expect(mockEnsureRepoScopedToken).toHaveBeenCalledTimes(1);
    expect(mockEnsureRepoScopedToken).toHaveBeenCalledWith(ctx, connection);
  });

  it("skips source-less repo grants", async () => {
    const connection = {
      metadata: {
        repoScope: {
          installationId: 123,
          owner: "acme",
          repo: "app",
          permissions: { contents: "write" },
          grantProvider: "github-mcp",
        },
      },
    };

    await ensureGithubCloneToken({
      ctx: makeCtx(connection),
      connectionId: "conn_repo",
      organizationId: "org_1",
    });

    expect(mockEnsureRepoScopedToken).not.toHaveBeenCalled();
  });
});

describe("buildCloneInfo", () => {
  beforeEach(() => {
    globalThis.fetch = mock(
      async () => new Response("{}", { status: 404 }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("maps refresh failure to the reconnect message", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "refresh token revoked",
          }),
          { status: 400 },
        ),
    ) as unknown as typeof fetch;

    await expect(
      buildCloneInfo(
        "conn_repo",
        "acme",
        "app",
        makeDb(makeRefreshableExpiredToken()) as never,
        vault as never,
      ),
    ).rejects.toThrow(RECONNECT_ERROR);
  });

  it("keeps the existing no-token message when the token is missing", async () => {
    await expect(
      buildCloneInfo(
        "conn_repo",
        "acme",
        "app",
        makeDb(null) as never,
        vault as never,
      ),
    ).rejects.toThrow(
      "No GitHub token found. Ensure the mcp-github connection is authenticated.",
    );
  });
});
