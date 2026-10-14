import { describe, expect, it } from "bun:test";

import {
  allocationsMatchingPush,
  allocationWarmPoolName,
  claimTemplateName,
  claimWarmPoolName,
  normalizeRepoUrl,
  renderTenantPoolWarmPools,
  resolveClaimTemplateName,
  resolveTenantPoolBinding,
  type TenantPool,
  type TenantPoolInput,
  tenantPoolSchema,
  TenantPoolState,
} from "./tenant-pools";

const SITE = "https://github.com/Acme/Site";
const DOCS = "https://github.com/acme/docs";

function pool(overrides: Partial<TenantPoolInput> = {}): TenantPool {
  return tenantPoolSchema.parse({
    name: "acme",
    tenant: "org-acme",
    size: 4,
    repos: [
      { repoUrl: SITE, replicas: 2 },
      { repoUrl: SITE, branch: "develop", replicas: 1 },
    ],
    ...overrides,
  });
}

describe("normalizeRepoUrl", () => {
  it("strips credentials, .git and a trailing slash, and lowercases the host", () => {
    expect(
      normalizeRepoUrl("https://x-access-token:tok@GitHub.com/Acme/Site.git/"),
    ).toBe("https://github.com/Acme/Site");
    expect(normalizeRepoUrl("https://gitlab.com/group/sub/proj")).toBe(
      "https://gitlab.com/group/sub/proj",
    );
  });

  it("refuses anything but a plain https clone URL", () => {
    for (const bad of [
      "git@github.com:acme/site.git",
      "http://github.com/acme/site",
      "https://github.com/",
      "https://github.com/acme/site?token=x",
      "acme/site",
    ]) {
      expect(normalizeRepoUrl(bad)).toBeNull();
    }
  });
});

describe("tenantPoolSchema", () => {
  it("defaults image, branch and workload, and stores the normalized URL", () => {
    const parsed = tenantPoolSchema.parse({
      name: "acme",
      tenant: "t",
      size: 1,
      repos: [{ repoUrl: "https://u:p@github.com/Acme/Site.git", replicas: 1 }],
    });
    expect(parsed).toEqual({
      name: "acme",
      tenant: "t",
      size: 1,
      image: "default",
      repos: [
        {
          repoUrl: SITE,
          branch: "main",
          workload: { runtime: "node" },
          replicas: 1,
        },
      ],
    });
  });

  it("takes a pool with no repos", () => {
    expect(pool({ repos: undefined }).repos).toEqual([]);
  });

  it("refuses repos that take more replicas than the pool's size", () => {
    expect(() => pool({ size: 2 })).toThrow(/more than its size 2/);
  });

  it("refuses the same repo and branch twice, whatever the URL's case", () => {
    expect(() =>
      pool({
        repos: [
          { repoUrl: SITE, replicas: 1 },
          { repoUrl: "https://github.com/acme/site.git", replicas: 1 },
        ],
      }),
    ).toThrow(/duplicate repo allocation/);
  });

  it("refuses a name that leaves no room for the allocation suffix, or is not a DNS label", () => {
    expect(() => pool({ name: "a".repeat(55) })).toThrow();
    expect(() => pool({ name: "Acme_Pool" })).toThrow();
    expect(pool({ name: "a".repeat(54) }).name).toHaveLength(54);
  });

  it("refuses an empty tenant, a zero size or replica, and a credential-bearing non-https URL", () => {
    expect(() => pool({ tenant: "" })).toThrow();
    expect(() => pool({ size: 0, repos: [] })).toThrow();
    expect(() => pool({ repos: [{ repoUrl: SITE, replicas: 0 }] })).toThrow();
    expect(() =>
      pool({
        repos: [{ repoUrl: "git@github.com:acme/site.git", replicas: 1 }],
      }),
    ).toThrow();
  });
});

