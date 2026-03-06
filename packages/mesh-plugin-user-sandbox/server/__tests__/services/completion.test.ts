/**
 * Completion Service Tests
 */

import { describe, it, expect, afterEach } from "bun:test";
import { Kysely } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { KyselyPGlite } from "kysely-pglite";
import {
  completeSession,
  type CompletionContext,
} from "../../services/completion";
import type { UserSandboxPluginStorage } from "../../storage";
import type {
  UserSandboxEntity,
  UserSandboxSessionEntity,
} from "../../storage/types";

// Track PGlite + Kysely instances for cleanup
const cleanupQueue: Array<{ db: Kysely<unknown>; pglite: PGlite }> = [];

afterEach(async () => {
  for (const { db, pglite } of cleanupQueue) {
    await db.destroy();
    try {
      await pglite.close();
    } catch (error) {
      // PGlite may already be closed by Kysely's destroy()
      if (
        !(error instanceof Error) ||
        !error.message.includes("PGlite is closed")
      ) {
        throw error;
      }
    }
  }
  cleanupQueue.length = 0;
});

// Create test database with required tables
async function createTestDb() {
  const pglite = new PGlite();
  const db = new Kysely({
    dialect: new KyselyPGlite(pglite).dialect,
  });
  cleanupQueue.push({ db: db as Kysely<unknown>, pglite });

  // Create minimal tables needed for completion
  await db.schema
    .createTable("connections")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) => col.notNull())
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("icon", "text")
    .addColumn("app_name", "text")
    .addColumn("app_id", "text")
    .addColumn("connection_type", "text", (col) => col.notNull())
    .addColumn("connection_url", "text")
    .addColumn("connection_token", "text")
    .addColumn("connection_headers", "text")
    .addColumn("oauth_config", "text")
    .addColumn("configuration_state", "text")
    .addColumn("configuration_scopes", "text")
    .addColumn("metadata", "text")
    .addColumn("tools", "text")
    .addColumn("bindings", "text")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("connection_aggregations")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("parent_connection_id", "text", (col) => col.notNull())
    .addColumn("child_connection_id", "text", (col) => col.notNull())
    .addColumn("selected_tools", "text")
    .addColumn("selected_resources", "text")
    .addColumn("selected_prompts", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();

  return db;
}

// Create test session
// NOTE: created_agent_id is set because agent is created at session creation time
function createTestSession(
  overrides?: Partial<UserSandboxSessionEntity>,
): UserSandboxSessionEntity {
  return {
    id: "uss_test",
    template_id: "usb_test",
    organization_id: "org_test",
    external_user_id: "user_123",
    status: "in_progress",
    app_statuses: {
      "@deco/gmail": {
        configured: true,
        connection_id: "conn_gmail",
        error: null,
      },
    },
    created_agent_id: "vir_test_agent", // Agent created at session creation
    redirect_url: "https://app.example.com/callback",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    ...overrides,
  };
}

// Create the agent (Virtual MCP) in test database
async function createTestAgent(db: Kysely<unknown>) {
  const now = new Date().toISOString();
  await (db as Kysely<{ connections: Record<string, unknown> }>)
    .insertInto("connections")
    .values({
      id: "vir_test_agent",
      organization_id: "org_test",
      created_by: "user_test",
      title: "Test Agent",
      description: null,
      icon: null,
      app_name: null,
      app_id: null,
      connection_type: "VIRTUAL",
      connection_url: "virtual://vir_test_agent",
      connection_token: null,
      connection_headers: null,
      oauth_config: null,
      configuration_state: null,
      configuration_scopes: null,
      metadata: JSON.stringify({
        user_sandbox_id: "usb_test",
        external_user_id: "user_123",
      }),
      tools: null,
      bindings: null,
      status: "active",
      created_at: now,
      updated_at: now,
    })
    .execute();
}

// Create test template
function createTestTemplate(
  overrides?: Partial<UserSandboxEntity>,
): UserSandboxEntity {
  return {
    id: "usb_test",
    organization_id: "org_test",
    title: "Test Template",
    description: "Test description",
    icon: null,
    required_apps: [
      {
        app_name: "@deco/gmail",
        title: "Gmail",
        description: null,
        icon: null,
        connection_type: "HTTP",
        connection_url: "https://mcp.example.com/gmail",
        connection_headers: null,
        oauth_config: null,
        selected_tools: null,
        selected_resources: null,
        selected_prompts: null,
      },
    ],
    redirect_url: "https://app.example.com/default-callback",
    webhook_url: null,
    event_type: "integration.completed",
    agent_title_template: "{{externalUserId}}'s Agent",
    agent_instructions: null,
    tool_selection_mode: "inclusion",
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "user_test",
    ...overrides,
  };
}

// Create mock storage
function createMockStorage(): UserSandboxPluginStorage {
  return {
    templates: {
      findById: async () => null,
      list: async () => [],
      create: async () => createTestTemplate(),
      update: async () => createTestTemplate(),
      delete: async () => {},
    },
    sessions: {
      findById: async () => null,
      findExisting: async () => null,
      listByTemplate: async () => [],
      listByOrganization: async () => [],
      create: async () => createTestSession(),
      update: async (id, data) => ({
        ...createTestSession(),
        ...data,
      }),
      delete: async () => {},
      deleteExpired: async () => 0,
    },
  };
}

