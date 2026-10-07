import { describe, expect, it } from "bun:test";
import { OrgSiteConflictError } from "@/storage/org-sites";
import type { OrgSite } from "@/storage/types";
import {
  backfillSiteClaims,
  claimProjectSite,
  claimSiteSlug,
  type SiteClaimCandidate,
  type SiteClaimDeps,
} from "./claim-site";

/** An in-memory `org_sites` with the storage's claim semantics. */
function memorySites(initial: Record<string, string> = {}) {
  const owners = new Map(Object.entries(initial));
  const claims: { slug: string; organizationId: string; source?: string }[] =
    [];
  const site = (slug: string, organizationId: string): OrgSite => ({
    slug,
    organizationId,
    source: "test",
    createdBy: "t",
    createdAt: "",
    updatedBy: "t",
    updatedAt: "",
  });
  return {
    owners,
    claims,
    orgSites: {
      async getBySlug(slug: string) {
        const owner = owners.get(slug);
        return owner ? site(slug, owner) : null;
      },
      async claimSite(params: {
        slug: string;
        organizationId: string;
        source?: string;
        by: string;
      }) {
        const owner = owners.get(params.slug);
        if (owner && owner !== params.organizationId) {
          throw new OrgSiteConflictError(params.slug, owner);
        }
        owners.set(params.slug, params.organizationId);
        claims.push(params);
        return site(params.slug, params.organizationId);
      },
    } satisfies SiteClaimDeps["orgSites"],
  };
}

const noDecoSites = async () => false;
const claim = { organizationId: "org-a", by: "u1", source: "test" };

describe("claimSiteSlug", () => {
  it("claims a free slug for the org", async () => {
    const sites = memorySites();
    const deps = { orgSites: sites.orgSites, isDecoSite: noDecoSites };
    expect(await claimSiteSlug(deps, { ...claim, slug: "shop" })).toEqual({
      status: "claimed",
      slug: "shop",
    });
    expect(sites.owners.get("shop")).toBe("org-a");
  });

  it("is a no-op for a slug the org already owns", async () => {
    const sites = memorySites({ shop: "org-a" });
    const deps = { orgSites: sites.orgSites, isDecoSite: noDecoSites };
    expect(await claimSiteSlug(deps, { ...claim, slug: "shop" })).toEqual({
      status: "already-owned",
      slug: "shop",
    });
    expect(sites.claims).toEqual([]);
  });

  it("never takes a slug another org owns", async () => {
    const sites = memorySites({ shop: "org-b" });
    const deps = { orgSites: sites.orgSites, isDecoSite: noDecoSites };
    expect(await claimSiteSlug(deps, { ...claim, slug: "shop" })).toEqual({
      status: "conflict",
      slug: "shop",
      owner: "org-b",
    });
    expect(sites.owners.get("shop")).toBe("org-b");
  });

  it("leaves a deco.cx site to the deco import", async () => {
    const sites = memorySites();
    const deps = {
      orgSites: sites.orgSites,
      isDecoSite: async (slug: string) => slug === "shop",
    };
    expect(await claimSiteSlug(deps, { ...claim, slug: "shop" })).toEqual({
      status: "conflict",
      slug: "shop",
      owner: "deco.cx",
    });
    expect(sites.claims).toEqual([]);
  });

  it("reports a claim another org won in a race as a conflict", async () => {
    const sites = memorySites();
    const deps = {
      orgSites: {
        ...sites.orgSites,
        claimSite: async () => {
          throw new OrgSiteConflictError("shop", "org-b");
        },
      },
      isDecoSite: noDecoSites,
    };
    expect(await claimSiteSlug(deps, { ...claim, slug: "shop" })).toEqual({
      status: "conflict",
      slug: "shop",
      owner: "org-b",
    });
  });

  it("writes nothing on a dry run", async () => {
    const sites = memorySites();
    const deps = { orgSites: sites.orgSites, isDecoSite: noDecoSites };
    expect(
      await claimSiteSlug(deps, { ...claim, slug: "shop", dryRun: true }),
    ).toEqual({ status: "claimed", slug: "shop" });
    expect(sites.claims).toEqual([]);
  });
});

