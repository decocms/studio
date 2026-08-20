import { describe, expect, it } from "bun:test";
import {
  findReusableRepoConnection,
  getOrgGithubConnections,
  getRepoScope,
  GITHUB_SCOPED_PERMISSIONS,
  isOrgSharedConnection,
  isPermissionRejected,
  listRepoScopeLabels,
  mintRepoTokenWithFallback,
  OPTIONAL_MINT_PERMISSIONS,
  type RepoScopeRecipe,
  withOptionalReadPermissions,
} from "./github-repo-scope";

describe("GITHUB_SCOPED_PERMISSIONS", () => {
  it("includes checks:read so the PR panel can read CI check runs", () => {
    // Without this, the minted GitHub App installation token gets
    // `403 Resource not accessible by integration` on
    // GET /commits/{sha}/check-runs. See github-repo-scope.ts.
    expect(GITHUB_SCOPED_PERMISSIONS.checks).toBe("read");
  });

  it("includes deployments:read so the PR panel can read the preview URL", () => {
    // FastStore WebOps posts the preview only as a Deployment; without it GET_PREVIEW_DEPLOYMENT 403s and previewUrl stays null.
    expect(GITHUB_SCOPED_PERMISSIONS.deployments).toBe("read");
  });

  it("keeps the write scopes the PR/sandbox flows depend on", () => {
    expect(GITHUB_SCOPED_PERMISSIONS).toMatchObject({
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      issues: "write",
    });
  });

  it("marks every optional permission as one it actually requests", () => {
    // OPTIONAL_MINT_PERMISSIONS says which requested perms are droppable — never one the scoped set doesn't request.
    for (const permission of OPTIONAL_MINT_PERMISSIONS) {
      expect(GITHUB_SCOPED_PERMISSIONS[permission]).toBe("read");
    }
  });
});

describe("isPermissionRejected", () => {
  it("matches the github-mcp allowlist rejection for an optional permission", () => {
    expect(
      isPermissionRejected(
        'Permission "checks" is not allowed. This tool only mints repo-scoped ' +
          "code access (contents, metadata, pull_requests, issues).",
      ),
    ).toBe(true);
    expect(
      isPermissionRejected('Permission "deployments" is not allowed.'),
    ).toBe(true);
  });

  it("matches the generic GitHub 422 (which doesn't name the permission)", () => {
    expect(
      isPermissionRejected(
        "Repository is not in this installation, or the requested permissions " +
          "exceed what the GitHub App was granted.",
      ),
    ).toBe(true);
  });

  it("does NOT match an allowlist rejection for a REQUIRED permission", () => {
    // A required perm being rejected is a real misconfiguration — surface it, don't downgrade.
    expect(isPermissionRejected('Permission "issues" is not allowed.')).toBe(
      false,
    );
  });

  it("does not match unrelated errors or empty input", () => {
    expect(isPermissionRejected("Repository is not accessible.")).toBe(false);
    expect(isPermissionRejected(null)).toBe(false);
    expect(isPermissionRejected(undefined)).toBe(false);
  });
});

describe("withOptionalReadPermissions", () => {
  it("adds every optional read on top of the base set", () => {
    expect(withOptionalReadPermissions({ contents: "write" })).toEqual({
      contents: "write",
      deployments: "read",
      checks: "read",
    });
  });

  it("does not mutate its input", () => {
    const base = { contents: "write" };
    withOptionalReadPermissions(base);
    expect(base).toEqual({ contents: "write" });
  });
});

describe("mintRepoTokenWithFallback", () => {
  type MintResult = {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: { token?: string };
  };
  const ok: MintResult = { structuredContent: { token: "ghs_x" } };
  const base = { contents: "write", metadata: "read" };
  const desired = withOptionalReadPermissions(base);
  const rejected = (text: string): MintResult => ({
    isError: true,
    content: [{ type: "text", text }],
  });

  it("returns the full desired set as granted on first-try success", async () => {
    const calls: Record<string, string>[] = [];
    const { result, grantedPermissions } = await mintRepoTokenWithFallback(
      (permissions) => {
        calls.push(permissions);
        return Promise.resolve(ok);
      },
      desired,
    );
    expect(calls).toEqual([desired]);
    expect(grantedPermissions).toEqual(desired);
    expect(result).toBe(ok);
  });

  it("sheds only deployments when checks is granted but deployments isn't", async () => {
    const calls: Record<string, string>[] = [];
    const { result, grantedPermissions } = await mintRepoTokenWithFallback(
      (permissions) => {
        calls.push(permissions);
        // Generic 422 on the full set, then success once deployments is gone.
        return Promise.resolve(
          "deployments" in permissions
            ? rejected("the requested permissions exceed what the GitHub App")
            : ok,
        );
      },
      desired,
    );
    expect(calls).toEqual([desired, { ...base, checks: "read" }]);
    expect(grantedPermissions).toEqual({ ...base, checks: "read" });
    expect(result).toBe(ok);
  });

  it("sheds both optionals when the installation grants neither", async () => {
    const calls: Record<string, string>[] = [];
    const { result, grantedPermissions } = await mintRepoTokenWithFallback(
      (permissions) => {
        calls.push(permissions);
        const stillOptional =
          "deployments" in permissions || "checks" in permissions;
        return Promise.resolve(
          stillOptional
            ? rejected("the requested permissions exceed what the GitHub App")
            : ok,
        );
      },
      desired,
    );
    expect(calls).toEqual([desired, { ...base, checks: "read" }, base]);
    expect(grantedPermissions).toEqual(base);
    expect(result).toBe(ok);
  });

  it("does NOT drop optionals on an unrelated error (surfaces it once)", async () => {
    const calls: Record<string, string>[] = [];
    const err = rejected("GitHub is temporarily unavailable.");
    const { result } = await mintRepoTokenWithFallback((permissions) => {
      calls.push(permissions);
      return Promise.resolve(err);
    }, desired);
    expect(calls).toHaveLength(1);
    expect(result).toBe(err);
  });

  it("surfaces a rejection for a required permission after optionals are gone", async () => {
    const calls: Record<string, string>[] = [];
    const err = rejected(
      "the requested permissions exceed what the GitHub App",
    );
    const { result, grantedPermissions } = await mintRepoTokenWithFallback(
      (permissions) => {
        calls.push(permissions);
        return Promise.resolve(err);
      },
      desired,
    );
    // Full -> drop deployments -> drop checks -> base (still rejected) -> surface.
    expect(calls).toEqual([desired, { ...base, checks: "read" }, base]);
    expect(grantedPermissions).toEqual(base);
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
