/**
 * Migration 235 links each org_sites slug to the one project that uses it,
 * guesses nothing when zero or several do, and keeps slugs when an org or a
 * project is deleted.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { StudioDatabase } from "../src/database";
import { VirtualMCPStorage } from "../src/storage/virtual";
import { down as down235, up as up235 } from "./235-org-sites-project-link";

type Row = {
  slug: string;
  organization_id: string | null;
  project_id: string | null;
  linked_at: Date | null;
  updated_by: string;
};

describe("migration 235 — org_sites project link", () => {
  let database: StudioDatabase;
  // biome-ignore lint/suspicious/noExplicitAny: migrations take an untyped Kysely
  let db: any;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    db = database.db;
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  async function project(
    organizationId: string,
    title: string,
    metadata: Record<string, unknown> | null,
  ): Promise<string> {
    const created = await new VirtualMCPStorage(database.db).create(
      organizationId,
      "user_1",
      { title, metadata, connections: [], status: "active", pinned: false },
    );
    return created.id!;
  }

  async function claimOld(slug: string, organizationId: string) {
    await sql`
      INSERT INTO org_sites (slug, organization_id, source, created_by, updated_by)
      VALUES (${slug}, ${organizationId}, 'deco-import', 'user_1', 'user_1')
    `.execute(db);
  }

  async function rows(): Promise<Record<string, Row>> {
    const result = await sql<Row>`
      SELECT slug, organization_id, project_id, linked_at, updated_by
      FROM org_sites ORDER BY slug
    `.execute(db);
    return Object.fromEntries(result.rows.map((r) => [r.slug, r]));
  }

  it("links one candidate, leaves none/ambiguous unlinked, never guesses", async () => {
    const byMeta = await project("org_1", "Acme Store", { siteSlug: "acme" });
    // Pre-siteSlug import: the title is the slug.
    const byTitle = await project("org_1", "Legacy", null);
    // Two projects claim the same slug in one org: ambiguous.
    const dupA = await project("org_1", "Twin A", { siteSlug: "twins" });
    const dupB = await project("org_1", "Twin B", { siteSlug: "twins" });
    // metadata wins over title: "shadow" is title-only, but another project
    // stores it in metadata → the metadata match is the only candidate.
    const shadowMeta = await project("org_1", "Other", { siteSlug: "shadow" });
    await project("org_1", "shadow", null);
    // Malformed JSON: counted, falls back to its title.
    const broken = await project("org_1", "Broken", null);
    await sql`UPDATE connections SET metadata = '{oops' WHERE id = ${broken}`.execute(
      db,
    );
    // Same slug used by a project in another org: not this org's candidate.
    await project("org_456", "Elsewhere", { siteSlug: "nobody" });

    await down235(db);
    await claimOld("acme", "org_1");
    await claimOld("legacy", "org_1");
    await claimOld("twins", "org_1");
    await claimOld("shadow", "org_1");
    await claimOld("broken", "org_1");
    await claimOld("nobody", "org_1");

    await up235(db);

    const after = await rows();
    expect(after.acme?.project_id).toBe(byMeta);
    expect(after.acme?.linked_at).not.toBeNull();
    expect(after.acme?.updated_by).toBe("migration-235");
    expect(after.legacy?.project_id).toBe(byTitle);
    expect(after.shadow?.project_id).toBe(shadowMeta);
    expect(after.broken?.project_id).toBe(broken);
    expect(after.twins?.project_id).toBeNull();
    expect(after.twins?.linked_at).toBeNull();
    expect(after.nobody?.project_id).toBeNull();
    expect([dupA, dupB]).not.toContain(after.twins?.project_id);

    // Project rows are only read.
    const stored = await sql<{ metadata: string | null }>`
      SELECT metadata FROM connections WHERE id = ${byTitle}
    `.execute(db);
    expect(String(stored.rows[0]?.metadata)).not.toContain("siteSlug");
  });

  it("deleting an org keeps its slugs as tombstones; deleting a project keeps the slug reserved", async () => {
    const kept = await project("org_456", "Kept", { siteSlug: "kept" });
    await down235(db);
    await claimOld("kept", "org_456");
    await claimOld("gone-org", "org_456");
    await up235(db);

    const first = (await rows()).kept;
    expect(first?.project_id).toBe(kept);

    await sql`DELETE FROM connections WHERE id = ${kept}`.execute(db);
    const afterProject = (await rows()).kept;
    expect(afterProject?.organization_id).toBe("org_456");
    expect(afterProject?.project_id).toBeNull();
    // linked_at survives: the slug was used, so it is never released or moved.
    expect(afterProject?.linked_at).toEqual(first!.linked_at);

    await sql`DELETE FROM organization WHERE id = 'org_456'`.execute(db);
    const afterOrg = await rows();
    expect(afterOrg.kept?.organization_id).toBeNull();
    expect(afterOrg["gone-org"]?.organization_id).toBeNull();
  });

  it("a project has at most one slug", async () => {
    const id = await project("org_1", "Solo", { siteSlug: "solo" });
    await down235(db);
    await claimOld("solo", "org_1");
    await claimOld("solo-2", "org_1");
    await up235(db);

    await expect(
      sql`UPDATE org_sites SET project_id = ${id} WHERE slug = 'solo-2'`.execute(
        db,
      ),
    ).rejects.toThrow();
  });

  it("down restores the old shape (dropping tombstones) and up re-applies", async () => {
    await down235(db);
    await claimOld("a-site", "org_1");
    await claimOld("b-site", "org_456");
    await up235(db);
    await sql`DELETE FROM organization WHERE id = 'org_456'`.execute(db);

    await down235(db);
    const columns = await sql<{ column_name: string; is_nullable: string }>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'org_sites'
    `.execute(db);
    const byName = Object.fromEntries(
      columns.rows.map((c) => [c.column_name, c.is_nullable]),
    );
    expect(byName.project_id).toBeUndefined();
    expect(byName.linked_at).toBeUndefined();
    expect(byName.organization_id).toBe("NO");
    const left = await sql<{
      slug: string;
    }>`SELECT slug FROM org_sites ORDER BY slug`.execute(db);
    expect(left.rows.map((r) => r.slug)).toEqual(["a-site"]);

    // CASCADE is back.
    await sql`DELETE FROM organization WHERE id = 'org_1'`.execute(db);
    const none = await sql`SELECT 1 FROM org_sites`.execute(db);
    expect(none.rows).toHaveLength(0);

    await up235(db);
  });
});
