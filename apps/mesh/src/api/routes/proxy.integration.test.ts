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
import type { EventBus } from "../../event-bus";
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

function createMockEventBus(): EventBus {
  return {
    getSubscription: async () => null,
    getEvent: async () => null,
    cancelEvent: async () => ({ success: true }),
    ackEvent: async () => ({ success: true }),
    syncSubscriptions: async () => ({
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      subscriptions: [],
    }),
    isRunning: () => false,
    start: async () => {},
    stop: async () => {},
    publish: async () => ({ success: true }) as any,
    subscribe: async () =>
      ({ success: true, subscriptionId: "mock-sub" }) as any,
    unsubscribe: async () => ({ success: true }),
    listSubscriptions: async () => [],
  };
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
    app = await createApp({ database, eventBus: createMockEventBus() });

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
});
