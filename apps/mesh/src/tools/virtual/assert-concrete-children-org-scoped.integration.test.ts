import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../../database/test-db-pg";
import type { MeshDatabase } from "../../database";
import { ConnectionStorage } from "../../storage/connection";
import { CredentialVault } from "../../encryption/credential-vault";
import { assertConcreteChildrenAreOrgScoped } from "./assert-concrete-children-org-scoped";

const USER = "user_test";
const ORG = "org_test";

async function insertConn(
  database: MeshDatabase,
  id: string,
  access: string,
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO connections (
      id, organization_id, created_by, title, connection_type,
      connection_url, app_id, access, status, created_at, updated_at
    ) VALUES (
      ${id}, ${ORG}, ${USER}, ${id}, 'HTTP',
      'https://example.com', ${id + "-app"}, ${access},
      'active', ${now}, ${now}
    )
  `.execute(database.db);
}

describe("assertConcreteChildrenAreOrgScoped", () => {
  let database: MeshDatabase;
  let storage: ConnectionStorage;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    await insertConn(database, "conn_org", "org");
    await insertConn(database, "conn_private", "user");
    const vault = new CredentialVault(CredentialVault.generateKey());
    storage = new ConnectionStorage(database.db, vault);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("allows org-scoped concrete children", async () => {
    await expect(
      assertConcreteChildrenAreOrgScoped(
        [{ connection_id: "conn_org" }],
        storage,
        ORG,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a private connection used as a concrete child", async () => {
    await expect(
      assertConcreteChildrenAreOrgScoped(
        [{ connection_id: "conn_private" }],
        storage,
        ORG,
      ),
    ).rejects.toThrow(/private and cannot be added as a concrete child/i);
  });

  it("rejects another user's private connection (the cross-user leak case)", async () => {
    // Seed a private connection owned by a DIFFERENT user than the caller.
    // The guard fetches with INTERNAL_VIEWER specifically so this row is
    // visible and rejected — the per-user visibility filter would otherwise
    // hide it and let the leak through.
    const now = new Date().toISOString();
    await sql`
      INSERT INTO connections (
        id, organization_id, created_by, title, connection_type,
        connection_url, app_id, access, status, created_at, updated_at
      ) VALUES (
        'conn_other_private', ${ORG}, 'user_1', 'conn_other_private', 'HTTP',
        'https://other-user.example.com', 'other-user-app', 'user',
        'active', ${now}, ${now}
      )
    `.execute(database.db);

    await expect(
      assertConcreteChildrenAreOrgScoped(
        [{ connection_id: "conn_other_private" }],
        storage,
        ORG,
      ),
    ).rejects.toThrow(/private and cannot be added as a concrete child/i);
  });

  it("is a no-op for an empty list", async () => {
    await expect(
      assertConcreteChildrenAreOrgScoped([], storage, ORG),
    ).resolves.toBeUndefined();
  });
});
