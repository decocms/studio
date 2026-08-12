import { describe, expect, it } from "bun:test";
import {
  findReusableRepoConnection,
  getOrgGithubConnections,
  getRepoScope,
  GITHUB_SCOPED_PERMISSIONS,
  isChecksPermissionRejected,
  isOrgSharedConnection,
  listRepoScopeLabels,
  mintRepoTokenWithChecksFallback,
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

describe("mintRepoTokenWithChecksFallback", () => {
  type MintResult = {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: { token?: string };
  };
  const ok: MintResult = { structuredContent: { token: "ghs_x" } };
  const base = { contents: "write", metadata: "read" };

  it("requests checks:read and returns it as granted on success", async () => {
    const calls: Record<string, string>[] = [];
    const { result, grantedPermissions } =
      await mintRepoTokenWithChecksFallback((permissions) => {
        calls.push(permissions);
        return Promise.resolve(ok);
      }, base);
    expect(calls).toEqual([{ ...base, checks: "read" }]);
    expect(grantedPermissions).toEqual({ ...base, checks: "read" });
    expect(result).toBe(ok);
  });

  it("retries without checks when the mint is rejected for checks", async () => {
    const calls: Record<string, string>[] = [];
    const rejected: MintResult = {
      isError: true,
      content: [{ type: "text", text: 'Permission "checks" is not allowed.' }],
    };
    const { result, grantedPermissions } =
      await mintRepoTokenWithChecksFallback((permissions) => {
        calls.push(permissions);
        return Promise.resolve(calls.length === 1 ? rejected : ok);
      }, base);
    expect(calls).toEqual([{ ...base, checks: "read" }, base]);
    expect(grantedPermissions).toEqual(base);
    expect(result).toBe(ok);
  });

  it("does NOT retry on an unrelated error (surfaces it once)", async () => {
    const calls: Record<string, string>[] = [];
    const err: MintResult = {
      isError: true,
      content: [{ type: "text", text: "GitHub is temporarily unavailable." }],
    };
    const { result } = await mintRepoTokenWithChecksFallback((permissions) => {
      calls.push(permissions);
      return Promise.resolve(err);
    }, base);
    expect(calls).toHaveLength(1);
    expect(result).toBe(err);
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

describe("findReusableRepoConnection", () => {
  const repoConn = (
    id: string,
    owner: string,
    repo: string,
    extra?: Record<string, unknown>,
  ) => ({
    id,
    status: "active",
    metadata: {
      ...extra,
      repoScope: { installationId: 1, owner, repo },
    },
  });

  it("finds nothing when the repo was never imported", () => {
    expect(findReusableRepoConnection([], "acme", "web")).toBeNull();
    expect(
      findReusableRepoConnection(
        [repoConn("c1", "acme", "api")],
        "acme",
        "web",
      ),
    ).toBeNull();
  });

  it("ignores the bare org connection (no repoScope)", () => {
    expect(
      findReusableRepoConnection(
        [{ id: "c0", status: "active", metadata: { orgShared: true } }],
        "acme",
        "web",
      ),
    ).toBeNull();
  });

  it("reuses the connection already covering the repo", () => {
    expect(
      findReusableRepoConnection([repoConn("c1", "acme", "web")], "acme", "web")
        ?.id,
    ).toBe("c1");
  });

  it("prefers the org-shared connection — it outlives any single agent", () => {
    expect(
      findReusableRepoConnection(
        [
          repoConn("c_agent", "acme", "web"),
          repoConn("c_shared", "acme", "web", { orgShared: true }),
        ],
        "acme",
        "web",
      )?.id,
    ).toBe("c_shared");
  });

  it("matches owner/repo case-insensitively, like GitHub", () => {
    expect(
      findReusableRepoConnection([repoConn("c1", "Acme", "Web")], "acme", "web")
        ?.id,
    ).toBe("c1");
  });

  it("skips inactive connections", () => {
    expect(
      findReusableRepoConnection(
        [{ ...repoConn("c1", "acme", "web"), status: "inactive" }],
        "acme",
        "web",
      ),
    ).toBeNull();
  });

  it("tolerates a connection list without a status field", () => {
    expect(
      findReusableRepoConnection(
        [
          {
            id: "c1",
            metadata: {
              repoScope: { installationId: 1, owner: "acme", repo: "web" },
            },
          },
        ],
        "acme",
        "web",
      )?.id,
    ).toBe("c1");
  });
});

describe("listRepoScopeLabels", () => {
  const repoConn = (owner: string, repo: string) => ({
    status: "active",
    metadata: {
      repoScope: { installationId: 1, owner, repo },
    },
  });

  it("returns distinct owner/name labels for active repo-scoped connections", () => {
    expect(
      listRepoScopeLabels([repoConn("acme", "web"), repoConn("acme", "api")]),
    ).toEqual(["acme/web", "acme/api"]);
  });

  it("dedupes case-insensitive duplicates, keeping the first-seen casing", () => {
    expect(
      listRepoScopeLabels([repoConn("Acme", "Web"), repoConn("acme", "web")]),
    ).toEqual(["Acme/Web"]);
  });

  it("skips inactive connections", () => {
    expect(
      listRepoScopeLabels([
        { ...repoConn("acme", "web"), status: "inactive" },
        repoConn("acme", "api"),
      ]),
    ).toEqual(["acme/api"]);
  });

  it("skips connections that are not repo-scoped", () => {
    expect(
      listRepoScopeLabels([
        { status: "active", metadata: { orgShared: true } },
        repoConn("acme", "web"),
      ]),
    ).toEqual(["acme/web"]);
  });

  it("returns [] for null/undefined/empty input", () => {
    expect(listRepoScopeLabels(null)).toEqual([]);
    expect(listRepoScopeLabels(undefined)).toEqual([]);
    expect(listRepoScopeLabels([])).toEqual([]);
  });
});
