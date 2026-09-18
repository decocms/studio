import { describe, expect, test } from "bun:test";
import { resolveRunRepository } from "./run";

describe("resolveRunRepository", () => {
  test("a valid wire repository resolves and derives the legacy github spelling", () => {
    const { repository, githubRepo } = resolveRunRepository({
      repository: {
        repository_id: "repo_gh",
        provider: "github",
        host: "github.com",
        path: "acme/storefront",
      },
    });
    expect(repository?.repositoryId).toBe("repo_gh");
    expect(githubRepo).toBe("acme/storefront");
  });

  test("no configuration_state resolves to no repository", () => {
    expect(resolveRunRepository(undefined)).toEqual({
      repository: undefined,
      githubRepo: undefined,
    });
    expect(resolveRunRepository(null)).toEqual({
      repository: undefined,
      githubRepo: undefined,
    });
  });

  test("a decrypt/legacy state that isn't an object degrades to no repository instead of throwing", () => {
    expect(resolveRunRepository("corrupted")).toEqual({
      repository: undefined,
      githubRepo: undefined,
    });
    expect(resolveRunRepository(["not", "an", "object"])).toEqual({
      repository: undefined,
      githubRepo: undefined,
    });
  });

  test("a legacy github_repo string is used when no repository ref is set", () => {
    expect(resolveRunRepository({ github_repo: "acme/storefront" })).toEqual({
      repository: undefined,
      githubRepo: "acme/storefront",
    });
  });
});
