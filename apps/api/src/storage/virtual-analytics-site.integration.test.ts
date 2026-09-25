import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { VirtualMCPStorage } from "./virtual";

const ORG = "org_analytics_site";
const OTHER_ORG = "org_analytics_site_other";
const USER = "user_analytics_site";

describe("VirtualMCPStorage analytics-site override", () => {
  let database: StudioDatabase;
  let storage: VirtualMCPStorage;

  const insertProject = async (
    id: string,
    organizationId: string,
    metadata: Record<string, unknown> | null,
  ) => {
    const now = new Date().toISOString();
    await database.db
      .insertInto("connections")
      .values({
        id,
        organization_id: organizationId,
        created_by: USER,
        updated_by: null,
        title: id,
        description: null,
        icon: null,
        app_name: null,
        app_id: null,
        slug: null,
        connection_type: "VIRTUAL",
        connection_url: `virtual://${id}`,
        connection_token: null,
        connection_headers: null,
        oauth_config: null,
        configuration_state: null,
        configuration_scopes: null,
        metadata: metadata ? JSON.stringify(metadata) : null,
        bindings: null,
        status: "active",
        pinned: false,
        created_at: now,
        updated_at: now,
      })
      .execute();
  };

  const readMetadata = async (id: string) => {
    const row = await database.db
      .selectFrom("connections")
      .select(sql<string | null>`metadata`.as("metadata"))
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return row.metadata === null
      ? null
      : (JSON.parse(row.metadata) as Record<string, unknown>);
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    for (const org of [ORG, OTHER_ORG]) {
      await sql`
        INSERT INTO "organization" (id, name, slug, "createdAt")
        VALUES (${org}, ${org}, ${org}, ${now})
        ON CONFLICT (id) DO NOTHING
      `.execute(database.db);
    }
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, 'analytics-site@test.com', false, 'Analytics Site', ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
    storage = new VirtualMCPStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  test("sets the override without touching the rest of the metadata", async () => {
    const metadata = {
      siteSlug: "acme-tanstack",
      sandboxMap: { u1: { main: { "agent-sandbox": { sandboxHandle: "h" } } } },
      releases: [{ branch: "b", name: "Draft", color: "blue" }],
    };
    await insertProject("vir_set", ORG, metadata);

    const updated = await storage.setAnalyticsSiteSlug({
      id: "vir_set",
      organizationId: ORG,
      slug: "acme",
      by: USER,
    });

    expect(updated).toBe(true);
    expect(await readMetadata("vir_set")).toEqual({
      ...metadata,
      analyticsSiteSlug: "acme",
    });
  });

  test("clearing removes only the override", async () => {
    await insertProject("vir_clear", ORG, {
      siteSlug: "acme-tanstack",
      analyticsSiteSlug: "acme",
    });

    await storage.setAnalyticsSiteSlug({
      id: "vir_clear",
      organizationId: ORG,
      slug: null,
      by: USER,
    });

    expect(await readMetadata("vir_clear")).toEqual({
      siteSlug: "acme-tanstack",
    });
  });

  test("starts an object when the project has no metadata", async () => {
    await insertProject("vir_null", ORG, null);

    await storage.setAnalyticsSiteSlug({
      id: "vir_null",
      organizationId: ORG,
      slug: "acme",
      by: USER,
    });

    expect(await readMetadata("vir_null")).toEqual({
      analyticsSiteSlug: "acme",
    });
  });

  test("refuses a project of another organization", async () => {
    await insertProject("vir_foreign", OTHER_ORG, { siteSlug: "other" });

    const updated = await storage.setAnalyticsSiteSlug({
      id: "vir_foreign",
      organizationId: ORG,
      slug: "acme",
      by: USER,
    });

    expect(updated).toBe(false);
    expect(await readMetadata("vir_foreign")).toEqual({ siteSlug: "other" });
  });

  test("releasing a site clears only the org's overrides pointing at it", async () => {
    await insertProject("vir_ref_a", ORG, {
      siteSlug: "a",
      analyticsSiteSlug: "released",
    });
    await insertProject("vir_ref_b", ORG, {
      siteSlug: "b",
      analyticsSiteSlug: "kept",
    });
    await insertProject("vir_ref_other", OTHER_ORG, {
      siteSlug: "c",
      analyticsSiteSlug: "released",
    });

    const cleared = await storage.clearAnalyticsSiteSlugReferences(
      ORG,
      "released",
    );

    expect(cleared).toBe(1);
    expect(await readMetadata("vir_ref_a")).toEqual({ siteSlug: "a" });
    expect(await readMetadata("vir_ref_b")).toEqual({
      siteSlug: "b",
      analyticsSiteSlug: "kept",
    });
    expect(await readMetadata("vir_ref_other")).toEqual({
      siteSlug: "c",
      analyticsSiteSlug: "released",
    });
  });
});
