import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { StudioContext } from "../core/studio-context";
import type { ValidDownstreamAccessTokenResult } from "../oauth/token-refresh";

const mockEnsureRepoScopedToken = mock(async () => "ghs_repo_token");
mock.module("../oauth/github-mint", () => ({
  ensureRepoScopedToken: mockEnsureRepoScopedToken,
}));

const mockGetValidDownstreamAccessToken = mock(
  async (_params: unknown): Promise<ValidDownstreamAccessTokenResult> => ({
    state: "valid",
    accessToken: "ghu_valid_token",
  }),
);
mock.module("../oauth/token-refresh", () => ({
  getValidDownstreamAccessToken: mockGetValidDownstreamAccessToken,
  RECONNECT_ERROR:
    "GitHub token refresh failed — reconnect the mcp-github integration.",
}));

const mockDownstreamTokenStorageConstructor = mock(
  (_db: unknown, _vault: unknown) => ({}),
);
mock.module("../storage/downstream-token", () => ({
  DownstreamTokenStorage: class MockDownstreamTokenStorage {
    constructor(db: unknown, vault: unknown) {
      return mockDownstreamTokenStorageConstructor(db, vault);
    }
  },
}));

const {
  buildCloneInfo,
  ensureGithubCloneToken,
}: typeof import("./github-clone-info") = await import("./github-clone-info");
const { RECONNECT_ERROR } = await import("../oauth/token-refresh");

const originalFetch = globalThis.fetch;

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
    mockGetValidDownstreamAccessToken.mockReset();
    mockDownstreamTokenStorageConstructor.mockReset();
    globalThis.fetch = mock(
      async () => new Response("{}", { status: 404 }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("maps refresh failure to the reconnect message", async () => {
    mockGetValidDownstreamAccessToken.mockResolvedValueOnce({
      state: "refresh_failed",
      accessToken: null,
    });

    await expect(
      buildCloneInfo("conn_repo", "acme", "app", null as never, null as never),
    ).rejects.toThrow(RECONNECT_ERROR);
  });

  it("keeps the existing no-token message when the token is missing", async () => {
    mockGetValidDownstreamAccessToken.mockResolvedValueOnce({
      state: "missing",
      accessToken: null,
    });

    await expect(
      buildCloneInfo("conn_repo", "acme", "app", null as never, null as never),
    ).rejects.toThrow(
      "No GitHub token found. Ensure the mcp-github connection is authenticated.",
    );
  });
});
