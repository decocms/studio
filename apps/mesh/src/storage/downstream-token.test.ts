import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createTestDatabase,
  closeTestDatabase,
  type TestDatabase,
} from "../database/test-db";
import { sql } from "kysely";
import { createTestSchema, seedCommonTestFixtures } from "./test-helpers";
import { CredentialVault } from "../encryption/credential-vault";
import {
  DownstreamTokenStorage,
  type DownstreamTokenData,
} from "./downstream-token";

describe("DownstreamTokenStorage", () => {
  let database: TestDatabase;
  let storage: DownstreamTokenStorage;

  beforeAll(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);

    // Create test connections required by FK constraints
    const now = new Date().toISOString();
    for (const connId of ["c1", "conn_atomic"]) {
      await sql`
        INSERT INTO connections (id, organization_id, created_by, title, connection_type, connection_url, status, created_at, updated_at)
        VALUES (${connId}, 'org_test', 'user_test', ${connId}, 'HTTP', 'https://test.com', 'active', ${now}, ${now})
        ON CONFLICT (id) DO NOTHING
      `.execute(database.db);
    }

    const vault = new CredentialVault(CredentialVault.generateKey());
    storage = new DownstreamTokenStorage(database.db, vault);
  });

  afterAll(async () => {
    await closeTestDatabase(database);
  });

  it("should fail-safe invalid expiration date as expired", async () => {
    const token = {
      id: "test",
      connectionId: "c1",
      accessToken: "at",
      refreshToken: null,
      scope: null,
      expiresAt: "invalid-date-string", // Invalid date
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      clientId: null,
      clientSecret: null,
      tokenEndpoint: null,
    };

    // Before fix: new Date("invalid").getTime() is NaN. NaN < Date.now() is false.
    // After fix: should return true.
    expect(storage.isExpired(token)).toBe(true);
  });

  it("should not treat short-lived tokens as expired unless buffer is applied", async () => {
    const token = {
      id: "test",
      connectionId: "c1",
      accessToken: "at",
      refreshToken: null,
      scope: null,
      expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(), // 2 min
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      clientId: null,
      clientSecret: null,
      tokenEndpoint: null,
    };

    // Default buffer=0 => not expired yet
    expect(storage.isExpired(token)).toBe(false);
    // With 5 min buffer => considered expired (for proactive refresh flows)
    expect(storage.isExpired(token, 5 * 60 * 1000)).toBe(true);
  });

  it("should upsert token atomically", async () => {
    const data: DownstreamTokenData = {
      connectionId: "conn_atomic",
      accessToken: "access_1",
      refreshToken: "refresh_1",
      scope: "scope_1",
      expiresAt: new Date(Date.now() + 3600000),
      clientId: "client_1",
      clientSecret: "secret_1",
      tokenEndpoint: "https://example.com/token",
    };

    // First insert
    const t1 = await storage.upsert(data);
    expect(t1.accessToken).toBe("access_1");
    expect(t1.clientId).toBe("client_1");

    // Update
    const data2 = { ...data, accessToken: "access_2", clientId: "client_2" };
    const t2 = await storage.upsert(data2);

    expect(t2.id).toBe(t1.id); // Should update same record
    expect(t2.accessToken).toBe("access_2");
    expect(t2.clientId).toBe("client_2");

    // Check DB count
    const count = await database.db
      .selectFrom("downstream_tokens")
      .select(database.db.fn.count("id").as("c"))
      .executeTakeFirst();
    expect(Number(count?.c)).toBe(1);
  });
});
