import { describe, expect, it } from "bun:test";
import { OrgSiteConflictError, OrgSiteLinkError } from "@/storage/org-sites";
import type { OrgSite } from "@/storage/types";
import {
  backfillSiteClaims,
  claimProjectSite,
  linkProjectSite,
  type SiteClaimCandidate,
  type SiteClaimDeps,
} from "./claim-site";

interface Row {
  /** null: a tombstone (its org was deleted). */
  organizationId: string | null;
  projectId: string | null;
  /** Used before: its project was deleted, or it predates the link. */
  used?: boolean;
}

/**
 * An in-memory `org_sites` with the storage's claim and link rules. `initial`
 * maps a slug to its owning org, or to a full row.
 */
function memorySites(initial: Record<string, string | Row> = {}) {
  const rows = new Map<string, Row>(
    Object.entries(initial).map(([slug, row]) => [
      slug,
      typeof row === "string"
        ? { organizationId: row, projectId: null }
        : { ...row },
    ]),
  );
  const claims: { slug: string; organizationId: string; source?: string }[] =
    [];
  const links: { slug: string; projectId: string }[] = [];
  const site = (slug: string, row: Row): OrgSite => ({
    slug,
    organizationId: row.organizationId,
    projectId: row.projectId,
    linkedAt: row.projectId || row.used ? "2026-01-01T00:00:00.000Z" : null,
    source: "test",
    createdBy: "t",
    createdAt: "",
    updatedBy: "t",
    updatedAt: "",
  });
  const orgSites = {
    async getBySlug(slug: string) {
      const row = rows.get(slug);
      return row ? site(slug, row) : null;
    },
    async getByProject(projectId: string) {
      for (const [slug, row] of rows) {
        if (row.projectId === projectId) return site(slug, row);
      }
      return null;
    },
    async claimSite(params: {
      slug: string;
      organizationId: string;
      source?: string;
      by: string;
    }) {
      const row = rows.get(params.slug);
      if (row?.organizationId === null) {
        throw new OrgSiteLinkError("reserved", params.slug);
      }
      if (row && row.organizationId !== params.organizationId) {
        throw new OrgSiteConflictError(params.slug, row.organizationId);
      }
      const next = row ?? {
        organizationId: params.organizationId,
        projectId: null,
      };
      rows.set(params.slug, next);
      claims.push(params);
      return site(params.slug, next);
    },
    async link(params: {
      slug: string;
      organizationId: string;
      projectId: string;
      by: string;
    }) {
      const row = rows.get(params.slug);
      if (!row) throw new OrgSiteLinkError("not_found", params.slug);
      if (row.organizationId === null) {
        throw new OrgSiteLinkError("reserved", params.slug);
      }
      if (row.organizationId !== params.organizationId) {
        throw new OrgSiteLinkError("not_owned", params.slug);
      }
      if (row.projectId === params.projectId) return site(params.slug, row);
      if (row.projectId !== null) {
        throw new OrgSiteLinkError("linked_elsewhere", params.slug);
      }
      if (row.used) {
        throw new OrgSiteLinkError("relink_requires_admin", params.slug);
      }
      row.projectId = params.projectId;
      links.push({ slug: params.slug, projectId: params.projectId });
      return site(params.slug, row);
    },
  } satisfies SiteClaimDeps["orgSites"];
  return { rows, claims, links, orgSites };
}

const noDecoSites = async () => false;
const input = {
  organizationId: "org-a",
  projectId: "p1",
  by: "u1",
  source: "test",
  slug: "shop",
};

