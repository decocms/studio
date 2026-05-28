/**
 * Verifies that ConnectionStorage.list and findById honor the access column:
 *   - Org-shared rows are visible to everyone.
 *   - User-private rows are visible only to their creator.
 *   - When viewer is `null`, only org-shared rows are returned.
 *   - When viewer is INTERNAL_VIEWER, every row is returned (trusted infra).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { MeshDatabase } from "../database";
import { ConnectionStorage } from "./connection";
import { INTERNAL_VIEWER } from "./ports";
import { CredentialVault } from "../encryption/credential-vault";

const USER_A = "user_test";
const USER_B = "user_1";
const ORG = "org_test";

async function seed(database: MeshDatabase): Promise<void> {
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
  let database: MeshDatabase;
  let storage: ConnectionStorage;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    await seed(database);
    const vault = new CredentialVault(CredentialVault.generateKey());
    storage = new ConnectionStorage(database.db, vault);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("list as USER_A: returns own private + org-shared, not USER_B's private", async () => {
    const { items } = await storage.list(ORG, { viewer: USER_A });
    const ids = items.map((c) => c.id).sort();
    expect(ids).toEqual(["conn_a_org", "conn_a_private"]);
  });

  it("list as USER_B: returns own private + org-shared, not USER_A's private", async () => {
    const { items } = await storage.list(ORG, { viewer: USER_B });
    const ids = items.map((c) => c.id).sort();
    expect(ids).toEqual(["conn_a_org", "conn_b_private"]);
  });

  it("list with viewer=null returns only org-shared", async () => {
    const { items } = await storage.list(ORG, { viewer: null });
    expect(items.map((c) => c.id)).toEqual(["conn_a_org"]);
  });

  it("list with INTERNAL_VIEWER returns every row", async () => {
    const { items } = await storage.list(ORG, { viewer: INTERNAL_VIEWER });
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
