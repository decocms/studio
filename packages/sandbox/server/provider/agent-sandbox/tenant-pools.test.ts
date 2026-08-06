import { describe, expect, it } from "bun:test";

import {
  claimWarmPoolName,
  parseTenantPools,
  poolsMatchingPush,
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

// The one line that actually binds a tenant pod. Get it wrong and either the
// claim waits on a cold pod (pool silently useless) or — worse — it names a
// pool belonging to nobody it should reach.
describe("claimWarmPoolName", () => {
  it("a resolved pool binds that pool", () => {
    expect(claimWarmPoolName(POOLS[0] ?? null, true)).toBe("tenant-acme-site");
  });

  it("no pool in warm-pool mode falls back to the generic pool", () => {
    expect(claimWarmPoolName(null, true)).toBe("default");
  });

  it("no sentinel → `none`, so the operator still accepts per-claim env", () => {
    expect(claimWarmPoolName(null, false)).toBe("none");
  });
});

describe("poolsMatchingPush", () => {
  it("matches the pool's branch, case-insensitively on the repo", () => {
    expect(
      poolsMatchingPush(POOLS, "acme/SITE", "refs/heads/main").map(
        (p) => p.name,
      ),
    ).toEqual(["tenant-acme-site"]);
  });

  it("ignores a push to another branch", () => {
    expect(poolsMatchingPush(POOLS, "Acme/Site", "refs/heads/dev")).toEqual([]);
  });

  it("ignores a tag push (refs/tags is not refs/heads)", () => {
    expect(poolsMatchingPush(POOLS, "Acme/Site", "refs/tags/main")).toEqual([]);
  });

  it("ignores another repo", () => {
    expect(poolsMatchingPush(POOLS, "acme/other", "refs/heads/main")).toEqual(
      [],
    );
  });
});
