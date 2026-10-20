import { describe, expect, it } from "bun:test";
import {
  allocationsMatchingPush,
  resolveTenantPoolBinding,
  tenantPoolAllocations,
} from "@decocms/sandbox/provider/agent-sandbox";
import {
  legacyPoolCloneUrlMinter,
  legacyPoolMintRequest,
  legacyTenantPools,
  parseLegacyTenantPools,
} from "./legacy-tenant-pools";

const ENTRIES = parseLegacyTenantPools(
  JSON.stringify([
    {
      name: "tenant-acme-site-prod",
      orgId: "org-acme",
      repo: "Acme/Site",
      connectionId: "conn-1",
      workload: { runtime: "bun", packageManager: "bun", devPort: 3000 },
    },
    { name: "tenant-acme-docs-prod", orgId: "org-acme", repo: "acme/docs" },
  ]),
);
const POOLS = legacyTenantPools(ENTRIES);
const claim = {
  tenant: "org-acme",
  image: "default",
  cloneUrl: "https://x-access-token:tok@github.com/acme/site.git",
  branch: "sandbox/thread-1",
};

describe("parseLegacyTenantPools", () => {
  it("defaults branch and workload, and treats unset or blank as no pools", () => {
    expect(ENTRIES[1]).toMatchObject({
      branch: "main",
      workload: { runtime: "node" },
    });
    expect(parseLegacyTenantPools(undefined)).toEqual([]);
    expect(parseLegacyTenantPools("  ")).toEqual([]);
  });

  it("rejects a non-DNS name, a repo that is not owner/name, and duplicate names", () => {
    const one = { name: "p", orgId: "o", repo: "a/b" };
    for (const bad of [
      [{ ...one, name: "Tenant_Acme" }],
      [{ ...one, repo: "just-a-name" }],
      [one, one],
    ]) {
      expect(() => parseLegacyTenantPools(JSON.stringify(bad))).toThrow();
    }
  });
});

describe("a legacy entry", () => {
  it("binds the SandboxWarmPool the chart renders under the entry's name", () => {
    expect(resolveTenantPoolBinding(POOLS, claim)).toMatchObject({
      warmPoolName: "tenant-acme-site-prod",
      pool: { tenant: "org-acme", image: "default" },
      repo: { repoUrl: "https://github.com/Acme/Site", branch: "main" },
    });
  });

  it("leaves other orgs, other repos and other images on the generic pool", () => {
    for (const other of [
      { ...claim, tenant: "org-other" },
      { ...claim, cloneUrl: "https://github.com/acme/other.git" },
      { ...claim, cloneUrl: undefined },
      { ...claim, image: "android" },
    ]) {
      expect(resolveTenantPoolBinding(POOLS, other)).toBeNull();
    }
  });

  it("warms the pods of the entry's SandboxWarmPool with its branch and workload", () => {
    expect(
      tenantPoolAllocations(POOLS).map(({ warmPoolName, repo }) => ({
        warmPoolName,
        branch: repo.branch,
        workload: repo.workload,
      })),
    ).toEqual([
      {
        warmPoolName: "tenant-acme-site-prod",
        branch: "main",
        workload: { runtime: "bun", packageManager: "bun", devPort: 3000 },
      },
      {
        warmPoolName: "tenant-acme-docs-prod",
        branch: "main",
        workload: { runtime: "node" },
      },
    ]);
  });

  it("mints the clone from the entry's connection, and clones a public repo anonymously", async () => {
    const [site, docs] = tenantPoolAllocations(POOLS);
    const request = (allocation: typeof site) =>
      legacyPoolMintRequest(ENTRIES, {
        tenant: allocation!.pool.tenant,
        repoUrl: allocation!.repo.repoUrl,
        branch: allocation!.repo.branch,
      });
    expect(request(site)).toEqual({
      cloneUrl: "https://github.com/Acme/Site.git",
      connectionId: "conn-1",
    });
    expect(request(docs)).toEqual({
      cloneUrl: "https://github.com/acme/docs.git",
    });

    const mint = legacyPoolCloneUrlMinter(ENTRIES, async ({ cloneUrl }) =>
      cloneUrl.replace("https://", "https://x-access-token:t@"),
    );
    expect(
      await mint({
        tenant: "org-acme",
        repoUrl: "https://github.com/Acme/Site",
        branch: "main",
      }),
    ).toBe("https://x-access-token:t@github.com/Acme/Site.git");
    expect(
      await mint({
        tenant: "org-acme",
        repoUrl: "https://github.com/acme/docs",
        branch: "main",
      }),
    ).toBe("https://github.com/acme/docs.git");
    expect(
      await mint({
        tenant: "org-other",
        repoUrl: "https://github.com/Acme/Site",
        branch: "main",
      }),
    ).toBeNull();
  });

  it("is marked stale by a GitHub push to its repo and branch", () => {
    const stale = (repo: string, ref: string) =>
      allocationsMatchingPush(POOLS, `https://github.com/${repo}`, ref).map(
        (allocation) => allocation.warmPoolName,
      );
    expect(stale("acme/SITE", "refs/heads/main")).toEqual([
      "tenant-acme-site-prod",
    ]);
    expect(stale("Acme/Site", "refs/heads/dev")).toEqual([]);
  });
});
