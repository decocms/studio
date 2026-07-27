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
import { UserModelPreferencesStorage } from "./user-model-preferences";

describe("UserModelPreferencesStorage", () => {
  let database: StudioDatabase;
  let storage: UserModelPreferencesStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    storage = new UserModelPreferencesStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  beforeEach(async () => {
    await database.db.deleteFrom("user_model_preferences").execute();
  });

  it("returns null when the user has no preferences", async () => {
    expect(await storage.get("user_1", "org_1")).toBeNull();
  });

  it("round-trips a stored override", async () => {
    await storage.upsert("user_1", "org_1", {
      tiers: { smart: { keyId: "k1", modelId: "m1", title: "Model One" } },
    });
    const got = await storage.get("user_1", "org_1");
    expect(got?.tiers.smart).toEqual({
      keyId: "k1",
      modelId: "m1",
      title: "Model One",
    });
  });

  it("upsert overwrites the previous tiers for the same (user, org)", async () => {
    await storage.upsert("user_1", "org_1", {
      tiers: { fast: { keyId: "k1", modelId: "fast-1" } },
    });
    await storage.upsert("user_1", "org_1", {
      tiers: { thinking: { keyId: "k2", modelId: "think-1" } },
    });
    const got = await storage.get("user_1", "org_1");
    // The second write replaces the whole tiers blob — fast is gone.
    expect(got?.tiers.fast).toBeUndefined();
    expect(got?.tiers.thinking).toEqual({ keyId: "k2", modelId: "think-1" });
  });

  it("scopes rows per (user, org)", async () => {
    await storage.upsert("user_1", "org_1", {
      tiers: { smart: { keyId: "k1", modelId: "mine" } },
    });
    await storage.upsert("user_123", "org_1", {
      tiers: { smart: { keyId: "k1", modelId: "theirs" } },
    });
    expect((await storage.get("user_1", "org_1"))?.tiers.smart?.modelId).toBe(
      "mine",
    );
    expect((await storage.get("user_123", "org_1"))?.tiers.smart?.modelId).toBe(
      "theirs",
    );
    // A different org for the same user is a separate row.
    expect(await storage.get("user_1", "org_123")).toBeNull();
  });
});