describe("renderTenantPoolWarmPools", () => {
  it("renders one pool per allocation and the blank remainder, on the image's -medium template", () => {
    const acme = pool({ image: "android" });
    const rendered = renderTenantPoolWarmPools(acme, { templateName: "sbx" });
    const [site, develop] = acme.repos;
    expect(rendered.map((p) => [p.metadata.name, p.spec.replicas])).toEqual([
      [allocationWarmPoolName("acme", site!), 2],
      [allocationWarmPoolName("acme", develop!), 1],
      ["acme", 1],
    ]);
    for (const warmPool of rendered) {
      expect(warmPool.metadata.name).toMatch(/^acme(-[0-9a-f]{8})?$/);
      expect(warmPool.kind).toBe("SandboxWarmPool");
      expect(warmPool.spec).toMatchObject({
        updateStrategy: { type: "OnReplenish" },
        sandboxTemplateRef: { name: "sbx-android-medium" },
      });
    }
  });

  it("names allocations by repo and branch, stably", () => {
    const a = allocationWarmPoolName("acme", { repoUrl: SITE, branch: "main" });
    expect(a).toBe(
      allocationWarmPoolName("acme", { repoUrl: SITE, branch: "main" }),
    );
    expect(a).not.toBe(
      allocationWarmPoolName("acme", { repoUrl: SITE, branch: "develop" }),
    );
    expect(
      allocationWarmPoolName("a".repeat(54), { repoUrl: SITE, branch: "main" }),
    ).toHaveLength(63);
  });

  it("renders the blank pool at 0 when the repos take every replica, so a shrink applies", () => {
    const full = pool({ size: 3 });
    const blank = renderTenantPoolWarmPools(full, { templateName: "sbx" }).at(
      -1,
    );
    expect(blank?.metadata.name).toBe("acme");
    expect(blank?.spec.replicas).toBe(0);
    expect(blank?.spec.sandboxTemplateRef.name).toBe("sbx-medium");
  });

  it("renders only the blank pool for a pool with no repos", () => {
    expect(
      renderTenantPoolWarmPools(pool({ repos: [] }), {
        templateName: "sbx",
      }).map((p) => [p.metadata.name, p.spec.replicas]),
    ).toEqual([["acme", 4]]);
  });

  it("uses an allocation's explicit warm pool name", () => {
    const legacy: TenantPool = {
      ...pool({ size: 1, repos: [] }),
      repos: [
        {
          repoUrl: SITE,
          branch: "main",
          workload: { runtime: "node" },
          replicas: 1,
          warmPoolName: "tenant-acme-site-prod",
        },
      ],
    };
    expect(
      renderTenantPoolWarmPools(legacy, { templateName: "sbx" })[0]?.metadata
        .name,
    ).toBe("tenant-acme-site-prod");
  });
});