describe("claimProjectSite", () => {
  const project = { organizationId: "org-a", projectId: "p1", by: "u1" };

  it("claims the project's siteSlug", async () => {
    const sites = memorySites();
    const deps = { orgSites: sites.orgSites, isDecoSite: noDecoSites };
    expect(
      await claimProjectSite(deps, {
        ...project,
        metadata: { siteSlug: "shop" },
      }),
    ).toEqual({ status: "claimed", slug: "shop" });
    expect(sites.claims[0]?.source).toBe("project-create");
  });

  it("skips a project with no valid siteSlug", async () => {
    const sites = memorySites();
    const deps = { orgSites: sites.orgSites, isDecoSite: noDecoSites };
    for (const metadata of [null, {}, { siteSlug: "Not A Slug" }]) {
      expect(await claimProjectSite(deps, { ...project, metadata })).toBe(null);
    }
    expect(sites.claims).toEqual([]);
  });

  it("never fails the project's creation", async () => {
    const sites = memorySites();
    const deps = {
      orgSites: sites.orgSites,
      isDecoSite: async () => {
        throw new Error("supabase down");
      },
    };
    expect(
      await claimProjectSite(deps, {
        ...project,
        metadata: { siteSlug: "shop" },
      }),
    ).toBe(null);
    // Fails closed: an unanswered deco.cx lookup claims nothing.
    expect(sites.claims).toEqual([]);
  });
});

describe("backfillSiteClaims", () => {
  const candidate = (
    organizationId: string,
    projectId: string,
    slug: string,
  ): SiteClaimCandidate => ({ organizationId, projectId, slug });

  it("claims v8 projects' sites and reports everything else", async () => {
    const sites = memorySites({ owned: "org-a", taken: "org-z" });
    const candidates = [
      candidate("org-a", "p1", "free"),
      candidate("org-a", "p2", "free"),
      candidate("org-a", "p3", "owned"),
      candidate("org-a", "p4", "taken"),
      candidate("org-a", "p5", "v7-site"),
      candidate("org-a", "p6", "broken"),
      candidate("org-a", "p7", "both"),
      candidate("org-b", "p8", "both"),
      candidate("org-a", "p9", "legacy"),
    ];
    const report = await backfillSiteClaims({
      orgSites: sites.orgSites,
      isDecoSite: async (slug) => slug === "legacy",
      candidates,
      by: "admin",
      dryRun: false,
      isV8: async ({ slug }) => {
        if (slug === "broken") throw new Error("repo gone");
        return slug !== "v7-site";
      },
    });
    expect(report.claimed.map((c) => c.projectId)).toEqual(["p1", "p2"]);
    expect(report.alreadyOwned.map((c) => c.projectId)).toEqual(["p3"]);
    expect(report.conflicts).toEqual([
      { ...candidate("org-a", "p9", "legacy"), owner: "deco.cx" },
      { ...candidate("org-a", "p4", "taken"), owner: "org-z" },
    ]);
    expect(report.ambiguous).toEqual([
      { slug: "both", organizationIds: ["org-a", "org-b"] },
    ]);
    expect(report.notV8.map((c) => c.projectId)).toEqual(["p5"]);
    expect(report.errors).toEqual([
      { ...candidate("org-a", "p6", "broken"), error: "repo gone" },
    ]);
    // One write per (slug, org); nothing taken from another org.
    expect(sites.claims.map((c) => c.slug)).toEqual(["free"]);
    expect(sites.owners.get("taken")).toBe("org-z");
    expect(sites.owners.has("both")).toBe(false);
  });

  it("is safe to re-run, and a dry run writes nothing", async () => {
    const sites = memorySites();
    const input = {
      orgSites: sites.orgSites,
      isDecoSite: noDecoSites,
      candidates: [candidate("org-a", "p1", "shop")],
      by: "admin",
      isV8: async () => true,
    };
    const dry = await backfillSiteClaims({ ...input, dryRun: true });
    expect(dry.claimed).toHaveLength(1);
    expect(sites.claims).toEqual([]);

    await backfillSiteClaims({ ...input, dryRun: false });
    const again = await backfillSiteClaims({ ...input, dryRun: false });
    expect(again.claimed).toEqual([]);
    expect(again.alreadyOwned).toHaveLength(1);
    expect(sites.claims).toHaveLength(1);
  });

  it("an owned slug that two orgs name is reported, not ambiguous", async () => {
    const sites = memorySites({ shop: "org-a" });
    const report = await backfillSiteClaims({
      orgSites: sites.orgSites,
      isDecoSite: noDecoSites,
      candidates: [
        candidate("org-a", "p1", "shop"),
        candidate("org-b", "p2", "shop"),
      ],
      by: "admin",
      dryRun: false,
      isV8: async () => true,
    });
    expect(report.ambiguous).toEqual([]);
    expect(report.alreadyOwned.map((c) => c.projectId)).toEqual(["p1"]);
    expect(report.conflicts).toEqual([
      { ...candidate("org-b", "p2", "shop"), owner: "org-a" },
    ]);
  });
});