describe("linkProjectSite", () => {
  it("claims a free slug for the org, then links the project", async () => {
    const sites = memorySites();
    const deps = { orgSites: sites.orgSites, isDecoSite: noDecoSites };
    expect(await linkProjectSite(deps, input)).toEqual({
      status: "linked",
      slug: "shop",
    });
    expect(sites.rows.get("shop")).toEqual({
      organizationId: "org-a",
      projectId: "p1",
    });
  });

  it("links a free row the org already owns, without claiming", async () => {
    const sites = memorySites({ shop: "org-a" });
    const deps = { orgSites: sites.orgSites, isDecoSite: noDecoSites };
    expect(await linkProjectSite(deps, input)).toEqual({
      status: "linked",
      slug: "shop",
    });
    expect(sites.claims).toEqual([]);
    expect(sites.links).toEqual([{ slug: "shop", projectId: "p1" }]);
  });

  it("is a no-op for the project's own site", async () => {
    const sites = memorySites({
      shop: { organizationId: "org-a", projectId: "p1" },
    });
    const deps = { orgSites: sites.orgSites, isDecoSite: noDecoSites };
    expect(await linkProjectSite(deps, input)).toEqual({
      status: "already-linked",
      slug: "shop",
    });
    expect(sites.links).toEqual([]);
  });

  it("never gives a linked project a second site", async () => {
    const sites = memorySites({
      other: { organizationId: "org-a", projectId: "p1" },
    });
    const deps = { orgSites: sites.orgSites, isDecoSite: noDecoSites };
    expect(await linkProjectSite(deps, input)).toEqual({
      status: "refused",
      slug: "shop",
      reason: "project-has-other-slug",
    });
    expect(sites.claims).toEqual([]);
  });

  it("never takes another project's site", async () => {
    const sites = memorySites({
      shop: { organizationId: "org-a", projectId: "p2" },
    });
    const deps = { orgSites: sites.orgSites, isDecoSite: noDecoSites };
    expect(await linkProjectSite(deps, input)).toEqual({
      status: "refused",
      slug: "shop",
      reason: "linked-elsewhere",
    });
    expect(sites.rows.get("shop")?.projectId).toBe("p2");
  });

  it("never takes a slug another org owns", async () => {
    const sites = memorySites({ shop: "org-b" });
    const deps = { orgSites: sites.orgSites, isDecoSite: noDecoSites };
    expect(await linkProjectSite(deps, input)).toEqual({
      status: "refused",
      slug: "shop",
      reason: "other-org",
      owner: "org-b",
    });
    expect(sites.rows.get("shop")?.organizationId).toBe("org-b");
  });

  it("never hands a used slug to another project without an admin", async () => {
    const sites = memorySites({
      shop: { organizationId: "org-a", projectId: null, used: true },
    });
    const deps = { orgSites: sites.orgSites, isDecoSite: noDecoSites };
    expect(await linkProjectSite(deps, input)).toEqual({
      status: "refused",
      slug: "shop",
      reason: "relink-requires-admin",
    });
    expect(sites.links).toEqual([]);
  });

  it("never reuses a deleted org's slug", async () => {
    const sites = memorySites({
      shop: { organizationId: null, projectId: null },
    });
    const deps = { orgSites: sites.orgSites, isDecoSite: noDecoSites };
    expect(await linkProjectSite(deps, input)).toEqual({
      status: "refused",
      slug: "shop",
      reason: "reserved",
    });
    expect(sites.claims).toEqual([]);
    expect(sites.links).toEqual([]);
  });

  it("leaves a deco.cx site to the deco import", async () => {
    const sites = memorySites();
    const deps = {
      orgSites: sites.orgSites,
      isDecoSite: async (slug: string) => slug === "shop",
    };
    expect(await linkProjectSite(deps, input)).toEqual({
      status: "refused",
      slug: "shop",
      reason: "deco.cx",
    });
    expect(sites.claims).toEqual([]);
  });

  it("reports a claim another org won in a race", async () => {
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
    expect(await linkProjectSite(deps, input)).toEqual({
      status: "refused",
      slug: "shop",
      reason: "other-org",
      owner: "org-b",
    });
  });

  it("reports a link another project won in a race", async () => {
    const sites = memorySites({ shop: "org-a" });
    const deps = {
      orgSites: {
        ...sites.orgSites,
        link: async () => {
          throw new OrgSiteLinkError("linked_elsewhere", "shop");
        },
      },
      isDecoSite: noDecoSites,
    };
    expect(await linkProjectSite(deps, input)).toEqual({
      status: "refused",
      slug: "shop",
      reason: "linked-elsewhere",
    });
  });

  it("writes nothing on a dry run", async () => {
    const sites = memorySites();
    const deps = { orgSites: sites.orgSites, isDecoSite: noDecoSites };
    expect(await linkProjectSite(deps, { ...input, dryRun: true })).toEqual({
      status: "linked",
      slug: "shop",
    });
    expect(sites.claims).toEqual([]);
    expect(sites.links).toEqual([]);
  });
});