describe("resolveTenantPoolBinding", () => {
  const acme = pool();
  const claim = {
    tenant: "org-acme",
    image: "default",
    cloneUrl: "https://x-access-token:tok@github.com/acme/site.git",
    branch: "main",
  };
  const [site, develop] = acme.repos;

  it("binds the allocation for the claim's repo, preferring its branch", () => {
    expect(resolveTenantPoolBinding([acme], claim)).toEqual({
      pool: acme,
      repo: site!,
      warmPoolName: allocationWarmPoolName("acme", site!),
    });
    expect(
      resolveTenantPoolBinding([acme], { ...claim, branch: "develop" })?.repo,
    ).toBe(develop!);
  });

  it("takes any allocation for the repo when no branch matches", () => {
    expect(
      resolveTenantPoolBinding([acme], { ...claim, branch: "thread/x" })?.repo
        ?.repoUrl,
    ).toBe(SITE);
  });

  it("falls back to the tenant's blank pods for another repo or no repo", () => {
    const blank = { pool: acme, repo: null, warmPoolName: "acme" };
    expect(
      resolveTenantPoolBinding([acme], { ...claim, cloneUrl: `${DOCS}.git` }),
    ).toEqual(blank);
    expect(
      resolveTenantPoolBinding([acme], { ...claim, cloneUrl: undefined }),
    ).toEqual(blank);
  });

  it("goes generic when the tenant's pool has no blank replicas left", () => {
    expect(
      resolveTenantPoolBinding([pool({ size: 3 })], {
        ...claim,
        cloneUrl: undefined,
      }),
    ).toBeNull();
  });

  it("never binds another tenant's pool, or a claim with no tenant", () => {
    expect(
      resolveTenantPoolBinding([acme], { ...claim, tenant: "org-other" }),
    ).toBeNull();
    expect(
      resolveTenantPoolBinding([acme], { ...claim, tenant: undefined }),
    ).toBeNull();
  });

  it("binds only a pool built for the claim's image", () => {
    expect(
      resolveTenantPoolBinding([acme], { ...claim, image: "android" }),
    ).toBeNull();
    const android = pool({ name: "acme-android", image: "android" });
    expect(
      resolveTenantPoolBinding([acme, android], { ...claim, image: "android" })
        ?.pool.name,
    ).toBe("acme-android");
  });

  it("prefers another pool's allocation over this pool's blank pods", () => {
    const blankOnly = pool({ name: "acme-blank", repos: [] });
    const docs = pool({
      name: "acme-docs",
      repos: [{ repoUrl: DOCS, replicas: 1 }],
    });
    expect(
      resolveTenantPoolBinding([blankOnly, docs], {
        ...claim,
        cloneUrl: DOCS,
      })?.pool.name,
    ).toBe("acme-docs");
  });
});

// The one line that actually binds a tenant pod. Get it wrong and either the
// claim waits on a cold pod (pool silently useless) or — worse — it names a
// pool belonging to nobody it should reach.
describe("claimWarmPoolName", () => {
  it("a binding names its warm pool", () => {
    const acme = pool();
    expect(
      claimWarmPoolName(
        { pool: acme, repo: null, warmPoolName: "acme" },
        true,
        "studio-sandbox",
      ),
    ).toBe("acme");
  });

  // Never the literal "default": that matches no SandboxWarmPool, and the
  // operator's fallback then binds any warm pod of the template — including
  // another org's tenant pool, whose repo is already cloned (409 cloneUrl).
  it("no binding in warm-pool mode names the generic pool explicitly", () => {
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
      probes: {},
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
      probes: {},
      exists: async (name) => name === "studio-sandbox-medium",
    });
    expect(result.name).toBe("studio-sandbox-medium");
    expect(result.probes["studio-sandbox-medium"]).toEqual({
      checkedAt: base.now,
      present: true,
    });
  });

  // Studio ahead of the chart: that claim would park at TemplateNotFound.
  it("falls back to the default template when -medium is absent", async () => {
    const warned: string[] = [];
    const result = await resolveClaimTemplateName({
      ...base,
      purpose: "harness-run",
      probes: {},
      exists: async () => false,
      onAbsent: (name) => warned.push(name),
    });
    expect(result.name).toBe("studio-sandbox");
    expect(result.probes["studio-sandbox-medium"]).toEqual({
      checkedAt: base.now,
      present: false,
    });
    expect(warned).toEqual(["studio-sandbox-medium"]);
  });

  it("reuses a fresh probe instead of hitting the API per claim", async () => {
    let probes = 0;
    const result = await resolveClaimTemplateName({
      ...base,
      purpose: "harness-run",
      probes: {
        "studio-sandbox-medium": {
          checkedAt: base.now - 59_999,
          present: true,
        },
      },
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
      probes: {
        "studio-sandbox-medium": {
          checkedAt: base.now - 60_000,
          present: false,
        },
      },
      exists: async () => true,
    });
    expect(result.name).toBe("studio-sandbox-medium");
    expect(result.probes["studio-sandbox-medium"]).toEqual({
      checkedAt: base.now,
      present: true,
    });
  });

  it("warns once per absence, not once per claim", async () => {
    const warned: string[] = [];
    const first = await resolveClaimTemplateName({
      ...base,
      purpose: "harness-run",
      probes: {},
      exists: async () => false,
      onAbsent: (name) => warned.push(name),
    });
    await resolveClaimTemplateName({
      ...base,
      purpose: "harness-run",
      probes: first.probes,
      exists: async () => false,
      onAbsent: (name) => warned.push(name),
    });
    expect(warned).toEqual(["studio-sandbox-medium"]);
  });
});

