import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { GitProviderAccountStorage } from "./git-provider-accounts";

/**
 * Real Postgres: the grant is a jsonb array appended in SQL, and what matters
 * is exactly what that statement leaves behind — no duplicate, no widening of
 * a whole-installation grant, no reach across organizations.
 */
describe("GitProviderAccountStorage — grantRepository", () => {
  let database: StudioDatabase;
  let storage: GitProviderAccountStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    storage = new GitProviderAccountStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  beforeEach(async () => {
    await database.db.deleteFrom("git_provider_accounts").execute();
  });

  function connect(installationRepositoryIds: number[] | null) {
    return storage.upsert({
      organizationId: "org_1",
      type: "github",
      host: "github.com",
      authKind: "github_app",
      externalAccountId: "77",
      login: "acme",
      installationId: 77,
      installationAuthorizedBy: "1001",
      installationRepositoryIds,
    });
  }

  it("appends to a partial grant once and moves the account version", async () => {
    const account = await connect([10, 20]);
    await storage.grantRepository(account.id, "org_1", 30);
    await storage.grantRepository(account.id, "org_1", 30);
    const after = await storage.get(account.id, "org_1");
    expect(after?.installationRepositoryIds).toEqual([10, 20, 30]);
    expect(after?.updatedAt).not.toBe(account.updatedAt);
  });

  it("leaves a whole-installation grant whole", async () => {
    const account = await connect(null);
    await storage.grantRepository(account.id, "org_1", 30);
    const after = await storage.get(account.id, "org_1");
    expect(after?.installationRepositoryIds).toBeNull();
    expect(after?.updatedAt).toBe(account.updatedAt);
  });

  it("does not touch another organization's account", async () => {
    const account = await connect([10]);
    await storage.grantRepository(account.id, "org_123", 30);
    const after = await storage.get(account.id, "org_1");
    expect(after?.installationRepositoryIds).toEqual([10]);
  });
});
