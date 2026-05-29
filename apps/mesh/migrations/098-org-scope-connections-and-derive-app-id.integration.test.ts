/**
 * Integration test for migration 098's exported helpers.
 *
 * The shared integration DB already has 098 applied (and is empty of seeded
 * rows), so we cannot observe the one-time up() backfill against pre-existing
 * data. Instead we test the idempotent, exported helpers directly against
 * seeded rows — they ARE the body of up().
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Kysely, sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { MeshDatabase } from "../src/database";
import {
  backfillConnectionAppIds,
  flipAllConnectionsToOrg,
} from "./098-org-scope-connections-and-derive-app-id";

const USER = "user_test";
const ORG = "org_test";

async function insertConn(
  database: MeshDatabase,
  id: string,
  opts: {
    type?: string;
    url?: string | null;
    appId?: string | null;
    access?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO connections (
      id, organization_id, created_by, title, connection_type,
      connection_url, app_id, access, status, created_at, updated_at
    ) VALUES (
      ${id}, ${ORG}, ${USER}, ${id}, ${opts.type ?? "HTTP"},
      ${opts.url ?? "https://example.com/mcp"}, ${opts.appId ?? null},
      ${opts.access ?? "org"}, 'active', ${now}, ${now}
    )
  `.execute(database.db);
}

async function read(
  database: MeshDatabase,
  id: string,
): Promise<{ access: string; app_id: string | null }> {
  const result = (await sql<{ access: string; app_id: string | null }>`
    SELECT access, app_id FROM connections WHERE id = ${id}
  `.execute(database.db)) as unknown as {
    rows: { access: string; app_id: string | null }[];
  };
  return result.rows[0]!;
}

describe("migration 098 helpers", () => {
  let database: MeshDatabase;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("flips user-scoped connections to org", async () => {
    await insertConn(database, "c_user", { access: "user", appId: "x-app" });
    await flipAllConnectionsToOrg(database.db as Kysely<unknown>);
    expect((await read(database, "c_user")).access).toBe("org");
  });

  it("backfills a synthetic app_id for non-VIRTUAL rows with null app_id", async () => {
    await insertConn(database, "c_null", {
      url: "https://svc.com/mcp",
      appId: null,
    });
    await backfillConnectionAppIds(database.db as Kysely<unknown>);
    expect((await read(database, "c_null")).app_id).toBe("url:svc.com/mcp");
  });

  it("leaves VIRTUAL rows' app_id null", async () => {
    await insertConn(database, "c_virtual", {
      type: "VIRTUAL",
      url: "virtual://c_virtual",
      appId: null,
    });
    await backfillConnectionAppIds(database.db as Kysely<unknown>);
    expect((await read(database, "c_virtual")).app_id).toBeNull();
  });

  it("preserves an existing registry app_id", async () => {
    await insertConn(database, "c_reg", { appId: "deco/mcp-github" });
    await backfillConnectionAppIds(database.db as Kysely<unknown>);
    expect((await read(database, "c_reg")).app_id).toBe("deco/mcp-github");
  });
});