describe("claimTemplateName with an image variant", () => {
  it("suffixes the image before the size", () => {
    expect(claimTemplateName("interactive", "sbx", false, "android")).toBe(
      "sbx-android",
    );
    expect(claimTemplateName("harness-run", "sbx", false, "android")).toBe(
      "sbx-android-medium",
    );
  });

  it("treats the default image as no suffix at all", () => {
    expect(claimTemplateName("interactive", "sbx", false, "default")).toBe(
      "sbx",
    );
    expect(claimTemplateName("harness-run", "sbx", false, "default")).toBe(
      "sbx-medium",
    );
  });
});

describe("resolveClaimTemplateName with an image variant", () => {
  const base = { templateName: "sbx", now: 1_000_000, ttlMs: 60_000 };

  it("probes and uses the variant template", async () => {
    const result = await resolveClaimTemplateName({
      ...base,
      purpose: "interactive",
      sandboxImage: "android",
      probes: {},
      exists: async (name) => name === "sbx-android",
    });
    expect(result.name).toBe("sbx-android");
  });

  // A chart that predates image variants: better the default image than a
  // claim parked at TemplateNotFound.
  it("falls back to the base template when the variant is absent", async () => {
    const result = await resolveClaimTemplateName({
      ...base,
      purpose: "interactive",
      sandboxImage: "android",
      probes: {},
      exists: async () => false,
    });
    expect(result.name).toBe("sbx");
  });

  it("keeps the -medium ceiling when only the variant is absent", async () => {
    const result = await resolveClaimTemplateName({
      ...base,
      purpose: "harness-run",
      sandboxImage: "android",
      probes: {},
      exists: async (name) => name === "sbx-medium",
    });
    expect(result.name).toBe("sbx-medium");
  });

  // One slot would thrash: an interactive android claim and a harness-run one
  // ask for different names, and each would invalidate the other's answer.
  it("caches each derived name separately", async () => {
    const asked: string[] = [];
    const exists = async (name: string) => {
      asked.push(name);
      return true;
    };
    const first = await resolveClaimTemplateName({
      ...base,
      purpose: "interactive",
      sandboxImage: "android",
      probes: {},
      exists,
    });
    const second = await resolveClaimTemplateName({
      ...base,
      purpose: "harness-run",
      sandboxImage: "android",
      probes: first.probes,
      exists,
    });
    const third = await resolveClaimTemplateName({
      ...base,
      purpose: "interactive",
      sandboxImage: "android",
      probes: second.probes,
      exists,
    });
    expect(first.name).toBe("sbx-android");
    expect(second.name).toBe("sbx-android-medium");
    expect(third.name).toBe("sbx-android");
    // Two distinct names probed once each; the third call reused the cache.
    expect(asked).toEqual(["sbx-android", "sbx-android-medium"]);
  });
});

describe("allocationsMatchingPush", () => {
  const acme = pool();
  const names = (repoUrl: string, ref: string) =>
    allocationsMatchingPush([acme], repoUrl, ref).map((a) => a.repo.branch);

  it("matches the allocation's branch, case-insensitively on the repo", () => {
    expect(names("https://github.com/acme/SITE", "refs/heads/main")).toEqual([
      "main",
    ]);
    expect(names(`${SITE}.git`, "refs/heads/develop")).toEqual(["develop"]);
  });

  it("ignores another branch, a tag push and another repo", () => {
    expect(names(SITE, "refs/heads/feature")).toEqual([]);
    expect(names(SITE, "refs/tags/main")).toEqual([]);
    expect(names(DOCS, "refs/heads/main")).toEqual([]);
  });
});

