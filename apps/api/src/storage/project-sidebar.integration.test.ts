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
import { ProjectSidebarStorage } from "./project-sidebar";

describe("ProjectSidebarStorage", () => {
  let database: StudioDatabase;
  let storage: ProjectSidebarStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    await sql`
      INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
      VALUES ('mem_1', 'org_1', 'user_1', 'user', '2026-01-01T00:00:00.000Z')
    `.execute(database.db);
    storage = new ProjectSidebarStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  beforeEach(async () => {
    await database.db.deleteFrom("org_project_folders").execute();
    await database.db.deleteFrom("user_sidebar_preferences").execute();
  });

  it("an org with no folders reads as an empty list", async () => {
    expect(await storage.getFolders("org_1")).toEqual([]);
  });

  it("folders round-trip, normalized, and replace the previous list", async () => {
    await storage.setFolders("org_1", [
      { id: "a", name: "A", projectIds: ["p1"] },
    ]);
    const stored = await storage.setFolders("org_1", [
      { id: "b", name: "B", projectIds: ["p1", "p2"] },
      { id: "c", name: "C", projectIds: ["p2"] },
    ]);
    expect(stored).toEqual([
      { id: "b", name: "B", projectIds: ["p1", "p2"] },
      { id: "c", name: "C", projectIds: [] },
    ]);
    expect(await storage.getFolders("org_1")).toEqual(stored);
    expect(await storage.getFolders("org_123")).toEqual([]);
  });

  it("preferences are per (user, org)", async () => {
    await storage.setPreferences("user_1", "org_1", {
      pinned: ["p1"],
      hidden: ["p2"],
      dismissed: [],
      hiddenFolders: ["f"],
    });
    expect(await storage.getPreferences("user_1", "org_1")).toEqual({
      pinned: ["p1"],
      hidden: ["p2"],
      dismissed: [],
      hiddenFolders: ["f"],
    });
    expect((await storage.getPreferences("user_123", "org_1")).pinned).toEqual(
      [],
    );
    expect((await storage.getPreferences("user_1", "org_123")).pinned).toEqual(
      [],
    );
  });

  it("joinedAt is the membership's creation, null for a non-member", async () => {
    expect(await storage.joinedAt("user_1", "org_1")).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(await storage.joinedAt("user_123", "org_1")).toBeNull();
  });
});
