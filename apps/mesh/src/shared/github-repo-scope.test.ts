import { describe, expect, it } from "bun:test";
import {
  getOrgGithubConnections,
  getRepoScope,
  GITHUB_SCOPED_PERMISSIONS,
} from "./github-repo-scope";

describe("getRepoScope", () => {
  it("returns the grant metadata for a refreshable repoScope without sourceConnectionId", () => {
    const recipe = {
      installationId: 123,
      repositoryId: 456,
      owner: "acme",
      repo: "widget",
      permissions: { contents: "write" },
      grantProvider: "github-mcp",
    };
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

  it("returns null when metadata is null", () => {
    expect(getRepoScope({ metadata: null })).toBeNull();
  });

  it("returns null when repoScope is absent", () => {
    expect(getRepoScope({ metadata: { source: "store" } })).toBeNull();
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

  it("drops repo-scoped child connections", () => {
    expect(getOrgGithubConnections([scopedConn, orgConn])).toEqual([orgConn]);
  });

  it("returns an empty array when every connection is repo-scoped", () => {
    expect(getOrgGithubConnections([scopedConn])).toEqual([]);
  });
});
