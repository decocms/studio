/**
 * A site slug is the site's public id (CDN paths, tokens, asset URLs): set once
 * by the flow that creates or imports the site, linked to one project, never
 * changed and never reused. These tests pin that lifecycle at every layer that
 * can write it: the org_sites port, the project storage, and the tools.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import type { StudioContext } from "../core/studio-context";
import { COLLECTION_VIRTUAL_MCP_CREATE } from "../tools/virtual/create";
import { COLLECTION_VIRTUAL_MCP_UPDATE } from "../tools/virtual/update";
import { COLLECTION_CONNECTIONS_UPDATE } from "../tools/connection/update";
import { assertOwnsSite } from "../tools/experiments/ownership";
import {
  OrgSiteConflictError,
  OrgSiteLinkError,
  OrgSiteStorage,
  SiteSlugImmutableError,
} from "./org-sites";
import { VirtualMCPStorage } from "./virtual";
import { ConnectionStorage } from "./connection";
import { CredentialVault } from "../encryption/credential-vault";

const ORG = "org_1";
const OTHER_ORG = "org_456";
const USER = "user_1";

describe("site slug lifecycle", () => {
  let database: StudioDatabase;
  let sites: OrgSiteStorage;
  let projects: VirtualMCPStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  beforeEach(async () => {
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    sites = new OrgSiteStorage(database.db);
    projects = new VirtualMCPStorage(database.db);
  });

  function ctxFor(organizationId: string): StudioContext {
    return {
      auth: { user: { id: USER, role: "owner" } },
      organization: { id: organizationId, slug: organizationId, role: "owner" },
      access: { check: async () => {}, getRole: () => "owner" },
      db: database.db,
      storage: {
        virtualMcps: projects,
        orgSites: sites,
        connections: {
          findById: async (id: string) => {
            const project = await projects.findById(id);
            return project
              ? {
                  id,
                  organization_id: project.organization_id,
                  connection_type: "VIRTUAL",
                  connection_url: `virtual://${id}`,
                }
              : null;
          },
        },
      },
    } as unknown as StudioContext;
  }

  async function newProject(
    title: string,
    metadata: Record<string, unknown> | null = null,
    organizationId = ORG,
  ) {
    const created = await projects.create(organizationId, USER, {
      title,
      metadata,
      connections: [],
      status: "active",
      pinned: false,
    });
    return created.id!;
  }

  const claim = (slug: string, organizationId = ORG) =>
    sites.claimSite({ slug, organizationId, by: USER });

  const link = (slug: string, projectId: string, organizationId = ORG) =>
    sites.link({ slug, organizationId, projectId, by: USER });

  async function linkError(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (error instanceof OrgSiteLinkError) return error.code;
      throw error;
    }
    throw new Error("expected an OrgSiteLinkError");
  }

  describe("OrgSiteStorage.link", () => {
    it("links once, idempotently, and getByProject finds it", async () => {
      const id = await newProject("Acme");
      await claim("acme");
      const linked = await link("acme", id);
      expect(linked.projectId).toBe(id);
      expect(linked.linkedAt).not.toBeNull();
      const again = await link("acme", id);
      expect(again.linkedAt).toBe(linked.linkedAt);
      expect((await sites.getByProject(id))?.slug).toBe("acme");
    });

    it("refuses every other case", async () => {
      const a = await newProject("A");
      const b = await newProject("B");
      const foreign = await newProject("F", null, OTHER_ORG);
      await claim("site-a");
      await claim("site-b");
      await claim("theirs", OTHER_ORG);
      await link("site-a", a);

      expect(await linkError(link("unclaimed", a))).toBe("not_found");
      expect(await linkError(link("theirs", b))).toBe("not_owned");
      expect(await linkError(link("site-a", b))).toBe("linked_elsewhere");
      expect(await linkError(link("site-b", a))).toBe("project_has_other_slug");
      expect(await linkError(link("site-b", foreign))).toBe(
        "project_not_found",
      );

      await sql`DELETE FROM organization WHERE id = ${OTHER_ORG}`.execute(
        database.db,
      );
      expect(await linkError(link("theirs", b))).toBe("reserved");
    });

    it("after its project is deleted, the same org relinks it itself; linked_at is kept", async () => {
      const first = await newProject("First");
      await claim("relink");
      const linked = await link("relink", first);
      await projects.delete(first);
      const row = await sites.getBySlug("relink");
      expect(row?.projectId).toBeNull();
      expect(row?.linkedAt).toBe(linked.linkedAt);

      const second = await newProject("Second");
      const relinked = await link("relink", second);
      expect(relinked.projectId).toBe(second);
      expect(relinked.linkedAt).toBe(linked.linkedAt);

      // Linked again, so every other rule holds.
      const third = await newProject("Third");
      expect(await linkError(link("relink", third))).toBe("linked_elsewhere");
    });

    it("another org never relinks a used slug; a tombstone is nobody's", async () => {
      const first = await newProject("First", null, OTHER_ORG);
      await claim("theirs", OTHER_ORG);
      await link("theirs", first, OTHER_ORG);
      await projects.delete(first);
      const ours = await newProject("Ours");
      expect(await linkError(link("theirs", ours))).toBe("not_owned");
      await expect(claim("theirs")).rejects.toBeInstanceOf(
        OrgSiteConflictError,
      );

      await sql`DELETE FROM organization WHERE id = ${OTHER_ORG}`.execute(
        database.db,
      );
      expect(await linkError(link("theirs", ours))).toBe("reserved");
      expect(await linkError(claim("theirs"))).toBe("reserved");
    });
  });

  describe("claim, reassign, release never reuse a used slug", () => {
    it("a tombstone can't be claimed or reassigned", async () => {
      await claim("orphan", OTHER_ORG);
      await sql`DELETE FROM organization WHERE id = ${OTHER_ORG}`.execute(
        database.db,
      );
      expect((await sites.getBySlug("orphan"))?.organizationId).toBeNull();
      expect(await linkError(claim("orphan"))).toBe("reserved");
      expect(
        await linkError(
          sites.reassignSite({ slug: "orphan", organizationId: ORG, by: USER }),
        ),
      ).toBe("reserved");
      expect(await sites.isOwnedBy("orphan", ORG)).toBe(false);
    });

    it("a used slug can't be released or moved; an unused one can", async () => {
      const id = await newProject("Used");
      await claim("used");
      await link("used", id);
      expect(await linkError(sites.releaseSite("used", ORG))).toBe("in_use");
      await expect(claim("used", OTHER_ORG)).rejects.toBeInstanceOf(
        OrgSiteConflictError,
      );
      expect(
        await linkError(
          sites.reassignSite({
            slug: "used",
            organizationId: OTHER_ORG,
            by: USER,
          }),
        ),
      ).toBe("in_use");
      // Even after its project is gone.
      await projects.delete(id);
      expect(await linkError(sites.releaseSite("used", ORG))).toBe("in_use");

      await claim("unused");
      const moved = await sites.reassignSite({
        slug: "unused",
        organizationId: OTHER_ORG,
        by: USER,
      });
      expect(moved.organizationId).toBe(OTHER_ORG);
      expect(await sites.releaseSite("unused", OTHER_ORG)).toBe(true);
      expect(await sites.releaseSite("unused", OTHER_ORG)).toBe(false);
    });
  });

  describe("VirtualMCPStorage", () => {
    it("reads a project's site from its link", async () => {
      // A project linked through the normal claim/link path.
      const id = await newProject("legacy-site");
      await claim("legacy-site");
      await link("legacy-site", id);
      expect((await projects.findById(id))?.metadata?.siteSlug).toBe(
        "legacy-site",
      );
      const listed = (await projects.list(ORG)).find((p) => p.id === id);
      expect(listed?.metadata?.siteSlug).toBe("legacy-site");
    });

    it("keeps the slug through metadata rewrites and refuses a different one", async () => {
      const id = await newProject("Acme", { siteSlug: "acme" });
      // Rebuilt from scratch without the key (sandbox start, reports setup…).
      await projects.update(id, USER, { metadata: { instructions: "hi" } });
      expect((await projects.findById(id))?.metadata?.siteSlug).toBe("acme");
      await projects.update(id, USER, { metadata: null });
      expect((await projects.findById(id))?.metadata?.siteSlug).toBe("acme");
      await expect(
        projects.update(id, USER, { metadata: { siteSlug: "other" } }),
      ).rejects.toBeInstanceOf(SiteSlugImmutableError);
    });

    it("patchMetadata never writes the site slug", async () => {
      const id = await newProject("Acme", { siteSlug: "acme" });
      const patch = (set: Record<string, unknown>, unset: string[] = []) =>
        projects.patchMetadata({
          id,
          organizationId: ORG,
          set,
          unset,
          by: USER,
        });
      await expect(patch({ siteSlug: "other" })).rejects.toBeInstanceOf(
        SiteSlugImmutableError,
      );
      await expect(patch({}, ["siteSlug"])).rejects.toBeInstanceOf(
        SiteSlugImmutableError,
      );
      expect(await patch({ analyticsSiteSlug: "acme" })).toBe(true);
      expect((await projects.findById(id))?.metadata?.siteSlug).toBe("acme");
    });
  });

  describe("COLLECTION_VIRTUAL_MCP_CREATE", () => {
    const create = (siteSlug: string, organizationId = ORG) =>
      COLLECTION_VIRTUAL_MCP_CREATE.handler(
        {
          data: {
            title: siteSlug,
            metadata: { siteSlug },
            connections: [],
            status: "active",
            pinned: false,
          },
        },
        ctxFor(organizationId),
      );

    it("links the slug when the org owns a free row", async () => {
      await claim("imported");
      const { item } = await create("imported");
      expect((await sites.getBySlug("imported"))?.projectId).toBe(item.id);
    });

    it("keeps the slug unlinked when the org can't link it", async () => {
      await claim("theirs", OTHER_ORG);
      const { item } = await create("theirs");
      expect(item.metadata?.siteSlug).toBe("theirs");
      expect((await sites.getBySlug("theirs"))?.projectId).toBeNull();

      // A second import of the same site in one org: the first keeps the link.
      await claim("twice");
      const first = await create("twice");
      await create("twice");
      expect((await sites.getBySlug("twice"))?.projectId).toBe(first.item.id);
    });

    // Hosted (hosted/claim-site.ts): a slug no org owns is claimed, then linked.
    it("claims and links a slug nobody owns", async () => {
      const { item } = await create("fresh");
      const row = await sites.getBySlug("fresh");
      expect(row?.organizationId).toBe(ORG);
      expect(row?.projectId).toBe(item.id);
      expect(row?.source).toBe("project-create");
    });

    it("never reuses a deleted org's slug", async () => {
      await claim("gone", OTHER_ORG);
      await sql`DELETE FROM organization WHERE id = ${OTHER_ORG}`.execute(
        database.db,
      );
      await create("gone");
      const row = await sites.getBySlug("gone");
      expect(row?.organizationId).toBeNull();
      expect(row?.projectId).toBeNull();
    });
  });

  describe("COLLECTION_VIRTUAL_MCP_UPDATE", () => {
    const update = (id: string, data: Record<string, unknown>) =>
      COLLECTION_VIRTUAL_MCP_UPDATE.handler({ id, data }, ctxFor(ORG));

    it("refuses changing or clearing a linked slug", async () => {
      const id = await newProject("Acme", { siteSlug: "acme" });
      await claim("acme");
      await link("acme", id);
      await expect(
        update(id, { metadata: { siteSlug: "acme-2" } }),
      ).rejects.toThrow(/site id can't change/);
      await expect(
        update(id, { metadata: { siteSlug: null } }),
      ).rejects.toThrow(SiteSlugImmutableError);
      expect((await sites.getBySlug("acme"))?.projectId).toBe(id);
    });

    it("refuses changing an unlinked slug", async () => {
      const id = await newProject("Shop", { siteSlug: "shop" });
      await expect(
        update(id, { metadata: { siteSlug: "shop-2" } }),
      ).rejects.toBeInstanceOf(SiteSlugImmutableError);
    });

    it("refuses setting a slug on a project that has none", async () => {
      const id = await newProject("Plain agent");
      await expect(
        update(id, { metadata: { siteSlug: "grab" } }),
      ).rejects.toBeInstanceOf(SiteSlugImmutableError);
    });

    it("accepts the same slug, other keys, metadata: null and renames", async () => {
      const id = await newProject("Acme", { siteSlug: "acme" });
      await update(id, {
        metadata: { siteSlug: "acme", instructions: "Be nice" },
      });
      await update(id, { metadata: { instructions: "Be nicer" } });
      await update(id, { metadata: null });
      await update(id, { title: "Acme Renamed" });
      const after = await projects.findById(id);
      expect(after?.metadata?.siteSlug).toBe("acme");
      expect(after?.title).toBe("Acme Renamed");
    });

    it("a rename of a title-slug project pins the slug instead of moving it", async () => {
      const id = await newProject("legacy");
      await update(id, { title: "Brand new name" });
      expect((await projects.findById(id))?.metadata?.siteSlug).toBe("legacy");
      await expect(
        update(id, { metadata: { siteSlug: "brand-new-name" } }),
      ).rejects.toBeInstanceOf(SiteSlugImmutableError);
    });
  });

  describe("COLLECTION_CONNECTIONS_UPDATE on a project row", () => {
    it("refuses rewriting the project's site slug", async () => {
      const id = await newProject("Acme", { siteSlug: "acme" });
      await expect(
        COLLECTION_CONNECTIONS_UPDATE.handler(
          { id, data: { metadata: { siteSlug: "hijack" } } },
          ctxFor(ORG),
        ),
      ).rejects.toBeInstanceOf(SiteSlugImmutableError);
    });

    it("a rename of a title-slug project pins the slug instead of moving it", async () => {
      const id = await newProject("legacy");
      const vault = new CredentialVault(CredentialVault.generateKey());
      const base = ctxFor(ORG);
      const ctx = {
        ...base,
        vault,
        storage: {
          ...base.storage,
          connections: new ConnectionStorage(database.db, vault),
        },
      } as unknown as StudioContext;
      await COLLECTION_CONNECTIONS_UPDATE.handler(
        { id, data: { title: "Brand new name" } },
        ctx,
      );
      const after = await projects.findById(id);
      expect(after?.title).toBe("Brand new name");
      expect(after?.metadata?.siteSlug).toBe("legacy");
    });
  });

  describe("experiments ownership", () => {
    it("follows the link, not a look-alike project", async () => {
      const linked = await newProject("Real", { siteSlug: "real" });
      await claim("real");
      await link("real", linked);
      // Same org, a second project claiming the slug: the link decides.
      await newProject("Copy", { siteSlug: "real" });
      await expect(assertOwnsSite(ctxFor(ORG), ORG, "real")).resolves.toBe(
        undefined,
      );

      // Another org's project naming a slug linked here owns nothing.
      await newProject("Thief", { siteSlug: "real" }, OTHER_ORG);
      await expect(
        assertOwnsSite(ctxFor(OTHER_ORG), OTHER_ORG, "real"),
      ).rejects.toThrow(/Site not found/);

      // A tombstone (its org was deleted) is nobody's, look-alikes included.
      await claim("orphan", OTHER_ORG);
      await sql`DELETE FROM organization WHERE id = ${OTHER_ORG}`.execute(
        database.db,
      );
      await newProject("orphan");
      await expect(assertOwnsSite(ctxFor(ORG), ORG, "orphan")).rejects.toThrow(
        /Site not found/,
      );

      // Unlinked projects keep the legacy match.
      await newProject("v7-site");
      await expect(assertOwnsSite(ctxFor(ORG), ORG, "v7-site")).resolves.toBe(
        undefined,
      );
    });
  });
});
