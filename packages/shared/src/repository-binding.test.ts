import { describe, expect, test } from "bun:test";
import {
  repositoryBindingKey,
  sameRepositoryBinding,
} from "./repository-binding";

describe("repository binding identity", () => {
  test("distinguishes hosts and nested namespaces", () => {
    expect(
      sameRepositoryBinding(
        { url: "https://github.com/example/site" },
        { url: "https://gitlab.com/example/site" },
      ),
    ).toBe(false);
    expect(
      sameRepositoryBinding(
        { url: "https://git.example.com/group/one/site" },
        { url: "https://git.example.com/group/two/site" },
      ),
    ).toBe(false);
  });
  test("normalizes URL casing, clone suffix and trailing slash", () => {
    expect(
      sameRepositoryBinding(
        { url: "https://GitLab.com/GROUP/Site.git/" },
        { url: "https://gitlab.com/group/site" },
      ),
    ).toBe(true);
  });
  test("uses stable repository references when both exist", () => {
    expect(
      sameRepositoryBinding(
        {
          url: "https://git.example.com/old/site",
          repositoryId: "repo_example",
        },
        {
          url: "https://git.example.com/new/site",
          repositoryId: "repo_example",
        },
      ),
    ).toBe(true);
    expect(
      sameRepositoryBinding(
        { url: "https://git.example.com/a/site", repositoryId: "repo_one" },
        { url: "https://git.example.com/a/site", repositoryId: "repo_two" },
      ),
    ).toBe(false);
  });
  test("malformed values never identify the same checkout", () => {
    for (const url of ["", "invalid", "file:///repo", "https://example.com/"]) {
      expect(repositoryBindingKey({ url })).toBeNull();
      expect(sameRepositoryBinding({ url }, { url })).toBe(false);
    }
  });
});
