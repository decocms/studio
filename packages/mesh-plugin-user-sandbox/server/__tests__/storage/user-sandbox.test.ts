/**
 * User Sandbox Storage Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Kysely } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { KyselyPGlite } from "kysely-pglite";
import { UserSandboxStorage } from "../../storage/user-sandbox";
import { migration } from "../../migrations/001-user-sandbox";
import type { UserSandboxDatabase } from "../../storage/types";

// Test database setup
let pgliteInstance: PGlite;
let db: Kysely<UserSandboxDatabase>;
let storage: UserSandboxStorage;

// Create test organizations and users in the database
async function setupTestData() {
  // Create minimal schema for foreign keys
  await db.schema
    .createTable("organization")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text")
    .execute();

  await db.schema
    .createTable("user")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text")
    .execute();

  await db.schema
    .createTable("connections")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .execute();

  // Insert test data
  await db
    .insertInto("organization" as never)
    .values({ id: "org_test", name: "Test Org" })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();

  await db
    .insertInto("user" as never)
    .values({ id: "user_test", name: "Test User" })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
}

beforeEach(async () => {
  // Create in-memory PGlite database
  pgliteInstance = new PGlite();
  db = new Kysely<UserSandboxDatabase>({
    dialect: new KyselyPGlite(pgliteInstance).dialect,
  });

  await setupTestData();
  await migration.up(db as Kysely<unknown>);
  storage = new UserSandboxStorage(db);
});

afterEach(async () => {
  await db.destroy();
  try {
    await pgliteInstance.close();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("PGlite is closed")
    ) {
      throw error;
    }
  }
});

describe("UserSandboxStorage", () => {
  describe("create", () => {
    it("creates a template with required_apps", async () => {
      const template = await storage.create({
        organization_id: "org_test",
        title: "Test Template",
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
        created_by: "user_test",
      });

      expect(template.id).toStartWith("usb_");
      expect(template.title).toBe("Test Template");
      expect(template.organization_id).toBe("org_test");
      expect(template.required_apps).toHaveLength(1);
      expect(template.required_apps[0].app_name).toBe("@deco/gmail");
      expect(template.required_apps[0].connection_type).toBe("HTTP");
      expect(template.status).toBe("active");
    });

    it("creates a template with all configuration options", async () => {
      const template = await storage.create({
        organization_id: "org_test",
        title: "Full Config Template",
        description: "Test description",
        icon: "https://example.com/icon.png",
        required_apps: [
          {
            app_name: "@deco/gmail",
            title: "Gmail",
            description: "Google Mail integration",
            icon: "https://example.com/gmail.png",
            connection_type: "HTTP",
            connection_url: "https://mcp.example.com/gmail",
            connection_headers: null,
            oauth_config: {
              authorizationEndpoint:
                "https://accounts.google.com/o/oauth2/auth",
              tokenEndpoint: "https://oauth2.googleapis.com/token",
              clientId: "test-client-id",
              scopes: ["gmail.readonly"],
              grantType: "authorization_code",
            },
            selected_tools: ["send_email", "read_inbox"],
            selected_resources: null,
            selected_prompts: null,
          },
          {
            app_name: "@deco/calendar",
            title: "Calendar",
            description: null,
            icon: null,
            connection_type: "SSE",
            connection_url: "https://mcp.example.com/calendar",
            connection_headers: null,
            oauth_config: null,
            selected_tools: null,
            selected_resources: ["events"],
            selected_prompts: null,
          },
        ],
        redirect_url: "https://app.example.com/callback",
        webhook_url: "https://api.example.com/webhook",
        event_type: "custom.completed",
        agent_title_template: "Agent for {{externalUserId}}",
        agent_instructions: "Follow these instructions",
        tool_selection_mode: "exclusion",
        created_by: "user_test",
      });

      expect(template.description).toBe("Test description");
      expect(template.icon).toBe("https://example.com/icon.png");
      expect(template.redirect_url).toBe("https://app.example.com/callback");
      expect(template.webhook_url).toBe("https://api.example.com/webhook");
      expect(template.event_type).toBe("custom.completed");
      expect(template.agent_title_template).toBe(
        "Agent for {{externalUserId}}",
      );
      expect(template.tool_selection_mode).toBe("exclusion");
      expect(template.required_apps).toHaveLength(2);
      expect(template.required_apps[0].oauth_config).toBeTruthy();
    });
  });

  describe("findById", () => {
    it("returns null for non-existent template", async () => {
      const template = await storage.findById("usb_nonexistent");
      expect(template).toBeNull();
    });

    it("returns template with deserialized required_apps", async () => {
      const created = await storage.create({
        organization_id: "org_test",
        title: "Test Template",
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
            selected_tools: ["send"],
            selected_resources: null,
            selected_prompts: null,
          },
        ],
        created_by: "user_test",
      });

      const found = await storage.findById(created.id);

      expect(found).not.toBeNull();
      expect(found!.required_apps).toBeInstanceOf(Array);
      expect(found!.required_apps[0].selected_tools).toEqual(["send"]);
    });
  });

  describe("list", () => {
    it("returns empty array when no templates exist", async () => {
      const templates = await storage.list("org_test");
      expect(templates).toEqual([]);
    });

    it("lists templates by organization", async () => {
      await storage.create({
        organization_id: "org_test",
        title: "Template 1",
        required_apps: [],
        created_by: "user_test",
      });

      await storage.create({
        organization_id: "org_test",
        title: "Template 2",
        required_apps: [],
        created_by: "user_test",
      });

      const templates = await storage.list("org_test");
      expect(templates).toHaveLength(2);
    });
  });

  describe("update", () => {
    it("updates template config", async () => {
      const created = await storage.create({
        organization_id: "org_test",
        title: "Original Title",
        required_apps: [],
        created_by: "user_test",
      });

      const updated = await storage.update(created.id, {
        title: "Updated Title",
        description: "New description",
        status: "inactive",
      });

      expect(updated.title).toBe("Updated Title");
      expect(updated.description).toBe("New description");
      expect(updated.status).toBe("inactive");
    });

    it("updates required_apps", async () => {
      const created = await storage.create({
        organization_id: "org_test",
        title: "Test",
        required_apps: [
          {
            app_name: "@deco/old",
            title: "Old App",
            description: null,
            icon: null,
            connection_type: "HTTP",
            connection_url: "https://mcp.example.com/old",
            connection_headers: null,
            oauth_config: null,
            selected_tools: null,
            selected_resources: null,
            selected_prompts: null,
          },
        ],
        created_by: "user_test",
      });

      const updated = await storage.update(created.id, {
        required_apps: [
          {
            app_name: "@deco/new",
            title: "New App",
            description: null,
            icon: null,
            connection_type: "SSE",
            connection_url: "https://mcp.example.com/new",
            connection_headers: null,
            oauth_config: null,
            selected_tools: ["tool1"],
            selected_resources: null,
            selected_prompts: null,
          },
        ],
      });

      expect(updated.required_apps).toHaveLength(1);
      expect(updated.required_apps[0].app_name).toBe("@deco/new");
    });
  });

  describe("delete", () => {
    it("deletes template", async () => {
      const created = await storage.create({
        organization_id: "org_test",
        title: "To Delete",
        required_apps: [],
        created_by: "user_test",
      });

      await storage.delete(created.id);

      const found = await storage.findById(created.id);
      expect(found).toBeNull();
    });
  });
});
