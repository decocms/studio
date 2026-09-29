import { describe, expect, it } from "bun:test";
import {
  grantCoversRepo,
  grantScopeFor,
  parseGrantSecrets,
  signCallbackGrant,
  verifyCallbackGrant,
} from "./callback-grant";

const SECRET = "s".repeat(32);
const TENANT = { orgId: "org_1", userId: "user_1", orgSlug: "acme" };
const repo = (over: Record<string, string>) => ({
  cloneUrl: "https://x-access-token:ghs_1@github.com/Acme/Site.git",
  userName: "u",
  userEmail: "u@example.com",
  ...over,
});

describe("grantScopeFor", () => {
  it("is null without a tenant: nothing to mint for", () => {
    expect(grantScopeFor({ repo: repo({ connectionId: "c1" }) })).toBeNull();
  });

  it("names every repo by what its mint trusts", () => {
    expect(
      grantScopeFor({
        tenant: TENANT,
        repo: repo({ connectionId: "c1" }),
        extraRepos: [
          repo({ repositoryId: "r1", connectionId: "c1" }),
          // Not re-mintable: no connection, or not a GitHub URL.
          repo({}),
          repo({ connectionId: "c2", cloneUrl: "https://gitlab.com/a/b.git" }),
        ],
      }),
    ).toEqual({
      v: 1,
      orgId: "org_1",
      userId: "user_1",
      repos: [
        { connectionId: "c1", repo: "acme/site" },
        { repositoryId: "r1" },
      ],
    });
  });
});

describe("signCallbackGrant / verifyCallbackGrant", () => {
  const scope = grantScopeFor({
    tenant: TENANT,
    repo: repo({ connectionId: "c1" }),
  });
  if (!scope) throw new Error("expected a scope");

  it("round-trips the scope", () => {
    expect(
      verifyCallbackGrant(signCallbackGrant(scope, [SECRET]), [SECRET]),
    ).toEqual(scope);
  });

  it.each([
    ["another secret", (g: string) => g, ["x".repeat(32)]],
    ["a truncated signature", (g: string) => g.slice(0, -2), [SECRET]],
    ["an extra segment", (g: string) => `${g}.x`, [SECRET]],
    ["no secret at all", (g: string) => g, []],
  ])("refuses %s", (_label, mangle, secrets) => {
    expect(
      verifyCallbackGrant(mangle(signCallbackGrant(scope, [SECRET])), secrets),
    ).toBeNull();
  });

  it("refuses to sign without a secret", () => {
    expect(() => signCallbackGrant(scope, [])).toThrow();
  });

  it("matches a clone URL whatever credential it embeds", () => {
    expect(
      grantCoversRepo(scope, {
        connectionId: "c1",
        cloneUrl: "https://x-access-token:ghs_stale@github.com/acme/site",
      }),
    ).toBe(true);
    expect(
      grantCoversRepo(scope, {
        connectionId: "c1",
        cloneUrl: "https://github.com/acme/other.git",
      }),
    ).toBe(false);
  });
});

describe("parseGrantSecrets", () => {
  it("splits, trims and drops empties", () => {
    expect(parseGrantSecrets(" a , ,b,")).toEqual(["a", "b"]);
    expect(parseGrantSecrets(undefined)).toEqual([]);
  });
});
