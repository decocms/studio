import { describe, expect, test } from "bun:test";
import {
  GitPushAuthError,
  parseGithubRepoFromMetadata,
} from "./sync-git-credentials";

describe("parseGithubRepoFromMetadata", () => {
  test("returns public-clone repo without connectionId", () => {
    const repo = parseGithubRepoFromMetadata(
      {
        githubRepo: {
          owner: "deco-sites",
          name: "baggagio-tanstack",
        },
      },
      [],
    );
    expect(repo?.owner).toBe("deco-sites");
    expect(repo?.connectionId).toBeUndefined();
  });

  test("returns null when connectionId is stale", () => {
    const repo = parseGithubRepoFromMetadata(
      {
        githubRepo: {
          owner: "deco-sites",
          name: "baggagio-tanstack",
          connectionId: "conn_github",
        },
      },
      ["conn_other"],
    );
    expect(repo).toBeNull();
  });

  test("returns repo when connectionId is attached", () => {
    const repo = parseGithubRepoFromMetadata(
      {
        githubRepo: {
          owner: "deco-sites",
          name: "baggagio-tanstack",
          connectionId: "conn_github",
        },
      },
      ["conn_github"],
    );
    expect(repo?.connectionId).toBe("conn_github");
  });
});

describe("GitPushAuthError", () => {
  test("is instanceof Error", () => {
    const err = new GitPushAuthError("nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GitPushAuthError");
  });
});
