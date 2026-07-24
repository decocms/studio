import { describe, expect, it } from "bun:test";
import {
  getOrgGithubConnections,
  getRepoScope,
  GITHUB_SCOPED_PERMISSIONS,
  isChecksPermissionRejected,
  isOrgSharedConnection,
  permissionsWithoutChecks,
  type RepoScopeRecipe,
} from "./github-repo-scope";

describe("GITHUB_SCOPED_PERMISSIONS", () => {
  it("includes checks:read so the PR panel can read CI check runs", () => {
    // Without this, the minted GitHub App installation token gets
    // `403 Resource not accessible by integration` on
    // GET /commits/{sha}/check-runs. See github-repo-scope.ts.
    expect(GITHUB_SCOPED_PERMISSIONS.checks).toBe("read");
  });

  it("keeps the write scopes the PR/sandbox flows depend on", () => {
    expect(GITHUB_SCOPED_PERMISSIONS).toMatchObject({
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      issues: "write",
    });
  });
});

describe("isChecksPermissionRejected", () => {
  it("matches the github-mcp allowlist rejection", () => {
    expect(
      isChecksPermissionRejected(
        'Permission "checks" is not allowed. This tool only mints repo-scoped ' +
          "code access (contents, metadata, pull_requests, issues).",
      ),
    ).toBe(true);
  });

  it("matches the GitHub 422 raised when the installation lacks Checks", () => {
    expect(
      isChecksPermissionRejected(
        "Repository is not in this installation, or the requested permissions " +
          "exceed what the GitHub App was granted.",
      ),
    ).toBe(true);
  });

  it("does not match unrelated errors or empty input", () => {
    expect(
      isChecksPermissionRejected('Permission "issues" is not allowed.'),
    ).toBe(false);
    expect(isChecksPermissionRejected("Repository is not accessible.")).toBe(
      false,
    );
    expect(isChecksPermissionRejected(null)).toBe(false);
    expect(isChecksPermissionRejected(undefined)).toBe(false);
  });
});

describe("permissionsWithoutChecks", () => {
  it("drops only the checks key and leaves the rest intact", () => {
    expect(permissionsWithoutChecks(GITHUB_SCOPED_PERMISSIONS)).toEqual({
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      issues: "write",
    });
  });

  it("is a no-op when checks is absent", () => {
    expect(permissionsWithoutChecks({ contents: "write" })).toEqual({
      contents: "write",
    });
  });
});

