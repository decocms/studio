import { describe, expect, it } from "bun:test";
import {
  DECO_GITHUB_APP_MINT_SOURCE,
  getRepoScope,
  GITHUB_SCOPED_PERMISSIONS,
} from "./github-repo-scope";

describe("getRepoScope", () => {
  it("returns the recipe for a well-formed repoScope", () => {
    const recipe = {
      sourceConnectionId: "conn_org",
      installationId: 123,
      owner: "acme",
      repo: "widget",
      permissions: { contents: "write" },
    };
    expect(getRepoScope({ metadata: { repoScope: recipe } })).toEqual(recipe);
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

  it("returns deco-github-app recipe without source connection", () => {
    const result = getRepoScope({
      metadata: {
        repoScope: {
          mintSource: DECO_GITHUB_APP_MINT_SOURCE,
          owner: "deco-sites",
          repo: "mysite",
        },
      },
    });
    expect(result).toEqual({
      mintSource: DECO_GITHUB_APP_MINT_SOURCE,
      owner: "deco-sites",
      repo: "mysite",
      permissions: GITHUB_SCOPED_PERMISSIONS,
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
        metadata: { repoScope: { installationId: 1, owner: "a", repo: "b" } },
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
});
