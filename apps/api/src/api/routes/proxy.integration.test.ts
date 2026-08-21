/**
 * MCP Proxy Route Tests
 *
 * Tests that the MCP proxy enforces organization context on all requests,
 * preventing cross-tenant access when ctx.organization is absent
 * (e.g. API key created without org metadata).
 */

// CredentialVault requires a valid 32-byte base64 ENCRYPTION_KEY.
process.env.ENCRYPTION_KEY ??= Buffer.from("0".repeat(32)).toString("base64");

import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import { auth } from "../../auth";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import type { StudioDatabase } from "../../database";
import { setGlobalSettings, getSettings } from "../../settings";
import { createApp } from "../app";

function ensureEncryptionKey() {
  if (!getSettings().encryptionKey) {
    setGlobalSettings({
      ...getSettings(),
      encryptionKey: process.env.ENCRYPTION_KEY!,
    });
  }
}

describe("MCP Proxy null-org bypass", () => {
  let database: StudioDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;

  const attackerUserId = "user_attacker";
  const victimOrgId = "org_victim";

  beforeEach(async () => {
    ensureEncryptionKey();
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    app = await createApp({ database, disableNats: true });

    const now = new Date().toISOString();

    // Create attacker user via raw SQL — `emailVerified` is BOOLEAN in
    // real Postgres (Better Auth) but `storage/types.ts` still has the
    // stale `number` shape from the PGlite era. Raw SQL bypasses the
    // type until that gets regenerated.
    const { sql } = await import("kysely");
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${attackerUserId}, 'attacker@example.com', false, 'Attacker', ${now}, ${now})
    `.execute(database.db);

    // (No insert into "users" — that table only existed in the PGlite
    // hand-rolled schema, not in real Postgres migrations. The Better Auth
    // "user" row inserted above is sufficient.)

    // Create victim organization and a connection in it
    await database.db
      .insertInto("organization" as any)
      .values({
        id: victimOrgId,
        name: "Victim Org",
        slug: "victim-org",
        createdAt: now,
      })
      .execute();

    await database.db
      .insertInto("connections")
      .values({
        id: "conn_victim_123",
        organization_id: victimOrgId,
        created_by: attackerUserId,
        title: "Victim Connection",
        connection_type: "HTTP",
        connection_url: "https://example.com/mcp",
        status: "active",
        pinned: false,
        created_at: now,
        updated_at: now,
      })
      .execute();

    // Mock auth: attacker is authenticated but with NO org context
    // (simulates an API key created without org metadata)
    vi.spyOn(auth.api, "getMcpSession").mockResolvedValue(null);
    vi.spyOn(auth.api, "setActiveOrganization").mockResolvedValue(null as any);
    vi.spyOn(auth.api, "getSession" as any).mockImplementation(async () => ({
      user: { id: attackerUserId, email: "attacker@example.com" },
      session: { activeOrganizationId: null },
    }));
    vi.spyOn(auth.api, "getFullOrganization" as any).mockImplementation(
      async () => null,
    );
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
    vi.restoreAllMocks();
  });

  it("should reject proxy access when organization context is missing", async () => {
    const response = await app.request("/mcp/conn_victim_123", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "attacker", version: "1.0" },
        },
      }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("Organization context is required");
  });

  it("should reject call-tool access when organization context is missing", async () => {
    const response = await app.request(
      "/mcp/conn_victim_123/call-tool/some_tool",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("Organization context is required");
  });
});

describe("MCP Proxy call-tool disabled-connection gate", () => {
  let database: StudioDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;

  const memberUserId = "user_member";
  const orgId = "org_owner";
  const connectionId = "conn_disabled_123";

  beforeEach(async () => {
    ensureEncryptionKey();
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    app = await createApp({ database, disableNats: true });

    const now = new Date().toISOString();
    const { sql } = await import("kysely");
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${memberUserId}, 'member@example.com', false, 'Member', ${now}, ${now})
    `.execute(database.db);

    await database.db
      .insertInto("organization" as any)
      .values({
        id: orgId,
        name: "Owner Org",
        slug: "owner-org",
        createdAt: now,
      })
      .execute();

    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES ('mem_owner', ${memberUserId}, ${orgId}, 'member', ${now})
    `.execute(database.db);

    await database.db
      .insertInto("connections")
      .values({
        id: connectionId,
        organization_id: orgId,
        created_by: memberUserId,
        title: "Disabled Connection",
        connection_type: "HTTP",
        connection_url: "https://example.com/mcp",
        status: "error",
        pinned: false,
        created_at: now,
        updated_at: now,
      })
      .execute();

    vi.spyOn(auth.api, "getMcpSession").mockResolvedValue(null);
    vi.spyOn(auth.api, "setActiveOrganization").mockResolvedValue(null as any);
    vi.spyOn(auth.api, "getSession" as any).mockImplementation(async () => ({
      user: { id: memberUserId, email: "member@example.com" },
      session: { activeOrganizationId: null },
    }));
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
    vi.restoreAllMocks();
  });

  it("should reject call-tool against a disabled connection without contacting it", async () => {
    const response = await app.request(
      `/mcp/${connectionId}/call-tool/some_tool`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-org-id": orgId },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain("Connection inactive");
  });
});

describe("MCP Proxy call-tool malformed body", () => {
  let database: StudioDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;

  const memberUserId = "user_member";
  const orgId = "org_owner";
  const connectionId = "conn_active_123";

  beforeEach(async () => {
    ensureEncryptionKey();
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    app = await createApp({ database, disableNats: true });

    const now = new Date().toISOString();
    const { sql } = await import("kysely");
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${memberUserId}, 'member@example.com', false, 'Member', ${now}, ${now})
    `.execute(database.db);

    await database.db
      .insertInto("organization" as any)
      .values({
        id: orgId,
        name: "Owner Org",
        slug: "owner-org",
        createdAt: now,
      })
      .execute();

    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES ('mem_owner', ${memberUserId}, ${orgId}, 'member', ${now})
    `.execute(database.db);

    await database.db
      .insertInto("connections")
      .values({
        id: connectionId,
        organization_id: orgId,
        created_by: memberUserId,
        title: "Active Connection",
        connection_type: "HTTP",
        connection_url: "https://example.com/mcp",
        status: "active",
        pinned: false,
        created_at: now,
        updated_at: now,
      })
      .execute();

    vi.spyOn(auth.api, "getMcpSession").mockResolvedValue(null);
    vi.spyOn(auth.api, "setActiveOrganization").mockResolvedValue(null as any);
    vi.spyOn(auth.api, "getSession" as any).mockImplementation(async () => ({
      user: { id: memberUserId, email: "member@example.com" },
      session: { activeOrganizationId: null },
    }));
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
    vi.restoreAllMocks();
  });

  it("should reject a non-JSON call-tool body with 400, not 500", async () => {
    const response = await app.request(
      `/mcp/${connectionId}/call-tool/some_tool`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-org-id": orgId },
        body: "not json",
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("valid JSON");
  });
});

describe("MCP Proxy call-tool organization ownership", () => {
  let database: StudioDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;

  const userIdOrgA = "user_org_a";
  const userIdOrgB = "user_org_b";
  const orgIdA = "org_a";
  const orgIdB = "org_b";
  const connIdOrgB = "conn_org_b_123";

  beforeEach(async () => {
    ensureEncryptionKey();
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    app = await createApp({ database, disableNats: true });

    const now = new Date().toISOString();
    const { sql } = await import("kysely");

    // Create two users and two orgs
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES
        (${userIdOrgA}, 'user-a@example.com', false, 'User A', ${now}, ${now}),
        (${userIdOrgB}, 'user-b@example.com', false, 'User B', ${now}, ${now})
    `.execute(database.db);

    await database.db
      .insertInto("organization" as any)
      .values([
        { id: orgIdA, name: "Org A", slug: "org-a", createdAt: now },
        { id: orgIdB, name: "Org B", slug: "org-b", createdAt: now },
      ])
      .execute();

    // Add users to their respective orgs
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES
        ('mem_a', ${userIdOrgA}, ${orgIdA}, 'member', ${now}),
        ('mem_b', ${userIdOrgB}, ${orgIdB}, 'member', ${now})
    `.execute(database.db);

    // Create a connection in Org B
    await database.db
      .insertInto("connections")
      .values({
        id: connIdOrgB,
        organization_id: orgIdB,
        created_by: userIdOrgB,
        title: "Org B Connection",
        connection_type: "HTTP",
        connection_url: "https://example.com/mcp",
        status: "active",
        pinned: false,
        created_at: now,
        updated_at: now,
      })
      .execute();
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
    vi.restoreAllMocks();
  });

  it("should reject call-tool when user's org differs from connection's org", async () => {
    // User from Org A tries to call tool on connection in Org B
    vi.spyOn(auth.api, "getMcpSession").mockResolvedValue(null);
    vi.spyOn(auth.api, "setActiveOrganization").mockResolvedValue(null as any);
    vi.spyOn(auth.api, "getSession" as any).mockImplementation(async () => ({
      user: { id: userIdOrgA, email: "user-a@example.com" },
      session: { activeOrganizationId: orgIdA },
    }));
    vi.spyOn(auth.api, "getFullOrganization" as any).mockImplementation(
      async () => ({ id: orgIdA, slug: "org-a" }),
    );

    const response = await app.request(
      `/mcp/${connIdOrgB}/call-tool/some_tool`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toContain("Connection not found");
  });
});
