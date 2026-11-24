import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
} from "../../database/test-db-pg";
import { createShortLinkResolveRoutes, upsertShortLink } from "./short-links";

describe("short links (real Postgres)", () => {
  let database: StudioDatabase;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
  });

  afterAll(async () => {
    if (database) await closeTestPgDatabase(database);
  });

  async function org() {
    const id = `org_${crypto.randomUUID()}`;
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${id}, ${id}, ${id}, ${new Date().toISOString()})
    `.execute(database.db);
    return id;
  }

  function create(
    organizationId: string,
    targetPath: string,
    labels: string[],
  ) {
    return upsertShortLink(database.db, {
      organizationId,
      targetPath,
      labels,
      createdBy: null,
    });
  }

  test("builds a labeled path and redirects to the target", async () => {
    const orgId = await org();
    const target = `/${orgId}/projects/p/apps/c/t?args=%7B%7D`;
    const link = await create(orgId, target, ["People", "Perfil"]);
    expect(link.path).toBe(`/s/people/perfil-${link.id}`);

    const app = createShortLinkResolveRoutes(database.db);
    const res = await app.request(link.path);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(target);
  });

  test("the same page returns the same id with refreshed names", async () => {
    const orgId = await org();
    const target = `/${orgId}/tasks`;
    const first = await create(orgId, target, ["Old"]);
    const second = await create(orgId, target, ["New"]);
    expect(second.id).toBe(first.id);
    expect(second.path).toBe(`/s/new-${first.id}`);
  });

  test("the same path in two orgs gets two links", async () => {
    const a = await org();
    const b = await org();
    const first = await create(a, "/x", []);
    const second = await create(b, "/x", []);
    expect(second.id).not.toBe(first.id);
  });

  test("unknown ids 404", async () => {
    const app = createShortLinkResolveRoutes(database.db);
    expect((await app.request("/s/perfil-AAAAAAAAAA")).status).toBe(404);
    expect((await app.request("/s/nope")).status).toBe(404);
  });

  test("unfurlers get a card naming the page, escaped", async () => {
    const orgId = await org();
    const link = await create(orgId, `/${orgId}/x`, ["<People>", "Perfil"]);
    const app = createShortLinkResolveRoutes(database.db);
    const res = await app.request(link.path, {
      headers: { "user-agent": "WhatsApp/2.23" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Perfil · &lt;People&gt; — Studio");
    expect(html).not.toContain("<People>");
  });

  test("links go away with their organization", async () => {
    const orgId = await org();
    const link = await create(orgId, `/${orgId}/x`, []);
    await sql`DELETE FROM "organization" WHERE id = ${orgId}`.execute(
      database.db,
    );
    const app = createShortLinkResolveRoutes(database.db);
    expect((await app.request(link.path)).status).toBe(404);
  });
});
