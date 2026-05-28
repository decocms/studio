/**
 * Integration tests for slot-resolver against a real Postgres DB. Given a
 * Kysely DB plus a context (organizationId, invokerUserId, appId), the
 * resolver returns the caller's user-private connection of the matching
 * shape, falling back to an org-shared one. Returns null when nothing
 * matches.
 *
 * Resolution rules (from spec section "Slot resolution"):
 *  1. Match connections in the same organization with the same app_id.
 *  2. Only consider connections with status='active'.
 *  3. Prefer access='user' AND created_by=invokerUserId.
 *  4. Fall back to access='org' when no private match exists.
 *  5. Return null when neither matches.
 *
 * Pure-logic coverage (SlotResolutionCache, SlotUnresolvedError) lives in
 * the unit-tier `slot-resolver.test.ts`.
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
import { resolveSlot } from "./slot-resolver";

const USER_A = "user_test";
const USER_B = "user_1";
const ORG = "org_test";
const OTHER_ORG = "org_1";

async function insertConn(
  database: MeshDatabase,
  id: string,
  opts: {
    appId: string;
    access: "user" | "org";
    createdBy?: string;
    organizationId?: string;
    status?: "active" | "inactive";
  },
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO connections (
      id, organization_id, created_by, title, connection_type,
      connection_url, app_id, access, status, created_at, updated_at
    ) VALUES (
      ${id}, ${opts.organizationId ?? ORG}, ${opts.createdBy ?? USER_A},
      'test', 'HTTP', 'https://example.com', ${opts.appId},
      ${opts.access}, ${opts.status ?? "active"}, ${now}, ${now}
    )
  `.execute(database.db);
}

describe("resolveSlot", () => {
  let database: MeshDatabase;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("prefers user-private when both user-private and org-shared exist", async () => {
    await insertConn(database, "conn_org", {
      appId: "mcp-github",
      access: "org",
    });
    await insertConn(database, "conn_user", {
      appId: "mcp-github",
      access: "user",
      createdBy: USER_A,
    });

    const resolved = await resolveSlot(database.db, {
      organizationId: ORG,
      invokerUserId: USER_A,
      appId: "mcp-github",
    });

    expect(resolved).toEqual({
      connectionId: "conn_user",
      access: "user",
    });
  });

  it("falls back to org-shared when caller has no private connection", async () => {
    await insertConn(database, "conn_org", {
      appId: "mcp-github",
      access: "org",
    });

    const resolved = await resolveSlot(database.db, {
      organizationId: ORG,
      invokerUserId: USER_B,
      appId: "mcp-github",
    });

    expect(resolved).toEqual({
      connectionId: "conn_org",
      access: "org",
    });
  });

  it("returns null when nothing matches", async () => {
    const resolved = await resolveSlot(database.db, {
      organizationId: ORG,
      invokerUserId: USER_A,
      appId: "mcp-github",
    });
    expect(resolved).toBeNull();
  });

  it("does not resolve inactive connections", async () => {
    await insertConn(database, "conn_dead", {
      appId: "mcp-github",
      access: "user",
      createdBy: USER_A,
      status: "inactive",
    });

    const resolved = await resolveSlot(database.db, {
      organizationId: ORG,
      invokerUserId: USER_A,
      appId: "mcp-github",
    });

    expect(resolved).toBeNull();
  });

  it("does not leak across organizations", async () => {
    await insertConn(database, "conn_other_org", {
      appId: "mcp-github",
      access: "user",
      createdBy: USER_A,
      organizationId: OTHER_ORG,
    });

    const resolved = await resolveSlot(database.db, {
      organizationId: ORG,
      invokerUserId: USER_A,
      appId: "mcp-github",
    });

    expect(resolved).toBeNull();
  });

  it("does not match another user's user-private connection", async () => {
    await insertConn(database, "conn_other_user", {
      appId: "mcp-github",
      access: "user",
      createdBy: USER_B,
    });

    const resolved = await resolveSlot(database.db, {
      organizationId: ORG,
      invokerUserId: USER_A,
      appId: "mcp-github",
    });

    expect(resolved).toBeNull();
  });
});
