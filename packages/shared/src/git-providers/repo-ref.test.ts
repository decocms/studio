import { describe, expect, test } from "bun:test";
import type { RepoRef } from "./types";
import {
  apiBaseUrlFor,
  cloneUrlFor,
  parseRepoUrl,
  providerForHost,
  repoIdentityKey,
  repoName,
  repoNamespace,
  repoWebUrl,
  sameRepo,
  splitOwnerName,
} from "./repo-ref";

describe("providerForHost", () => {
  test("recognises the hosted providers", () => {
    expect(providerForHost("github.com")).toBe("github");
    expect(providerForHost("GitHub.com")).toBe("github");
    expect(providerForHost("gitlab.com")).toBe("gitlab");
  });
  test("recognises self-hosted gitlab by convention", () => {
    expect(providerForHost("gitlab.acme.com")).toBe("gitlab");
    expect(providerForHost("git.gitlab-internal.example")).toBe("gitlab");
    expect(providerForHost("gitlab.example.com:8443")).toBe("gitlab");
  });
  test("is unknown for an arbitrary host", () => {
    expect(providerForHost("git.acme.com")).toBeNull();
    expect(providerForHost("bitbucket.org")).toBeNull();
  });
});

describe("parseRepoUrl", () => {
  test("github https and browser urls collapse to owner/name", () => {
    const expected: RepoRef = {
      provider: "github",
      host: "github.com",
      path: "acme/site",
    };
    expect(parseRepoUrl("https://github.com/acme/site")).toEqual(expected);
    expect(parseRepoUrl("https://github.com/acme/site.git")).toEqual(expected);
    expect(parseRepoUrl("https://www.github.com/acme/site/")).toEqual(expected);
    expect(parseRepoUrl("https://github.com/acme/site/pull/12")).toEqual(
      expected,
    );
    expect(parseRepoUrl("https://github.com/acme/site/tree/main/src")).toEqual(
      expected,
    );
  });
  test("github ssh forms", () => {
    const expected: RepoRef = {
      provider: "github",
      host: "github.com",
      path: "acme/site",
    };
    expect(parseRepoUrl("git@github.com:acme/site.git")).toEqual(expected);
    expect(parseRepoUrl("ssh://git@github.com/acme/site.git")).toEqual(
      expected,
    );
  });
  test("gitlab keeps every namespace level and drops the /-/ sub-resource", () => {
    expect(
      parseRepoUrl("https://gitlab.com/group/sub/project/-/merge_requests/3"),
    ).toEqual({
      provider: "gitlab",
      host: "gitlab.com",
      path: "group/sub/project",
    });
    expect(parseRepoUrl("git@gitlab.acme.com:group/sub/project.git")).toEqual({
      provider: "gitlab",
      host: "gitlab.acme.com",
      path: "group/sub/project",
    });
    expect(parseRepoUrl("https://gitlab.example.com:8443/g/p.git")).toEqual({
      provider: "gitlab",
      host: "gitlab.example.com:8443",
      path: "g/p",
    });
  });
  test("bare path needs an explicit provider", () => {
    expect(parseRepoUrl("acme/site")).toBeNull();
    expect(parseRepoUrl("acme/site", { provider: "github" })).toEqual({
      provider: "github",
      host: "github.com",
      path: "acme/site",
    });
    expect(
      parseRepoUrl("g/sub/p", { provider: "gitlab", host: "git.acme.com" }),
    ).toEqual({ provider: "gitlab", host: "git.acme.com", path: "g/sub/p" });
  });
  test("unknown hosts need an explicit provider", () => {
    expect(parseRepoUrl("https://git.acme.com/g/p")).toBeNull();
    expect(
      parseRepoUrl("https://git.acme.com/g/p", { provider: "gitlab" }),
    ).toEqual({
      provider: "gitlab",
      host: "git.acme.com",
      path: "g/p",
    });
  });
  test("rejects garbage", () => {
    expect(parseRepoUrl("")).toBeNull();
    expect(parseRepoUrl("https://github.com/acme")).toBeNull();
    expect(parseRepoUrl("https://github.com/")).toBeNull();
    expect(parseRepoUrl("https://github.com/acme/..")).toBeNull();
    expect(parseRepoUrl("ftp://github.com/acme/site")).toBeNull();
    expect(parseRepoUrl("not a url")).toBeNull();
  });
});

describe("identity + derived urls", () => {
  const gh = {
    provider: "github" as const,
    host: "github.com",
    path: "Acme/Site",
  };
  const gl = {
    provider: "gitlab" as const,
    host: "gitlab.acme.com",
    path: "group/sub/project",
  };
  test("identity is case-insensitive and host-qualified", () => {
    expect(repoIdentityKey(gh)).toBe("github.com/acme/site");
    expect(sameRepo(gh, { host: "GitHub.com", path: "acme/site" })).toBe(true);
    expect(sameRepo(gh, { host: "gitlab.com", path: "acme/site" })).toBe(false);
  });
  test("name / namespace / owner-name split", () => {
    expect(repoName(gl)).toBe("project");
    expect(repoNamespace(gl)).toBe("group/sub");
    expect(splitOwnerName(gh)).toEqual({ owner: "Acme", name: "Site" });
  });
  test("web and api urls", () => {
    expect(repoWebUrl(gh)).toBe("https://github.com/Acme/Site");
    expect(repoWebUrl(gl)).toBe("https://gitlab.acme.com/group/sub/project");
    expect(apiBaseUrlFor("github", "github.com")).toBe(
      "https://api.github.com",
    );
    expect(apiBaseUrlFor("github", "ghe.acme.com")).toBe(
      "https://ghe.acme.com/api/v3",
    );
    expect(apiBaseUrlFor("gitlab", "gitlab.acme.com")).toBe(
      "https://gitlab.acme.com/api/v4",
    );
  });
  test("clone urls embed the provider's userinfo convention", () => {
    expect(cloneUrlFor(gh)).toBe("https://github.com/Acme/Site.git");
    expect(cloneUrlFor(gh, "tok-gh")).toBe(
      "https://x-access-token:tok-gh@github.com/Acme/Site.git",
    );
    expect(cloneUrlFor(gl, "tok-gl")).toBe(
      "https://oauth2:tok-gl@gitlab.acme.com/group/sub/project.git",
    );
    expect(cloneUrlFor(gl, "a/b")).toBe(
      "https://oauth2:a%2Fb@gitlab.acme.com/group/sub/project.git",
    );
  });
});