describe("claimTemplateName with a tenant pool", () => {
  // The operator binds warm pods by TEMPLATE HASH, so a claim naming a template
  // the pool's pods were not built from gets a cold pod and no error. Tenant
  // pools are rendered from `-medium` (the template harness runs already
  // claim), so both kinds must name it or the pool is unreachable — which is
  // exactly how four warm pods sat idle while every task run started cold.
  it("names -medium for a tenant-pool claim, whatever the purpose", () => {
    expect(claimTemplateName("interactive", "sbx", true)).toBe("sbx-medium");
    expect(claimTemplateName("harness-run", "sbx", true)).toBe("sbx-medium");
    expect(claimTemplateName("interactive", "sbx", true, "android")).toBe(
      "sbx-android-medium",
    );
  });

  it("leaves a non-pool interactive claim on the default template", () => {
    expect(claimTemplateName("interactive", "sbx", false)).toBe("sbx");
    expect(claimTemplateName(undefined, "sbx")).toBe("sbx");
  });
});

describe("TenantPoolState", () => {
  const acme = pool({ repos: [{ repoUrl: SITE, replicas: 1 }] });
  const docs = pool({
    name: "acme-docs",
    repos: [{ repoUrl: DOCS, replicas: 1 }],
  });
  const docsPool = allocationWarmPoolName("acme-docs", docs.repos[0]!);
  const acmePool = allocationWarmPoolName("acme", acme.repos[0]!);
  const claim = {
    tenant: "org-acme",
    image: "default",
    cloneUrl: `${DOCS}.git`,
    branch: undefined,
  };
  const podState = (pool: string) => ({
    pool,
    lastConfigAt: 1,
    lastFailureAt: 0,
    failures: 0,
  });
  const allocations = (pools: readonly TenantPool[]) =>
    pools.flatMap((p) =>
      p.repos.map((repo) => ({
        pool: p,
        repo,
        warmPoolName: allocationWarmPoolName(p.name, repo),
      })),
    );

  it("binds a pool the host added after construction on the next read", () => {
    let pools: readonly TenantPool[] = [];
    const state = new TenantPoolState(() => pools);
    expect(state.resolve(claim)).toBeNull();
    expect(state.markDirty(DOCS, "refs/heads/main")).toEqual([]);

    pools = [acme, docs];
    expect(state.resolve(claim)?.warmPoolName).toBe(docsPool);
    expect(state.markDirty(DOCS, "refs/heads/main")).toEqual([docsPool]);
  });

  it("drops a removed allocation's dirty flag and pod state, and reports it once", () => {
    let pools: readonly TenantPool[] = [acme, docs];
    const state = new TenantPoolState(() => pools);
    expect(state.retain(allocations(state.pools()))).toEqual([]);
    state.markDirty(DOCS, "main");
    state.setPod("uid-docs", podState(docsPool));
    state.setPod("uid-acme", podState(acmePool));

    pools = [acme];
    expect(state.resolve(claim)?.repo).toBeNull();
    expect(
      state.retain(allocations(state.pools())).map((a) => a.warmPoolName),
    ).toEqual([docsPool]);
    expect(state.takeDirty(docsPool)).toBe(false);
    expect(state.pod("uid-docs")).toBeUndefined();
    expect(state.pod("uid-acme")).toEqual(podState(acmePool));
    expect(state.retain(allocations(state.pools()))).toEqual([]);
  });

  it("forgets only the listed allocation's vanished pods", () => {
    const state = new TenantPoolState(() => [acme, docs]);
    state.setPod("uid-docs", podState(docsPool));
    state.setPod("uid-acme", podState(acmePool));
    state.retainPods(acmePool, new Set());
    expect(state.pod("uid-acme")).toBeUndefined();
    expect(state.pod("uid-docs")).toEqual(podState(docsPool));
  });
});
