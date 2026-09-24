import { describe, expect, it } from "bun:test";

import { parseTenantPools, repoKeyFromCloneUrl } from "./tenant-pools";

const POOLS = parseTenantPools(
  JSON.stringify([
    {
      name: "tenant-acme-site",
      orgId: "org-acme",
      repo: "Acme/Site",
      connectionId: "conn-1",
    },
  ]),
);

describe("parseTenantPools", () => {
  it("defaults branch and workload", () => {
    expect(POOLS[0]).toMatchObject({
      branch: "main",
      workload: { runtime: "node" },
    });
  });

  it("unset/empty → no pools", () => {
    expect(parseTenantPools(undefined)).toEqual([]);
    expect(parseTenantPools("  ")).toEqual([]);
  });

  it("rejects a pool name that is not a DNS label", () => {
    expect(() =>
      parseTenantPools(
        JSON.stringify([
          { name: "Tenant_Acme", orgId: "o", repo: "a/b", connectionId: "c" },
        ]),
      ),
    ).toThrow();
  });

  it("rejects a repo that is not owner/name", () => {
    expect(() =>
      parseTenantPools(
        JSON.stringify([
          { name: "p", orgId: "o", repo: "just-a-name", connectionId: "c" },
        ]),
      ),
    ).toThrow();
  });

  it("rejects duplicate pool names", () => {
    const one = { name: "p", orgId: "o", repo: "a/b", connectionId: "c" };
    expect(() => parseTenantPools(JSON.stringify([one, one]))).toThrow(
      /duplicate pool name/,
    );
  });
});

describe("repoKeyFromCloneUrl", () => {
  it("strips credentials, .git, and case", () => {
    expect(
      repoKeyFromCloneUrl(
        "https://x-access-token:tok@github.com/Acme/Site.git",
      ),
    ).toBe("acme/site");
  });

  it("returns null for a non-URL", () => {
    expect(repoKeyFromCloneUrl("git@github.com:acme/site.git")).toBeNull();
  });
  it("is null for any host other than github.com", () => {
    expect(
      repoKeyFromCloneUrl("https://oauth2:tok@gitlab.com/acme/site.git"),
    ).toBeNull();
    expect(
      repoKeyFromCloneUrl("https://gitlab.acme.com/acme/site.git"),
    ).toBeNull();
  });
});