// Create mock context with db and pre-created agent
async function createMockContext(
  overrides?: Partial<CompletionContext>,
): Promise<CompletionContext> {
  const db = await createTestDb();
  // Create the agent that was created at session creation time
  await createTestAgent(db);
  return {
    organizationId: "org_test",
    db,
    eventBus: undefined,
    ...overrides,
  };
}

describe("completeSession", () => {
  it("completes session and links connections to existing Virtual MCP", async () => {
    const session = createTestSession();
    const template = createTestTemplate();
    const storage = createMockStorage();
    const ctx = await createMockContext();

    const result = await completeSession(session, template, storage, ctx);

    expect(result.success).toBe(true);
    // Agent was pre-created at session creation time
    expect(result.agentId).toBe("vir_test_agent");
    expect(result.connectionIds).toContain("conn_gmail");
  });

  it("builds redirect URL with query params", async () => {
    const session = createTestSession({
      redirect_url: "https://app.example.com/callback",
    });
    const template = createTestTemplate();
    const storage = createMockStorage();
    const ctx = await createMockContext();

    const result = await completeSession(session, template, storage, ctx);

    expect(result.redirectUrl).toBeTruthy();
    expect(result.redirectUrl).toContain("sessionId=uss_test");
    expect(result.redirectUrl).toContain("externalUserId=user_123");
    // Uses the pre-created agent ID
    expect(result.redirectUrl).toContain("agentId=vir_test_agent");
  });

  it("uses template redirect_url if session has none", async () => {
    const session = createTestSession({ redirect_url: null });
    const template = createTestTemplate({
      redirect_url: "https://default.example.com/callback",
    });
    const storage = createMockStorage();
    const ctx = await createMockContext();

    const result = await completeSession(session, template, storage, ctx);

    expect(result.redirectUrl).toContain("default.example.com");
  });

  it("returns null redirectUrl if neither session nor template has one", async () => {
    const session = createTestSession({ redirect_url: null });
    const template = createTestTemplate({ redirect_url: null });
    const storage = createMockStorage();
    const ctx = await createMockContext();

    const result = await completeSession(session, template, storage, ctx);

    expect(result.redirectUrl).toBeNull();
  });

  it("uses pre-existing agent from session", async () => {
    const session = createTestSession({
      external_user_id: "user_123",
    });
    const template = createTestTemplate({
      agent_title_template: "Agent for {{externalUserId}}",
    });
    const storage = createMockStorage();
    const ctx = await createMockContext();

    const result = await completeSession(session, template, storage, ctx);
    expect(result.success).toBe(true);
    // Agent was created at session creation, not completion
    expect(result.agentId).toBe("vir_test_agent");

    // Verify the agent exists and aggregations were created
    const db = ctx.db as Kysely<{ connections: { id: string; title: string } }>;
    const connection = await db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", result.agentId!)
      .executeTakeFirst();
    // Agent title was set at session creation time
    expect(connection?.title).toBe("Test Agent");
  });

  it("emits event when eventBus is provided", async () => {
    const session = createTestSession();
    const template = createTestTemplate({ event_type: "custom.event" });
    const storage = createMockStorage();

    let publishedEvent: unknown = null;
    const ctx = await createMockContext({
      eventBus: {
        publish: async (orgId, source, event) => {
          publishedEvent = event;
        },
      },
    });

    const result = await completeSession(session, template, storage, ctx);

    expect(result.eventEmitted).toBe(true);
    expect(publishedEvent).toBeTruthy();
    expect((publishedEvent as { type: string }).type).toBe("custom.event");
  });

  it("does not fail if eventBus is not provided", async () => {
    const session = createTestSession();
    const template = createTestTemplate();
    const storage = createMockStorage();
    const ctx = await createMockContext({ eventBus: undefined });

    const result = await completeSession(session, template, storage, ctx);

    expect(result.success).toBe(true);
    expect(result.eventEmitted).toBe(false);
  });

  it("handles webhook URL if configured", async () => {
    // Skip actual fetch in tests
    const originalFetch = global.fetch;
    global.fetch = (async () => ({ ok: true })) as typeof fetch;

    try {
      const session = createTestSession();
      const template = createTestTemplate({
        webhook_url: "https://api.example.com/webhook",
      });
      const storage = createMockStorage();
      const ctx = await createMockContext();

      const result = await completeSession(session, template, storage, ctx);

      expect(result.webhookCalled).toBe(true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("collects connection IDs from configured apps", async () => {
    const session = createTestSession({
      app_statuses: {
        "@deco/gmail": {
          configured: true,
          connection_id: "conn_1",
          error: null,
        },
        "@deco/calendar": {
          configured: true,
          connection_id: "conn_2",
          error: null,
        },
        "@deco/drive": { configured: false, connection_id: null, error: null },
      },
    });
    const template = createTestTemplate();
    const storage = createMockStorage();
    const ctx = await createMockContext();

    const result = await completeSession(session, template, storage, ctx);

    expect(result.connectionIds).toHaveLength(2);
    expect(result.connectionIds).toContain("conn_1");
    expect(result.connectionIds).toContain("conn_2");
  });
});
