import { describe, it, expect, beforeAll, afterAll } from "bun:test";
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

describe("ConnectionStorage", () => {
  let database: MeshDatabase;
  let storage: ConnectionStorage;
  let vault: CredentialVault;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    vault = new CredentialVault(CredentialVault.generateKey());
    storage = new ConnectionStorage(database.db, vault);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  describe("create", () => {
    it("should create organization-scoped connection", async () => {
      const connection = await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Company Slack",
        description: "Slack for the organization",
        connection_type: "HTTP",
        connection_url: "https://slack.com/mcp",
        connection_token: "slack-token-123",
      });

      expect(connection.id).toMatch(/^conn_/);
      expect(connection.organization_id).toBe("org_123");
      expect(connection.title).toBe("Company Slack");
      expect(connection.status).toBe("active");
      expect(connection.connection_type).toBe("HTTP");
      expect(connection.connection_url).toBe("https://slack.com/mcp");
    });

    it("should serialize connection headers as JSON", async () => {
      const connection = await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "With Headers",
        connection_type: "SSE",
        connection_url: "https://sse.com",
        connection_headers: { headers: { "X-Custom": "value" } },
      });

      expect(connection.connection_headers).toEqual({
        headers: { "X-Custom": "value" },
      });
    });

    it("should serialize OAuth config as JSON", async () => {
      const connection = await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "OAuth Connection",
        connection_type: "HTTP",
        connection_url: "https://oauth.com",
        oauth_config: {
          authorizationEndpoint: "https://auth.com/authorize",
          tokenEndpoint: "https://auth.com/token",
          clientId: "client_123",
          scopes: ["mcp"],
          grantType: "authorization_code",
        },
      });

      expect(connection.oauth_config).toEqual({
        authorizationEndpoint: "https://auth.com/authorize",
        tokenEndpoint: "https://auth.com/token",
        clientId: "client_123",
        scopes: ["mcp"],
        grantType: "authorization_code",
      });
    });
  });

  describe("findById", () => {
    it("should find connection by ID", async () => {
      const created = await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Find Me",
        connection_type: "HTTP",
        connection_url: "https://test.com",
      });

      const found = await storage.findById(
        created.id,
        "org_123",
        INTERNAL_VIEWER,
      );
      expect(found).not.toBeNull();
      expect(found?.title).toBe("Find Me");
    });

    it("should return null for non-existent ID", async () => {
      const found = await storage.findById(
        "conn_nonexistent",
        "org_123",
        INTERNAL_VIEWER,
      );
      expect(found).toBeNull();
    });
  });

  describe("list", () => {
    it("should list all connections for an organization", async () => {
      await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Slack",
        connection_type: "HTTP",
        connection_url: "https://slack.com",
      });

      await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Gmail",
        connection_type: "HTTP",
        connection_url: "https://gmail.com",
      });

      const { items: connections } = await storage.list("org_123", {
        viewer: INTERNAL_VIEWER,
      });
      expect(connections.length).toBeGreaterThanOrEqual(2);
      expect(connections.every((c) => c.organization_id === "org_123")).toBe(
        true,
      );
    });

    it("should not list connections from other organizations", async () => {
      await storage.create({
        organization_id: "org_456",
        created_by: "user_123",
        title: "Other Org",
        connection_type: "HTTP",
        connection_url: "https://other.com",
      });

      const { items: connections } = await storage.list("org_123", {
        viewer: INTERNAL_VIEWER,
      });
      expect(connections.every((c) => c.organization_id === "org_123")).toBe(
        true,
      );
      expect(connections.some((c) => c.organization_id === "org_456")).toBe(
        false,
      );
    });
  });

  describe("list filtering", () => {
    beforeAll(async () => {
      await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Alpha",
        app_name: "alpha-app",
        connection_type: "HTTP",
        connection_url: "https://alpha.com/mcp",
      });
      await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Beta",
        app_name: null,
        connection_type: "HTTP",
        connection_url: "https://beta.io/api",
      });
      await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Gamma",
        app_name: null,
        connection_type: "SSE",
        connection_url: "https://gamma.example.com",
      });
    });

    it("should filter by slug (app_name present)", async () => {
      const { items } = await storage.list("org_123", {
        slug: "alpha-app",
        viewer: INTERNAL_VIEWER,
      });
      expect(items).toHaveLength(1);
      expect(items[0]!.title).toBe("Alpha");
    });

    it("should filter by slug (derived from connection_url)", async () => {
      const { items: all } = await storage.list("org_123", {
        viewer: INTERNAL_VIEWER,
      });
      const beta = all.find((c) => c.title === "Beta")!;
      expect(beta.slug).toBeTruthy();

      const { items } = await storage.list("org_123", {
        slug: beta.slug!,
        viewer: INTERNAL_VIEWER,
      });
      expect(items).toHaveLength(1);
      expect(items[0]!.title).toBe("Beta");
    });

    it("should filter by slug (derived from connection_url when no app_name)", async () => {
      const { items: all } = await storage.list("org_123", {
        viewer: INTERNAL_VIEWER,
      });
      const gamma = all.find((c) => c.title === "Gamma")!;
      expect(gamma.slug).toBeTruthy();

      const { items } = await storage.list("org_123", {
        slug: gamma.slug!,
        viewer: INTERNAL_VIEWER,
      });
      expect(items).toHaveLength(1);
      expect(items[0]!.title).toBe("Gamma");
    });

    it("should filter with where eq expression", async () => {
      const { items } = await storage.list("org_123", {
        where: { field: ["connection_type"], operator: "eq", value: "SSE" },
        viewer: INTERNAL_VIEWER,
      });
      expect(items.every((c) => c.connection_type === "SSE")).toBe(true);
      expect(items.some((c) => c.title === "Gamma")).toBe(true);
    });

    it("should filter with where like expression", async () => {
      const { items } = await storage.list("org_123", {
        where: {
          field: ["connection_url"],
          operator: "like",
          value: "https://alpha%",
        },
        viewer: INTERNAL_VIEWER,
      });
      expect(items).toHaveLength(1);
      expect(items[0]!.title).toBe("Alpha");
    });

    it("should filter with where contains expression", async () => {
      const { items } = await storage.list("org_123", {
        where: {
          field: ["title"],
          operator: "contains",
          value: "bet",
        },
        viewer: INTERNAL_VIEWER,
      });
      expect(items).toHaveLength(1);
      expect(items[0]!.title).toBe("Beta");
    });

    it("should filter with where in expression", async () => {
      const { items } = await storage.list("org_123", {
        where: {
          field: ["connection_type"],
          operator: "in",
          value: ["SSE", "Websocket"],
        },
        viewer: INTERNAL_VIEWER,
      });
      expect(items.every((c) => c.connection_type === "SSE")).toBe(true);
    });

    it("should filter with compound AND/OR conditions", async () => {
      const { items } = await storage.list("org_123", {
        where: {
          operator: "or",
          conditions: [
            { field: ["title"], operator: "eq", value: "Alpha" },
            { field: ["title"], operator: "eq", value: "Gamma" },
          ],
        },
        viewer: INTERNAL_VIEWER,
      });
      expect(items).toHaveLength(2);
      const titles = items.map((c) => c.title).sort();
      expect(titles).toEqual(["Alpha", "Gamma"]);
    });

    it("should apply orderBy", async () => {
      const { items } = await storage.list("org_123", {
        orderBy: [{ field: ["title"], direction: "desc", nulls: "last" }],
        viewer: INTERNAL_VIEWER,
      });
      const titles = items.map((c) => c.title);
      expect(titles).toEqual([...titles].sort().reverse());
    });

    it("should apply pagination", async () => {
      const { totalCount } = await storage.list("org_123", {
        viewer: INTERNAL_VIEWER,
      });
      expect(totalCount).toBeGreaterThanOrEqual(3);

      const page1 = await storage.list("org_123", {
        limit: 2,
        offset: 0,
        viewer: INTERNAL_VIEWER,
      });
      expect(page1.items).toHaveLength(2);
      expect(page1.totalCount).toBe(totalCount);

      const page2 = await storage.list("org_123", {
        limit: 2,
        offset: 2,
        viewer: INTERNAL_VIEWER,
      });
      expect(page2.items.length).toBeGreaterThanOrEqual(1);
      expect(page2.totalCount).toBe(totalCount);

      // No overlap between pages
      const page1Ids = new Set(page1.items.map((c) => c.id));
      expect(page2.items.every((c) => !page1Ids.has(c.id))).toBe(true);
    });

    it("should return correct totalCount with filters", async () => {
      const { totalCount } = await storage.list("org_123", {
        where: { field: ["connection_type"], operator: "eq", value: "HTTP" },
        viewer: INTERNAL_VIEWER,
      });
      // At least Alpha and Beta are HTTP
      expect(totalCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("slug computation", () => {
    it("should compute slug from app_name on create", async () => {
      const conn = await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Slug Test App Name",
        app_name: "my-cool-app",
        connection_type: "HTTP",
        connection_url: "https://slug-appname.test",
      });
      expect(conn.slug).toBe("my-cool-app");
    });

    it("should compute slug from connection_url when no app_name", async () => {
      const conn = await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Slug Test URL",
        connection_type: "HTTP",
        connection_url: "https://example.com:8080/my-service",
      });
      // Dots are stripped by slugify, so "example.com" becomes "examplecom"
      expect(conn.slug).toBe("examplecom-8080-my-service");
    });

    it("should recompute slug on update when app_name changes", async () => {
      const conn = await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Slug Update Test",
        connection_type: "HTTP",
        connection_url: "https://slug-update.test",
      });

      const updated = await storage.update(conn.id, {
        app_name: "new-app-name",
      });
      expect(updated.slug).toBe("new-app-name");
    });
  });

  describe("update", () => {
    it("should update connection title", async () => {
      const created = await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Original Name",
        connection_type: "HTTP",
        connection_url: "https://update-title.test",
      });

      const updated = await storage.update(created.id, {
        title: "Updated Name",
      });

      expect(updated.title).toBe("Updated Name");
    });

    it("should update connection status", async () => {
      const created = await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Test",
        connection_type: "HTTP",
        connection_url: "https://update-status.test",
      });

      const updated = await storage.update(created.id, {
        status: "inactive",
      });

      expect(updated.status).toBe("inactive");
    });

    it("should update metadata", async () => {
      const created = await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Test",
        connection_type: "HTTP",
        connection_url: "https://update-metadata.test",
      });

      const updated = await storage.update(created.id, {
        metadata: { version: "2.0" },
      });

      expect(updated.metadata).toEqual({ version: "2.0" });
    });

    it("should update bindings", async () => {
      const created = await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Test",
        connection_type: "HTTP",
        connection_url: "https://update-bindings.test",
      });

      const updated = await storage.update(created.id, {
        bindings: ["CHAT", "EMAIL"],
      });

      expect(updated.bindings).toEqual(["CHAT", "EMAIL"]);
    });
  });

  describe("delete", () => {
    it("should delete connection", async () => {
      const created = await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "To Delete",
        connection_type: "HTTP",
        connection_url: "https://delete-me.test",
      });

      await storage.delete(created.id);

      const found = await storage.findById(
        created.id,
        "org_123",
        INTERNAL_VIEWER,
      );
      expect(found).toBeNull();
    });
  });

  describe("testConnection", () => {
    it("should throw when connection not found", async () => {
      await expect(storage.testConnection("conn_nonexistent")).rejects.toThrow(
        "Connection not found",
      );
    });

    it("should return unhealthy for unreachable connection", async () => {
      const created = await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Unreachable",
        connection_type: "HTTP",
        connection_url: "https://this-should-not-exist-12345.com/mcp",
      });

      const result = await storage.testConnection(created.id);

      expect(result.healthy).toBe(false);
      expect(result.latencyMs).toBeGreaterThan(0);
    });
  });

  describe("JSON deserialization", () => {
    it("should deserialize all JSON fields correctly", async () => {
      const connection = await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "JSON Test",
        connection_type: "SSE",
        connection_url: "https://json-test.test",
        connection_headers: { headers: { "X-Test": "value" } },
        metadata: { key: "value" },
      });

      // Tools are cached outside the connections table; bindings still round-trip
      // through storage as JSON.
      const updated = await storage.update(connection.id, {
        bindings: ["CHAT"],
      });

      expect(updated.connection_headers).toEqual({
        headers: { "X-Test": "value" },
      });
      expect(updated.metadata).toEqual({ key: "value" });
      expect(updated.tools).toBeNull();
      expect(updated.bindings).toEqual(["CHAT"]);
    });
  });
});