describe("claimProjectSite", () => {
  const noOtherOrg = async () => null;
  const project = { organizationId: "org-a", projectId: "p1", by: "u1" };

  it("links the project to its siteSlug", async () => {
    const sites = memorySites();
    const deps = {
      orgSites: sites.orgSites,
      isDecoSite: noDecoSites,
      otherOrgNamingSlug: noOtherOrg,
    };
    expect(
      await claimProjectSite(deps, {
        ...project,
        metadata: { siteSlug: "shop" },
      }),
    ).toEqual({ status: "linked", slug: "shop" });
    expect(sites.claims[0]?.source).toBe("project-create");
    expect(sites.rows.get("shop")?.projectId).toBe("p1");
  });

  it("skips a project with no valid siteSlug", async () => {
    const sites = memorySites();
    const deps = {
      orgSites: sites.orgSites,
      isDecoSite: noDecoSites,
      otherOrgNamingSlug: noOtherOrg,
    };
    for (const metadata of [null, {}, { siteSlug: "Not A Slug" }]) {
      expect(await claimProjectSite(deps, { ...project, metadata })).toBe(null);
    }
    expect(sites.claims).toEqual([]);
  });

  it("doesn't take an unowned slug another org's project already names", async () => {
    const sites = memorySites();
    const asked: [string, string][] = [];
    const deps = {
      orgSites: sites.orgSites,
      isDecoSite: noDecoSites,
      otherOrgNamingSlug: async (slug: string, organizationId: string) => {
        asked.push([slug, organizationId]);
        return "org-b";
      },
    };
    expect(
      await claimProjectSite(deps, {
        ...project,
        metadata: { siteSlug: "shop" },
      }),
    ).toEqual({
      status: "refused",
      slug: "shop",
      reason: "other-org-project",
      owner: "org-b",
    });
    expect(asked).toEqual([["shop", "org-a"]]);
    expect(sites.claims).toEqual([]);
  });

  it("an owned slug is answered by its owner, not other orgs' projects", async () => {
    const sites = memorySites({ shop: "org-a" });
    const deps = {
      orgSites: sites.orgSites,
      isDecoSite: noDecoSites,
      otherOrgNamingSlug: async () => "org-b",
    };
    expect(
      await claimProjectSite(deps, {
        ...project,
        metadata: { siteSlug: "shop" },
      }),
    ).toEqual({ status: "linked", slug: "shop" });
  });

  it("never fails the project's creation", async () => {
    const sites = memorySites();
    const deps = {
      orgSites: sites.orgSites,
      isDecoSite: async () => {
        throw new Error("supabase down");
      },
      otherOrgNamingSlug: noOtherOrg,
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

  it("links v8 projects to their sites and reports everything else", async () => {
    const sites = memorySites({
      owned: "org-a",
      taken: "org-z",
      gone: { organizationId: null, projectId: null },
    });
    const candidates = [
      candidate("org-a", "p1", "free"),
      candidate("org-a", "p3", "owned"),
      candidate("org-a", "p4", "taken"),
      candidate("org-a", "p5", "v7-site"),
      candidate("org-a", "p6", "broken"),
      candidate("org-a", "p7", "both"),
      candidate("org-b", "p8", "both"),
      candidate("org-a", "p9", "legacy"),
      candidate("org-a", "p10", "gone"),
      candidate("org-a", "p11", "twice"),
      candidate("org-a", "p12", "twice"),
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
    expect(report.linked.map((c) => c.projectId)).toEqual(["p1", "p3"]);
    expect(report.alreadyLinked).toEqual([]);
    expect(report.refused).toEqual([
      { ...candidate("org-a", "p10", "gone"), reason: "reserved" },
      { ...candidate("org-a", "p9", "legacy"), reason: "deco.cx" },
      {
        ...candidate("org-a", "p4", "taken"),
        reason: "other-org",
        owner: "org-z",
      },
    ]);
    expect(report.ambiguous).toEqual([
      {
        slug: "both",
        organizationIds: ["org-a", "org-b"],
        projectIds: ["p7", "p8"],
      },
      { slug: "twice", organizationIds: ["org-a"], projectIds: ["p11", "p12"] },
    ]);
    expect(report.notV8.map((c) => c.projectId)).toEqual(["p5"]);
    expect(report.errors).toEqual([
      { ...candidate("org-a", "p6", "broken"), error: "repo gone" },
    ]);
    // Nothing taken from another org, nothing guessed.
    expect(sites.claims.map((c) => c.slug)).toEqual(["free"]);
    expect(sites.rows.get("taken")?.organizationId).toBe("org-z");
    expect(sites.rows.has("both")).toBe(false);
    expect(sites.rows.has("twice")).toBe(false);
    expect(sites.rows.get("gone")).toEqual({
      organizationId: null,
      projectId: null,
    });
  });

  it("several projects of one org: only the linked one is its site", async () => {
    const sites = memorySites({
      shop: { organizationId: "org-a", projectId: "p2" },
    });
    const report = await backfillSiteClaims({
      orgSites: sites.orgSites,
      isDecoSite: noDecoSites,
      candidates: [
        candidate("org-a", "p1", "shop"),
        candidate("org-a", "p2", "shop"),
      ],
      by: "admin",
      dryRun: false,
      isV8: async () => true,
    });
    expect(report.ambiguous).toEqual([]);
    expect(report.alreadyLinked.map((c) => c.projectId)).toEqual(["p2"]);
    expect(report.refused).toEqual([
      { ...candidate("org-a", "p1", "shop"), reason: "linked-elsewhere" },
    ]);
  });

  it("is safe to re-run, and a dry run writes nothing", async () => {
    const sites = memorySites();
    const run = {
      orgSites: sites.orgSites,
      isDecoSite: noDecoSites,
      candidates: [candidate("org-a", "p1", "shop")],
      by: "admin",
      isV8: async () => true,
    };
    const dry = await backfillSiteClaims({ ...run, dryRun: true });
    expect(dry.linked).toHaveLength(1);
    expect(sites.claims).toEqual([]);
    expect(sites.links).toEqual([]);

    await backfillSiteClaims({ ...run, dryRun: false });
    const again = await backfillSiteClaims({ ...run, dryRun: false });
    expect(again.linked).toEqual([]);
    expect(again.alreadyLinked).toHaveLength(1);
    expect(sites.claims).toHaveLength(1);
    expect(sites.links).toHaveLength(1);
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
    expect(report.linked.map((c) => c.projectId)).toEqual(["p1"]);
    expect(report.refused).toEqual([
      {
        ...candidate("org-b", "p2", "shop"),
        reason: "other-org",
        owner: "org-a",
      },
    ]);
  });
});
