import { describe, expect, test } from "bun:test";
import {
  fromLegacyGithubRepo,
  fromWire,
  legacyGithubRepo,
  type ReportsRepositoryRef,
  repoKey,
  toWire,
} from "./repository-ref";

const gitlab: ReportsRepositoryRef = {
  repositoryId: "repo_1",
  provider: "gitlab",
  host: "gitlab.example.dev",
  path: "group/sub/project",
  defaultBranch: "main",
  webUrl: "https://gitlab.example.dev/group/sub/project",
};

describe("toWire / fromWire", () => {
  test("a reference survives the round trip", () => {
    expect(fromWire(toWire(gitlab))).toEqual(gitlab);
  });

  test("the wire is snake_case — the convention the consumer reads", () => {
    expect(toWire(gitlab)).toEqual({
      repository_id: "repo_1",
      provider: "gitlab",
      host: "gitlab.example.dev",
      path: "group/sub/project",
      default_branch: "main",
      web_url: "https://gitlab.example.dev/group/sub/project",
    });
  });

  test("the optional fields are written as explicit nulls, never dropped", () => {
    const wire = toWire({
      repositoryId: "repo_2",
      provider: "github",
      host: "github.com",
      path: "acme/storefront",
    });
    expect(wire.default_branch).toBeNull();
    expect(wire.web_url).toBeNull();
  });

  test("a payload missing the id or naming an unknown provider is not a reference", () => {
    expect(fromWire(null)).toBeNull();
    expect(fromWire({})).toBeNull();
    expect(
      fromWire({ provider: "github", host: "github.com", path: "acme/site" }),
    ).toBeNull();
    expect(
      fromWire({
        repository_id: "repo_1",
        provider: "gitea",
        host: "gitea.dev",
        path: "acme/site",
      }),
    ).toBeNull();
  });

  test("a camelCase payload is not accepted — the wire has one spelling", () => {
    expect(fromWire(gitlab)).toBeNull();
  });
});

describe("repoKey", () => {
  test("the provider is part of the identity", () => {
    const base = { host: "example.dev", path: "acme/site" } as const;
    expect(repoKey({ ...base, provider: "github" })).not.toBe(
      repoKey({ ...base, provider: "gitlab" }),
    );
  });

  test("host and path compare case-insensitively", () => {
    expect(
      repoKey({ provider: "github", host: "GitHub.com", path: "Acme/Site" }),
    ).toBe(
      repoKey({ provider: "github", host: "github.com", path: "acme/site" }),
    );
  });

  test("a nested namespace stays whole", () => {
    expect(repoKey(gitlab)).toBe("gitlab:gitlab.example.dev/group/sub/project");
  });
});

describe("legacyGithubRepo", () => {
  test("a github.com repository has a legacy spelling", () => {
    expect(
      legacyGithubRepo({
        repositoryId: "repo_1",
        provider: "github",
        host: "github.com",
        path: "acme/storefront",
      }),
    ).toBe("acme/storefront");
  });

  test("anything else has none — a subgroup path in that field would be a lie", () => {
    expect(legacyGithubRepo(gitlab)).toBeNull();
    expect(
      legacyGithubRepo({
        repositoryId: "repo_1",
        provider: "github",
        host: "github.acme.dev",
        path: "acme/storefront",
      }),
    ).toBeNull();
  });
});

describe("fromLegacyGithubRepo", () => {
  test("an owner/name string becomes a github.com identity", () => {
    expect(fromLegacyGithubRepo("acme/storefront")).toEqual({
      provider: "github",
      host: "github.com",
      path: "acme/storefront",
    });
  });

  test("surrounding whitespace is not part of the name", () => {
    expect(fromLegacyGithubRepo("  acme/storefront  ")?.path).toBe(
      "acme/storefront",
    );
  });

  test("anything that is not owner/name is refused, not guessed at", () => {
    expect(fromLegacyGithubRepo("")).toBeNull();
    expect(fromLegacyGithubRepo("acme")).toBeNull();
    expect(fromLegacyGithubRepo("group/sub/project")).toBeNull();
    expect(fromLegacyGithubRepo("https://github.com/acme/site")).toBeNull();
  });
});
