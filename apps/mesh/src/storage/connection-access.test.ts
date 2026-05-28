/**
 * Verifies that ConnectionStorage.list and findById honor the access column:
 *   - Org-shared rows are visible to everyone.
 *   - User-private rows are visible only to their creator.
 *   - When viewerUserId is undefined/null, only org-shared rows are returned
 *     (null) or every row is returned (undefined — internal infra path).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../database/test-db";
import { ConnectionStorage } from "./connection";
import { createTestSchema, seedCommonTestFixtures } from "./test-helpers";
import { CredentialVault } from "../encryption/credential-vault";

const USER_A = "user_test";
const USER_B = "user_1";
const ORG = "org_test";

async function seed(database: TestDatabase): Promise<void> {
  const now = new Date().toISOString();
  for (const [id, createdBy, access] of [
    ["conn_a_private", USER_A, "user"],
    ["conn_a_org", USER_A, "org"],
    ["conn_b_private", USER_B, "user"],
  ] as const) {
    await sql`
      INSERT INTO connections (
        id, organization_id, created_by, title, connection_type,
        connection_url, app_id, access, status, created_at, updated_at
      ) VALUES (
        ${id}, ${ORG}, ${createdBy}, ${id}, 'HTTP',
        'https://example.com', ${id + "-app"}, ${access},
        'active', ${now}, ${now}
      )
    `.execute(database.db);
  }
}

describe("ConnectionStorage — access filtering", () => {
  let database: TestDatabase;
  let storage: ConnectionStorage;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);
    await seed(database);
    const vault = new CredentialVault(CredentialVault.generateKey());
    storage = new ConnectionStorage(database.db, vault);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
  });

  it("list as USER_A: returns own private + org-shared, not USER_B's private", async () => {
    const { items } = await storage.list(ORG, { viewerUserId: USER_A });
    const ids = items.map((c) => c.id).sort();
    expect(ids).toEqual(["conn_a_org", "conn_a_private"]);
  });

  it("list as USER_B: returns own private + org-shared, not USER_A's private", async () => {
    const { items } = await storage.list(ORG, { viewerUserId: USER_B });
    const ids = items.map((c) => c.id).sort();
    expect(ids).toEqual(["conn_a_org", "conn_b_private"]);
  });

  it("list with viewerUserId=null returns only org-shared", async () => {
    const { items } = await storage.list(ORG, { viewerUserId: null });
    expect(items.map((c) => c.id)).toEqual(["conn_a_org"]);
  });

  it("list with no viewerUserId (internal infra) returns every row", async () => {
    const { items } = await storage.list(ORG);
    const ids = items.map((c) => c.id).sort();
    expect(ids).toEqual(["conn_a_org", "conn_a_private", "conn_b_private"]);
  });

  it("findById hides another user's private connection", async () => {
    const visible = await storage.findById("conn_b_private", ORG, USER_A);
    expect(visible).toBeNull();
  });

  it("findById returns own private connection", async () => {
    const own = await storage.findById("conn_a_private", ORG, USER_A);
    expect(own?.id).toBe("conn_a_private");
  });

  it("findById returns org-shared connection for any viewer", async () => {
    const shared = await storage.findById("conn_a_org", ORG, USER_B);
    expect(shared?.id).toBe("conn_a_org");
  });
});