describe("getRepoScope", () => {
  it("returns the grant metadata for a refreshable repoScope without sourceConnectionId", () => {
    const recipe = {
      installationId: 123,
      repositoryId: 456,
      owner: "acme",
      repo: "widget",
      permissions: { contents: "write" },
      grantProvider: "github-mcp",
    } satisfies RepoScopeRecipe;
    expect(getRepoScope({ metadata: { repoScope: recipe } })).toEqual(recipe);
  });

  it("accepts legacy repoScope metadata with sourceConnectionId", () => {
    const recipe = {
      sourceConnectionId: "conn_org",
      installationId: 123,
      owner: "acme",
      repo: "widget",
      permissions: { contents: "write" },
    };
    expect(getRepoScope({ metadata: { repoScope: recipe } })).toEqual({
      ...recipe,
      grantProvider: undefined,
      repositoryId: undefined,
    });
  });

  it("defaults permissions when omitted", () => {
    const result = getRepoScope({
      metadata: {
        repoScope: {
          sourceConnectionId: "conn_org",
          installationId: 1,
          owner: "a",
          repo: "b",
        },
      },
    });
    expect(result?.permissions).toEqual(GITHUB_SCOPED_PERMISSIONS);
  });

  it("defaults permissions when permissions metadata is not an object", () => {
    const result = getRepoScope({
      metadata: {
        repoScope: {
          sourceConnectionId: "conn_org",
          installationId: 1,
          owner: "a",
          repo: "b",
          permissions: "bad",
        },
      },
    });
    expect(result?.permissions).toEqual(GITHUB_SCOPED_PERMISSIONS);
  });

  it("defaults permissions when permissions metadata has non-string values", () => {
    const result = getRepoScope({
      metadata: {
        repoScope: {
          sourceConnectionId: "conn_org",
          installationId: 1,
          owner: "a",
          repo: "b",
          permissions: { contents: 1 },
        },
      },
    });
    expect(result?.permissions).toEqual(GITHUB_SCOPED_PERMISSIONS);
  });

  it("returns null when metadata is null", () => {
    expect(getRepoScope({ metadata: null })).toBeNull();
  });

  it("returns null when repoScope is absent", () => {
    expect(getRepoScope({ metadata: { source: "store" } })).toBeNull();
  });

  it("accepts repoScope metadata without legacy sourceConnectionId", () => {
    expect(
      getRepoScope({
        metadata: { repoScope: { installationId: 1, owner: "a", repo: "b" } },
      }),
    ).toEqual({
      installationId: 1,
      repositoryId: undefined,
      sourceConnectionId: undefined,
      owner: "a",
      repo: "b",
      permissions: GITHUB_SCOPED_PERMISSIONS,
      grantProvider: undefined,
    });
  });

  it("returns null when required fields are missing or mistyped", () => {
    expect(
      getRepoScope({
        metadata: {
          repoScope: {
            sourceConnectionId: "x",
            installationId: "nope",
            owner: "a",
            repo: "b",
          },
        },
      }),
    ).toBeNull();
    expect(
      getRepoScope({
        metadata: {
          repoScope: {
            sourceConnectionId: "x",
            installationId: 1,
            owner: "",
            repo: "b",
          },
        },
      }),
    ).toBeNull();
  });

  it("returns null for non-positive, non-integer, or non-finite installation ids", () => {
    for (const installationId of [NaN, Infinity, -1, 1.5]) {
      expect(
        getRepoScope({
          metadata: {
            repoScope: {
              installationId,
              owner: "a",
              repo: "b",
            },
          },
        }),
      ).toBeNull();
    }
  });

  it("omits non-positive, non-integer, or non-finite repository ids", () => {
    for (const repositoryId of [NaN, Infinity, -1, 0, 1.5]) {
      expect(
        getRepoScope({
          metadata: {
            repoScope: {
              installationId: 1,
              repositoryId,
              owner: "a",
              repo: "b",
            },
          },
        })?.repositoryId,
      ).toBeUndefined();
    }
  });
});

describe("getOrgGithubConnections", () => {
  const orgConn = { id: "conn_org", metadata: { source: "store" } };
  const scopedConn = {
    id: "conn_scoped",
    metadata: {
      repoScope: {
        sourceConnectionId: "conn_org",
        installationId: 1,
        owner: "deco-sites",
        repo: "demo-linkedin",
      },
    },
  };
  const refreshableScopedConn = {
    id: "conn_refreshable_scoped",
    metadata: {
      repoScope: {
        installationId: 1,
        owner: "deco-sites",
        repo: "demo-linkedin",
      },
    },
  };

  it("drops repo-scoped child connections", () => {
    expect(
      getOrgGithubConnections([scopedConn, refreshableScopedConn, orgConn]),
    ).toEqual([orgConn]);
  });

  it("returns an empty array when every connection is repo-scoped", () => {
    expect(
      getOrgGithubConnections([scopedConn, refreshableScopedConn]),
    ).toEqual([]);
  });
});

describe("isOrgSharedConnection", () => {
  it("is true only when metadata.orgShared === true", () => {
    expect(isOrgSharedConnection({ metadata: { orgShared: true } })).toBe(true);
  });

  it("is false for per-agent repo children and plain connections", () => {
    expect(
      isOrgSharedConnection({
        metadata: { repoScope: { installationId: 1, owner: "a", repo: "b" } },
      }),
    ).toBe(false);
    expect(isOrgSharedConnection({ metadata: null })).toBe(false);
    expect(isOrgSharedConnection({ metadata: { orgShared: "yes" } })).toBe(
      false,
    );
  });
});
