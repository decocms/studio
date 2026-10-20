import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { OrganizationDomainStorage } from "./organization-domains";

describe("OrganizationDomainStorage — concurrent add()", () => {
  let database: StudioDatabase;
  let storage: OrganizationDomainStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    storage = new OrganizationDomainStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  beforeEach(async () => {
    await database.db.deleteFrom("organization_domains").execute();
  });

  it("resolves to the same row instead of throwing a unique-constraint error", async () => {
    const [a, b] = await Promise.all([
      storage.add("org_1", "acme.com", { joinMode: "off" }),
      storage.add("org_1", "acme.com", { joinMode: "off" }),
    ]);

    expect(a.id).toBe(b.id);

    const rows = await storage.listByOrganizationId("org_1");
    expect(rows).toHaveLength(1);
  });
});
