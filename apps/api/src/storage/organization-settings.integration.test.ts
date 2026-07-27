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
import { OrganizationSettingsStorage } from "./organization-settings";

describe("OrganizationSettingsStorage — flags bag", () => {
  let database: StudioDatabase;
  let storage: OrganizationSettingsStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    storage = new OrganizationSettingsStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  beforeEach(async () => {
    await database.db.deleteFrom("organization_settings").execute();
  });

  it("round-trips a flag through insert", async () => {
    await storage.upsert("org_1", { flags: { demo_mode: true } });
    const got = await storage.get("org_1");
    expect(got?.flags).toEqual({ demo_mode: true });
  });

  it("shallow-merges on update: keys in the write win, other keys survive", async () => {
    await storage.upsert("org_1", { flags: { reports_only: true } });
    await storage.upsert("org_1", { flags: { demo_mode: true } });

    const got = await storage.get("org_1");
    expect(got?.flags).toEqual({ reports_only: true, demo_mode: true });
  });

  it("explicit false persists (merge, not truthy-spread)", async () => {
    await storage.upsert("org_1", { flags: { demo_mode: true } });
    await storage.upsert("org_1", { flags: { demo_mode: false } });
    const got = await storage.get("org_1");
    expect(got?.flags).toEqual({ demo_mode: false });
  });

  it("updating an unrelated field leaves flags untouched", async () => {
    await storage.upsert("org_1", { flags: { demo_mode: true } });
    await storage.upsert("org_1", { main_agent_id: "vmcp-1" });
    const got = await storage.get("org_1");
    expect(got?.flags).toEqual({ demo_mode: true });
    expect(got?.main_agent_id).toBe("vmcp-1");
  });

  it("reads null when no flag was ever set", async () => {
    await storage.upsert("org_1", { main_agent_id: "vmcp-1" });
    expect((await storage.get("org_1"))?.flags).toBeNull();
  });
});
