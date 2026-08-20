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

describe("OrganizationSettingsStorage — per-repo flags", () => {
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

  it("round-trips a repo override through insert", async () => {
    await storage.upsert("org_1", {
      repo_flags: { "decocms/studio": { auto_merge: false } },
    });
    const got = await storage.get("org_1");
    expect(got?.repo_flags).toEqual({
      "decocms/studio": { auto_merge: false },
    });
  });

  it("merges two levels deep: other repos AND the repo's other flags survive", async () => {
    await storage.upsert("org_1", {
      repo_flags: {
        "decocms/studio": { auto_merge: true, qa_agent_enabled: false },
        "decocms/context": { auto_merge: true },
      },
    });
    await storage.upsert("org_1", {
      repo_flags: { "decocms/studio": { auto_merge: false } },
    });

    const got = await storage.get("org_1");
    expect(got?.repo_flags).toEqual({
      "decocms/studio": { auto_merge: false, qa_agent_enabled: false },
      "decocms/context": { auto_merge: true },
    });
  });

  it("a null override persists — that's how a repo goes back to inheriting", async () => {
    await storage.upsert("org_1", {
      repo_flags: { "decocms/studio": { auto_merge: true } },
    });
    await storage.upsert("org_1", {
      repo_flags: { "decocms/studio": { auto_merge: null } },
    });
    const got = await storage.get("org_1");
    expect(got?.repo_flags).toEqual({ "decocms/studio": { auto_merge: null } });
  });

  it("writing org flags leaves repo overrides untouched, and vice versa", async () => {
    await storage.upsert("org_1", {
      repo_flags: { "decocms/studio": { auto_merge: false } },
    });
    await storage.upsert("org_1", { flags: { auto_merge: true } });
    const got = await storage.get("org_1");
    expect(got?.flags).toEqual({ auto_merge: true });
    expect(got?.repo_flags).toEqual({
      "decocms/studio": { auto_merge: false },
    });
  });
});
