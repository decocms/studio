import { describe, expect, it } from "bun:test";

import {
  claimTemplateName,
  claimWarmPoolName,
  resolveClaimTemplateName,
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
    expect(
      resolveTenantPool(POOLS, { orgId: "org-acme", cloneUrl: url })?.name,
    ).toBe("tenant-acme-site");
  });

  it("a harness-run claim never takes a tenant pod", () => {
    // The Claude Code dispatch path. It wants no dev server, and binding a warm
    // pod would stop the one already running on it.
    expect(
      resolveTenantPool(POOLS, {
        orgId: "org-acme",
        cloneUrl: url,
        purpose: "harness-run",
      }),
    ).toBeNull();
    // ...but an explicit `interactive` is a normal claim.
    expect(
      resolveTenantPool(POOLS, {
        orgId: "org-acme",
        cloneUrl: url,
        purpose: "interactive",
      })?.name,
    ).toBe("tenant-acme-site");
  });

  it("a user of another org never resolves this pool", () => {
    expect(
      resolveTenantPool(POOLS, { orgId: "org-other", cloneUrl: url }),
    ).toBeNull();
  });

  it("the same org on another repo does not resolve it", () => {
    expect(
      resolveTenantPool(POOLS, {
        orgId: "org-acme",
        cloneUrl: "https://github.com/acme/other.git",
      }),
    ).toBeNull();
  });

  it("no org or no repo → no pool", () => {
    expect(
      resolveTenantPool(POOLS, { orgId: undefined, cloneUrl: url }),
    ).toBeNull();
    expect(
      resolveTenantPool(POOLS, { orgId: "org-acme", cloneUrl: undefined }),
    ).toBeNull();
  });

  it("no pools configured → no pool", () => {
    expect(
      resolveTenantPool([] as TenantPool[], {
        orgId: "org-acme",
        cloneUrl: url,
      }),
    ).toBeNull();
  });
});

// The one line that actually binds a tenant pod. Get it wrong and either the
// claim waits on a cold pod (pool silently useless) or — worse — it names a
// pool belonging to nobody it should reach.
describe("claimWarmPoolName", () => {
  it("a resolved pool binds that pool", () => {
    expect(claimWarmPoolName(POOLS[0] ?? null, true, "studio-sandbox")).toBe(
      "tenant-acme-site",
    );
  });

  // Never the literal "default": that matches no SandboxWarmPool, and the
  // operator's fallback then binds any warm pod of the template — including
  // another org's tenant pool, whose repo is already cloned (409 cloneUrl).
  it("no pool in warm-pool mode names the generic pool explicitly", () => {
    expect(claimWarmPoolName(null, true, "studio-sandbox")).toBe(
      "studio-sandbox",
    );
  });

  it("no sentinel → `none`, so the operator still accepts per-claim env", () => {
    expect(claimWarmPoolName(null, false, "studio-sandbox")).toBe("none");
  });
});

describe("claimTemplateName", () => {
  it("a harness run takes the -medium template", () => {
    expect(claimTemplateName("harness-run", "studio-sandbox")).toBe(
      "studio-sandbox-medium",
    );
  });

  it("interactive claims stay on the default template", () => {
    expect(claimTemplateName("interactive", "studio-sandbox")).toBe(
      "studio-sandbox",
    );
    expect(claimTemplateName(undefined, "studio-sandbox")).toBe(
      "studio-sandbox",
    );
  });

  // Pool name == template name, so a harness claim can't bind a 4Gi pod.
  it("the warm pool follows the template it picked", () => {
    expect(
      claimWarmPoolName(
        null,
        true,
        claimTemplateName("harness-run", "studio-sandbox"),
      ),
    ).toBe("studio-sandbox-medium");
  });

  // With tenant pools ruled out above, these two are the whole matrix.
  it("an interactive claim names the default pool, not the medium one", () => {
    expect(
      claimWarmPoolName(
        null,
        true,
        claimTemplateName("interactive", "studio-sandbox"),
      ),
    ).toBe("studio-sandbox");
  });
});

describe("resolveClaimTemplateName", () => {
  const base = {
    templateName: "studio-sandbox",
    now: 1_000_000,
    ttlMs: 60_000,
  };

  it("never probes for an interactive claim", async () => {
    let probes = 0;
    const result = await resolveClaimTemplateName({
      ...base,
      purpose: "interactive",
      probe: null,
      exists: async () => {
        probes++;
        return true;
      },
    });
    expect(result.name).toBe("studio-sandbox");
    expect(probes).toBe(0);
  });

  it("uses -medium when the cluster has it", async () => {
    const result = await resolveClaimTemplateName({
      ...base,
      purpose: "harness-run",
      probe: null,
      exists: async (name) => name === "studio-sandbox-medium",
    });
    expect(result.name).toBe("studio-sandbox-medium");
    expect(result.probe).toEqual({ checkedAt: base.now, present: true });
  });

  // Studio ahead of the chart: that claim would park at TemplateNotFound.
  it("falls back to the default template when -medium is absent", async () => {
    const warned: string[] = [];
    const result = await resolveClaimTemplateName({
      ...base,
      purpose: "harness-run",
      probe: null,
      exists: async () => false,
      onAbsent: (name) => warned.push(name),
    });
    expect(result.name).toBe("studio-sandbox");
    expect(result.probe).toEqual({ checkedAt: base.now, present: false });
    expect(warned).toEqual(["studio-sandbox-medium"]);
  });

  it("reuses a fresh probe instead of hitting the API per claim", async () => {
    let probes = 0;
    const result = await resolveClaimTemplateName({
      ...base,
      purpose: "harness-run",
      probe: { checkedAt: base.now - 59_999, present: true },
      exists: async () => {
        probes++;
        return true;
      },
    });
    expect(result.name).toBe("studio-sandbox-medium");
    expect(probes).toBe(0);
  });

  it("re-probes once the TTL is up, so an upgrade heals on its own", async () => {
    const result = await resolveClaimTemplateName({
      ...base,
      purpose: "harness-run",
      probe: { checkedAt: base.now - 60_000, present: false },
      exists: async () => true,
    });
    expect(result.name).toBe("studio-sandbox-medium");
    expect(result.probe).toEqual({ checkedAt: base.now, present: true });
  });

  it("warns once per absence, not once per claim", async () => {
    const warned: string[] = [];
    const first = await resolveClaimTemplateName({
      ...base,
      purpose: "harness-run",
      probe: null,
      exists: async () => false,
      onAbsent: (name) => warned.push(name),
    });
    await resolveClaimTemplateName({
      ...base,
      purpose: "harness-run",
      probe: first.probe,
      exists: async () => false,
      onAbsent: (name) => warned.push(name),
    });
    expect(warned).toEqual(["studio-sandbox-medium"]);
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
