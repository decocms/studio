import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../database/test-db";
import { createTestSchema, seedCommonTestFixtures } from "./test-helpers";
import { VirtualMCPStorage } from "./virtual";
import { getDecopilotId } from "@decocms/mesh-sdk";

describe("VirtualMCPStorage.findById (Decopilot)", () => {
  let database: TestDatabase;
  let storage: VirtualMCPStorage;
  const orgId = "org_decopilot_test";

  beforeAll(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);

    // Seed an org and an active connection for it so we can verify decopilot
    // does NOT aggregate connections (old code would return this connection).
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${orgId}, ${orgId}, ${orgId}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES ('user_decopilot_test', 'user_decopilot_test@test.com', 0, 'Test Decopilot', ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
    await database.db
      .insertInto("connections")
      .values({
        id: "conn_decopilot_test_1",
        organization_id: orgId,
        created_by: "user_decopilot_test",
        updated_by: null,
        title: "Test Connection",
        description: null,
        icon: null,
        app_name: null,
        app_id: null,
        slug: null,
        connection_type: "HTTP",
        connection_url: "https://example.com/mcp",
        connection_token: null,
        connection_headers: null,
        oauth_config: null,
        configuration_state: null,
        configuration_scopes: null,
        metadata: null,
        bindings: null,
        status: "active",
        pinned: false,
        created_at: now,
        updated_at: now,
      })
      .execute();

    storage = new VirtualMCPStorage(database.db);
  });

  afterAll(async () => {
    await closeTestDatabase(database);
  });

  test("returns the synthesized decopilot entity with NO aggregated connections", async () => {
    const decopilot = await storage.findById(getDecopilotId(orgId), orgId);
    expect(decopilot).not.toBeNull();
    expect(decopilot?.title).toBe("Decopilot");
    expect(decopilot?.connections).toEqual([]);
  });
});
