import { describe, expect, it } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import { SecretNotFoundError } from "../../storage/secrets";
import {
  mergeGitCredentials,
  resolveSubmoduleCredentials,
} from "./resolve-submodule-creds";

describe("mergeGitCredentials", () => {
  const org = [
    { host: "github.com", token: "org-github" },
    { host: "gitlab.com", token: "org-gitlab" },
  ];

  it("is the organization's list when the project has none", () => {
    expect(mergeGitCredentials(org, [])).toEqual(org);
  });

  it("adds a host only the project names", () => {
    expect(
      mergeGitCredentials(org, [{ host: "gitea.example.com", token: "p" }]),
    ).toEqual([...org, { host: "gitea.example.com", token: "p" }]);
  });

  it("lets the project win for a host both name, leaving one entry", () => {
    expect(
      mergeGitCredentials(org, [{ host: "github.com", token: "project" }]),
    ).toEqual([
      { host: "gitlab.com", token: "org-gitlab" },
      { host: "github.com", token: "project" },
    ]);
  });

  // An organization row saved before hosts were normalized. Left beside the
  // project's it would be a second, conflicting token for the same host.
  it("matches an organization host that was saved mixed-case", () => {
    expect(
      mergeGitCredentials(
        [{ host: "GitHub.com", token: "org" }],
        [{ host: "github.com", token: "project" }],
      ),
    ).toEqual([{ host: "github.com", token: "project" }]);
  });

  it("does not mutate either list", () => {
    const project = [{ host: "github.com", token: "project" }];
    const before = JSON.stringify([org, project]);
    mergeGitCredentials(org, project);
    expect(JSON.stringify([org, project])).toBe(before);
  });
});

// Why the merge runs on resolved credentials: a project entry whose secret is
// gone must not take the organization's credential for that host down with it.
describe("a project credential that no longer resolves", () => {
  const ctx = {
    storage: {
      secrets: {
        resolveById: async (id: string) => {
          if (id === "sec_gone") throw new SecretNotFoundError(id);
          return { value: `token-for-${id}` };
        },
      },
    },
  } as unknown as StudioContext;
  const resolve = (entries: { host: string; secretId: string }[]) =>
    resolveSubmoduleCredentials({
      ctx,
      orgId: "org_1",
      userId: "user_1",
      entries,
    });

  it("falls back to the organization's for that host", async () => {
    const merged = mergeGitCredentials(
      await resolve([{ host: "github.com", secretId: "sec_org" }]),
      await resolve([
        { host: "github.com", secretId: "sec_gone" },
        { host: "gitlab.com", secretId: "sec_project" },
      ]),
    );
    expect(merged).toEqual([
      { host: "github.com", token: "token-for-sec_org" },
      { host: "gitlab.com", token: "token-for-sec_project" },
    ]);
  });
});
