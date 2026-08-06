import { describe, expect, it } from "bun:test";

import {
  parseTenantPools,
  repoKeyFromCloneUrl,
  resolveTenantPool,
  type TenantPool,
} from "./tenant-pools";

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
});

describe("resolveTenantPool", () => {
  const url = "https://x-access-token:tok@github.com/acme/site.git";

  it("matches on org + repo", () => {
    expect(resolveTenantPool(POOLS, "org-acme", url)?.name).toBe(
      "tenant-acme-site",
    );
  });

  it("a user of another org never resolves this pool", () => {
    expect(resolveTenantPool(POOLS, "org-other", url)).toBeNull();
  });

  it("the same org on another repo does not resolve it", () => {
    expect(
      resolveTenantPool(POOLS, "org-acme", "https://github.com/acme/other.git"),
    ).toBeNull();
  });

  it("no org or no repo → no pool", () => {
    expect(resolveTenantPool(POOLS, undefined, url)).toBeNull();
    expect(resolveTenantPool(POOLS, "org-acme", undefined)).toBeNull();
  });

  it("no pools configured → no pool", () => {
    expect(resolveTenantPool([] as TenantPool[], "org-acme", url)).toBeNull();
  });
});
