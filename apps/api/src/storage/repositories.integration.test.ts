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
import { RepositoryStorage } from "./repositories";

/**
 * Real Postgres, because the interesting cases are all about the COLUMN: a
 * NULL that predates it, an update whitelist that could silently drop it, and
 * an unrelated upsert that must not reset it. An in-memory fake would accept
 * every one of those.
 */
describe("RepositoryStorage — sandbox image", () => {
  let database: StudioDatabase;
  let storage: RepositoryStorage;
  const ref = {
    provider: "github" as const,
    host: "github.com",
    path: "acme/app",
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    storage = new RepositoryStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  beforeEach(async () => {
    await database.db.deleteFrom("repositories").execute();
  });

  it("defaults to the default image on a fresh link", async () => {
    const repo = await storage.upsert({ organizationId: "org_1", ref });
    expect(repo.sandboxImage).toBe("default");
  });

  // Every row that predates migration 224 is NULL, and must keep booting
  // exactly as it did.
  it("reads a NULL column as the default image", async () => {
    const repo = await storage.upsert({ organizationId: "org_1", ref });
    await database.db
      .updateTable("repositories")
      .set({ sandbox_image: null })
      .where("id", "=", repo.id)
      .execute();
    const got = await storage.get(repo.id, "org_1");
    expect(got?.sandboxImage).toBe("default");
  });

  it("round-trips a variant", async () => {
    const repo = await storage.upsert({ organizationId: "org_1", ref });
    const updated = await storage.setSandboxImage(repo.id, "org_1", "flutter");
    expect(updated?.sandboxImage).toBe("flutter");
    expect((await storage.get(repo.id, "org_1"))?.sandboxImage).toBe("flutter");
  });

  // Re-linking a repo (the provider-facts refresh) must not silently reset it.
  it("survives an upsert that does not mention it", async () => {
    const repo = await storage.upsert({ organizationId: "org_1", ref });
    await storage.setSandboxImage(repo.id, "org_1", "flutter");
    await storage.upsert({
      organizationId: "org_1",
      ref,
      defaultBranch: "main",
    });
    expect((await storage.get(repo.id, "org_1"))?.sandboxImage).toBe("flutter");
  });

  // Tenancy by construction: another org's id must not reach this row.
  it("will not set the image from another organization", async () => {
    const repo = await storage.upsert({ organizationId: "org_1", ref });
    expect(
      await storage.setSandboxImage(repo.id, "org_123", "flutter"),
    ).toBeNull();
    expect((await storage.get(repo.id, "org_1"))?.sandboxImage).toBe("default");
  });
});
