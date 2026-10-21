import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { VirtualMCPStorage } from "./virtual";
import { getDecopilotId } from "@decocms/shared/sdk";

describe("VirtualMCPStorage.findById (Decopilot)", () => {
  let database: StudioDatabase;
  let storage: VirtualMCPStorage;
  const orgId = "org_decopilot_test";

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    // Wipe whatever the previous test file left behind. Migrations have
    // already been run by the workflow before any test starts.
    await resetTestPgDatabase(database);

    // Seed an org and an active connection for it so we can verify decopilot
    // does NOT aggregate connections (old code would return this connection).
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${orgId}, ${orgId}, ${orgId}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
    // emailVerified is BOOLEAN in real Postgres (Better Auth's migration);
    // PGlite test-helpers hand-rolled it as INTEGER, which is why the old
    // version of this test inserted `0` and got away with it.
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES ('user_decopilot_test', 'user_decopilot_test@test.com', false, 'Test Decopilot', ${now}, ${now})
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
    await closeTestPgDatabase(database);
  });

  test("returns the synthesized decopilot entity with NO aggregated connections", async () => {
    const decopilot = await storage.findById(getDecopilotId(orgId), orgId);
    expect(decopilot).not.toBeNull();
    expect(decopilot?.title).toBe("Super Agent");
    expect(decopilot?.connections).toEqual([]);
  });
});

describe("VirtualMCPStorage.searchAcrossMemberships", () => {
  let database: StudioDatabase;
  let storage: VirtualMCPStorage;
  const orgId = "org_search_twice";
  const userId = "user_search_twice";

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);

    const now = new Date().toISOString();
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${orgId}, ${orgId}, ${orgId}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${userId}, ${`${userId}@test.com`}, false, 'Test User', ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
    // The user holds two member rows in the same org.
    await sql`
      INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
      VALUES (${`mem_${userId}_1`}, ${orgId}, ${userId}, 'user', ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
    await sql`
      INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
      VALUES (${`mem_${userId}_2`}, ${orgId}, ${userId}, 'user', ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
    await database.db
      .insertInto("connections")
      .values({
        id: "conn_search_twice",
        organization_id: orgId,
        created_by: userId,
        updated_by: null,
        title: "Twice Joined Project",
        description: null,
        icon: null,
        app_name: null,
        app_id: null,
        slug: null,
        connection_type: "VIRTUAL",
        connection_url: null,
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
    await closeTestPgDatabase(database);
  });

  test("lists a project once when the user holds two member rows in its org", async () => {
    const hits = await storage.searchAcrossMemberships({
      userId,
      term: "twice",
      limit: 20,
    });
    expect(hits.map((hit) => hit.id)).toEqual(["conn_search_twice"]);
  });
});
