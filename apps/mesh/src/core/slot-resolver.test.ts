/**
 * Unit tests for slot-resolver. Given a Kysely DB plus a context
 * (organizationId, invokerUserId, appId), the resolver returns the
 * caller's user-private connection of the matching shape, falling back
 * to an org-shared one. Returns null when nothing matches.
 *
 * Resolution rules (from spec section "Slot resolution"):
 *  1. Match connections in the same organization with the same app_id.
 *  2. Only consider connections with status='active'.
 *  3. Prefer access='user' AND created_by=invokerUserId.
 *  4. Fall back to access='org' when no private match exists.
 *  5. Return null when neither matches.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../database/test-db";
import {
  createTestSchema,
  seedCommonTestFixtures,
} from "../storage/test-helpers";
import {
  SlotUnresolvedError,
  resolveSlot,
  SlotResolutionCache,
} from "./slot-resolver";

const USER_A = "user_test";
const USER_B = "user_1";
const ORG = "org_test";
const OTHER_ORG = "org_1";

async function insertConn(
  database: TestDatabase,
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
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
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

describe("SlotResolutionCache", () => {
  it("returns cached result without hitting the DB on repeated calls", async () => {
    const cache = new SlotResolutionCache();
    let hitCount = 0;

    const result1 = await cache.resolve("user_a", "mcp-github", async () => {
      hitCount++;
      return { connectionId: "conn_user_a", access: "user" as const };
    });
    const result2 = await cache.resolve("user_a", "mcp-github", async () => {
      hitCount++;
      return { connectionId: "different_id", access: "user" as const };
    });

    expect(result1).toEqual({ connectionId: "conn_user_a", access: "user" });
    expect(result2).toEqual({ connectionId: "conn_user_a", access: "user" });
    expect(hitCount).toBe(1);
  });

  it("caches null results too", async () => {
    const cache = new SlotResolutionCache();
    let hitCount = 0;

    const result1 = await cache.resolve("user_a", "mcp-github", async () => {
      hitCount++;
      return null;
    });
    const result2 = await cache.resolve("user_a", "mcp-github", async () => {
      hitCount++;
      return { connectionId: "conn_new", access: "user" as const };
    });

    expect(result1).toBeNull();
    expect(result2).toBeNull();
    expect(hitCount).toBe(1);
  });

  it("scopes cache by (userId, appId)", async () => {
    const cache = new SlotResolutionCache();
    let hitCount = 0;

    await cache.resolve("user_a", "mcp-github", async () => {
      hitCount++;
      return { connectionId: "ga", access: "user" as const };
    });
    await cache.resolve("user_b", "mcp-github", async () => {
      hitCount++;
      return { connectionId: "gb", access: "user" as const };
    });
    await cache.resolve("user_a", "mcp-linear", async () => {
      hitCount++;
      return { connectionId: "la", access: "user" as const };
    });

    expect(hitCount).toBe(3);
  });
});

describe("SlotUnresolvedError", () => {
  it("carries app_id for the UI to surface", () => {
    const err = new SlotUnresolvedError("mcp-github");
    expect(err.appId).toBe("mcp-github");
    expect(err.name).toBe("SlotUnresolvedError");
    expect(err.message).toContain("mcp-github");
  });
});
