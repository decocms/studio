import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { UserStorage } from "./user";

const NOW = "2026-01-01T00:00:00.000Z";

describe("UserStorage.searchOrganizations", () => {
  let database: StudioDatabase;
  let storage: UserStorage;

  async function addOrg(id: string, name: string, slug: string) {
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${id}, ${name}, ${slug}, ${NOW})
    `.execute(database.db);
  }

  async function join(userId: string, orgId: string, suffix = "") {
    await sql`
      INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
      VALUES (${`mem_${userId}_${orgId}${suffix}`}, ${orgId}, ${userId}, 'user', ${NOW})
    `.execute(database.db);
  }

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    storage = new UserStorage(database.db);

    // Past the first 100 rows, with the searched-for org joined last.
    for (let i = 0; i < 105; i++) {
      const id = `org_filler_${String(i).padStart(3, "0")}`;
      await addOrg(id, `Filler ${i}`, `filler-${i}`);
      await join("user_1", id);
    }
    await addOrg("org_deco", "Deco", "decocms");
    await join("user_1", "org_deco");
    await addOrg("org_other", "Deco Elsewhere", "deco-elsewhere");
    await join("user_123", "org_other");
    await addOrg("org_pct", "100% Off", "hundred-off");
    await join("user_1", "org_pct");
    await addOrg("org_twice", "Twice Joined", "twice-joined");
    await join("user_1", "org_twice");
    await join("user_1", "org_twice", "_again");
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("finds an org past the first 100 memberships, by name or slug", async () => {
    const byName = await storage.searchOrganizations({
      userId: "user_1",
      term: "deco",
      limit: 20,
    });
    expect(byName.map((org) => org.slug)).toEqual(["decocms"]);

    const bySlug = await storage.searchOrganizations({
      userId: "user_1",
      term: "CMS",
      limit: 20,
    });
    expect(bySlug.map((org) => org.slug)).toEqual(["decocms"]);
  });

  it("never returns an org the user is not a member of", async () => {
    const hits = await storage.searchOrganizations({
      userId: "user_123",
      term: "deco",
      limit: 20,
    });
    expect(hits.map((org) => org.slug)).toEqual(["deco-elsewhere"]);
  });

  it("lists an org once when the user holds two member rows in it", async () => {
    const hits = await storage.searchOrganizations({
      userId: "user_1",
      term: "twice",
      limit: 20,
    });
    expect(hits.map((org) => org.slug)).toEqual(["twice-joined"]);
  });

  it("treats LIKE wildcards in the term literally", async () => {
    const hits = await storage.searchOrganizations({
      userId: "user_1",
      term: "%",
      limit: 200,
    });
    expect(hits.map((org) => org.slug)).toEqual(["hundred-off"]);
  });

  it("pages without overlap and honours the organization fence", async () => {
    const first = await storage.searchOrganizations({
      userId: "user_1",
      term: "filler",
      limit: 50,
    });
    const second = await storage.searchOrganizations({
      userId: "user_1",
      term: "filler",
      limit: 100,
      offset: 50,
    });
    expect(first).toHaveLength(50);
    expect(second).toHaveLength(55);
    expect(new Set([...first, ...second].map((org) => org.id)).size).toBe(105);

    const fenced = await storage.searchOrganizations({
      userId: "user_1",
      term: "filler",
      limit: 20,
      organizationId: "org_filler_007",
    });
    expect(fenced.map((org) => org.id)).toEqual(["org_filler_007"]);
  });
});
