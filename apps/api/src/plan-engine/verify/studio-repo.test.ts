import { describe, expect, test } from "bun:test";
import type { SiteProfile, SiteSources } from "../types.ts";
import { parseRepoUrl, providerOfHost, repoIdentityOf } from "./studio-repo.ts";

type Profile = Pick<SiteProfile, "code_repo" | "sources">;

const sources = (repository: SiteSources["repository"]): SiteSources => ({
  detected_at: "2026-11-20T00:00:00.000Z",
  studio_project: null,
  repository,
  errors: [],
});

const profile = (over: Partial<Profile> = {}): Profile => ({
  code_repo: null,
  sources: sources({ owner: "acme", name: "loja", connection_id: null }),
  ...over,
});

const GITHUB = {
  provider: "github" as const,
  host: "github.com",
  path: "acme/loja",
};

describe("repository identity helpers", () => {
  test("provider by host, GitHub by default", () => {
    expect(providerOfHost("github.com")).toBe("github");
    expect(providerOfHost("gitlab.com")).toBe("gitlab");
    expect(providerOfHost("gitlab.empresa.example")).toBe("gitlab");
    expect(providerOfHost("bitbucket.org")).toBe("bitbucket");
    expect(providerOfHost("git.empresa.example")).toBe("github");
  });

  test("parseRepoUrl", () => {
    expect(parseRepoUrl("https://github.com/acme/loja.git")).toEqual({
      host: "github.com",
      path: "acme/loja",
    });
    expect(parseRepoUrl("https://gitlab.com/grupo/sub/projeto/")).toEqual({
      host: "gitlab.com",
      path: "grupo/sub/projeto",
    });
    expect(parseRepoUrl("https://github.com/so-owner")).toBeNull();
    expect(parseRepoUrl("não é url")).toBeNull();
  });
});

describe("repoIdentityOf", () => {
  test("the Studio project's repository, GitHub by default", () => {
    expect(repoIdentityOf(profile())).toEqual(GITHUB);
  });

  test("provider, host and repository id from the project are kept", () => {
    expect(
      repoIdentityOf(
        profile({
          sources: sources({
            owner: "grupo",
            name: "loja",
            connection_id: null,
            provider: "gitlab",
            host: "gitlab.empresa.example",
            repository_id: "repo_9",
          }),
        }),
      ),
    ).toEqual({
      provider: "gitlab",
      host: "gitlab.empresa.example",
      path: "grupo/loja",
      repository_id: "repo_9",
    });
  });

  test("code_repo overrides; the same repo keeps the project's id", () => {
    expect(repoIdentityOf(profile({ code_repo: "acme/outra" }))).toEqual({
      ...GITHUB,
      path: "acme/outra",
    });
    expect(
      repoIdentityOf(
        profile({
          code_repo: "Acme/Loja",
          sources: sources({
            owner: "acme",
            name: "loja",
            connection_id: null,
            repository_id: "repo_1",
          }),
        }),
      ),
    ).toEqual({ ...GITHUB, repository_id: "repo_1" });
    expect(
      repoIdentityOf(
        profile({
          code_repo: "https://gitlab.com/grupo/sub/loja.git",
          sources: null,
        }),
      ),
    ).toEqual({
      provider: "gitlab",
      host: "gitlab.com",
      path: "grupo/sub/loja",
    });
  });

  test("nothing linked, or a code_repo that is not a repo: null", () => {
    expect(repoIdentityOf(profile({ sources: null }))).toBeNull();
    expect(repoIdentityOf(null)).toBeNull();
    expect(
      repoIdentityOf(profile({ sources: null, code_repo: "só-um-nome" })),
    ).toBeNull();
  });
});
