import { describe, expect, test } from "bun:test";
import { repositoryAccessMode } from "./access-mode";
import { readGithubManagedOwners } from "./github/env";

describe("readGithubManagedOwners", () => {
  test("is empty when unset or blank", () => {
    expect(readGithubManagedOwners({})).toEqual(new Set());
    expect(readGithubManagedOwners({ GITHUB_MANAGED_OWNERS: " , " })).toEqual(
      new Set(),
    );
  });

  test("trims, lowercases and dedupes owners", () => {
    expect(
      readGithubManagedOwners({
        GITHUB_MANAGED_OWNERS: " Hosted-Sites ,hosted-sites, other ",
      }),
    ).toEqual(new Set(["hosted-sites", "other"]));
  });
});

describe("repositoryAccessMode", () => {
  const env = { GITHUB_MANAGED_OWNERS: "hosted-sites" };
  const app = { type: "github", authKind: "github_app" } as const;
  const repo = (path: string) => ({ provider: "github", path }) as const;

  test("a hosted owner's repository linked through the App is managed", () => {
    expect(repositoryAccessMode(app, repo("Hosted-Sites/shop"), env)).toBe(
      "managed",
    );
  });

  test("any other owner manages access on GitHub", () => {
    expect(repositoryAccessMode(app, repo("acme/shop"), env)).toBe("self");
    expect(repositoryAccessMode(app, repo("hosted-sites/shop"), {})).toBe(
      "self",
    );
  });

  test("only App installations are managed", () => {
    expect(
      repositoryAccessMode(
        { type: "github", authKind: "oauth" },
        repo("hosted-sites/shop"),
        env,
      ),
    ).toBe("self");
    expect(repositoryAccessMode(null, repo("hosted-sites/shop"), env)).toBe(
      "self",
    );
    expect(
      repositoryAccessMode(
        { type: "gitlab", authKind: "oauth" },
        { provider: "gitlab", path: "hosted-sites/shop" },
        env,
      ),
    ).toBe("self");
  });
});
