import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createDatabase, closeDatabase, type MeshDatabase } from "../database";
import { ConnectionStorage } from "./connection";
import { CredentialVault } from "../encryption/credential-vault";
import { createTestSchema, seedCommonTestFixtures } from "./test-helpers";

describe("ConnectionStorage", () => {
  let database: MeshDatabase;
  let storage: ConnectionStorage;
  let vault: CredentialVault;

  beforeAll(async () => {
    database = createDatabase(":memory:");
    vault = new CredentialVault(CredentialVault.generateKey());
    storage = new ConnectionStorage(database.db, vault);
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);
  });

  afterAll(async () => {
    await closeDatabase(database);
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

      const found = await storage.findById(created.id);
      expect(found).not.toBeNull();
      expect(found?.title).toBe("Find Me");
    });

    it("should return null for non-existent ID", async () => {
      const found = await storage.findById("conn_nonexistent");
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

      const connections = await storage.list("org_123");
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

      const connections = await storage.list("org_123");
      expect(connections.every((c) => c.organization_id === "org_123")).toBe(
        true,
      );
      expect(connections.some((c) => c.organization_id === "org_456")).toBe(
        false,
      );
    });
  });

  describe("update", () => {
    it("should update connection title", async () => {
      const created = await storage.create({
        organization_id: "org_123",
        created_by: "user_123",
        title: "Original Name",
        connection_type: "HTTP",
        connection_url: "https://test.com",
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
        connection_url: "https://test.com",
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
        connection_url: "https://test.com",
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
        connection_url: "https://test.com",
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
        connection_url: "https://test.com",
      });

      await storage.delete(created.id);

      const found = await storage.findById(created.id);
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
        connection_url: "https://test.com",
        connection_headers: { headers: { "X-Test": "value" } },
        metadata: { key: "value" },
      });

      // Update with tools and bindings
      const updated = await storage.update(connection.id, {
        tools: [{ name: "TEST_TOOL", inputSchema: {} }],
        bindings: ["CHAT"],
      });

      expect(updated.connection_headers).toEqual({
        headers: { "X-Test": "value" },
      });
      expect(updated.metadata).toEqual({ key: "value" });
      expect(updated.tools).toEqual([{ name: "TEST_TOOL", inputSchema: {} }]);
      expect(updated.bindings).toEqual(["CHAT"]);
    });
  });
});
