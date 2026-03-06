import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "kysely";
import { createDatabase, closeDatabase, type MeshDatabase } from "../database";
import { SqlMonitoringStorage } from "./monitoring";
import { createTestSchema } from "./test-helpers";
import type { MonitoringLog } from "./types";

/** Helper to create a test log with defaults */
function createTestLog(overrides: Partial<MonitoringLog>): MonitoringLog {
  return {
    organizationId: "org_test",
    connectionId: "conn_test",
    connectionTitle: "Test Connection",
    toolName: "test_tool",
    input: {},
    output: {},
    isError: false,
    durationMs: 100,
    timestamp: new Date(),
    userId: null,
    requestId: `req_${Date.now()}`,
    ...overrides,
  };
}

/**
 * Seed parent records required by FK constraints.
 * PGlite (PostgreSQL) enforces FK constraints unlike SQLite in test mode.
 */
async function seedTestFixtures(database: MeshDatabase) {
  const db = database.db;
  const now = new Date().toISOString();

  // Create test user
  await sql`
    INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
    VALUES ('user_test', 'test@test.com', 0, 'Test User', ${now}, ${now})
    ON CONFLICT (id) DO NOTHING
  `.execute(db);

  // Create test organizations
  const orgIds = [
    "org_test",
    "org_props",
    "org_batch",
    "org_query",
    "org_propfilter",
    "org_stats",
  ];
  for (const orgId of orgIds) {
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${orgId}, ${orgId}, ${orgId}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(db);
  }

  // Create test connections
  const connIds = [
    { id: "conn_test", org: "org_test" },
    { id: "conn_1", org: "org_test" },
    { id: "conn_2", org: "org_props" },
    { id: "conn_batch", org: "org_batch" },
    { id: "conn_a", org: "org_query" },
    { id: "conn_b", org: "org_query" },
    { id: "conn_pf", org: "org_propfilter" },
    { id: "conn_stats", org: "org_stats" },
  ];
  for (const conn of connIds) {
    await sql`
      INSERT INTO "connections" (id, organization_id, created_by, title, connection_type, connection_url, created_at, updated_at)
      VALUES (${conn.id}, ${conn.org}, 'user_test', 'Test', 'stdio', 'test://localhost', ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(db);
  }
}

describe("SqlMonitoringStorage", () => {
  let database: MeshDatabase;
  let storage: SqlMonitoringStorage;

  beforeAll(async () => {
    database = createDatabase(":memory:");
    storage = new SqlMonitoringStorage(database.db);
    await createTestSchema(database.db);
    await seedTestFixtures(database);
  });

  afterAll(async () => {
    await closeDatabase(database);
  });

  describe("log", () => {
    it("should log a monitoring event", async () => {
      await storage.log(
        createTestLog({
          organizationId: "org_test",
          connectionId: "conn_1",
          toolName: "test_tool",
          input: { arg: "value" },
          output: { result: "ok" },
          requestId: "req_1",
        }),
      );

      const { logs } = await storage.query({ organizationId: "org_test" });
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs.some((l) => l.toolName === "test_tool")).toBe(true);
    });

    it("should log event with properties", async () => {
      await storage.log(
        createTestLog({
          organizationId: "org_props",
          connectionId: "conn_2",
          connectionTitle: "Props Connection",
          toolName: "props_tool",
          input: { test: true },
          output: { done: true },
          durationMs: 50,
          requestId: "req_props",
          properties: { thread_id: "thread_123", user_id: "user_456" },
        }),
      );

      const { logs } = await storage.query({ organizationId: "org_props" });
      const log = logs.find((l) => l.toolName === "props_tool");
      expect(log).toBeDefined();
      expect(log?.properties).toEqual({
        thread_id: "thread_123",
        user_id: "user_456",
      });
    });
  });

  describe("logBatch", () => {
    it("should log multiple events atomically", async () => {
      const events = [
        createTestLog({
          organizationId: "org_batch",
          connectionId: "conn_batch",
          connectionTitle: "Batch Connection",
          toolName: "batch_tool_1",
          durationMs: 10,
          requestId: "req_batch_1",
        }),
        createTestLog({
          organizationId: "org_batch",
          connectionId: "conn_batch",
          connectionTitle: "Batch Connection",
          toolName: "batch_tool_2",
          isError: true,
          errorMessage: "Test error",
          durationMs: 20,
          requestId: "req_batch_2",
        }),
      ];

      await storage.logBatch(events);

      const { logs } = await storage.query({ organizationId: "org_batch" });
      expect(logs.length).toBe(2);
      expect(logs.some((l) => l.toolName === "batch_tool_1")).toBe(true);
      expect(logs.some((l) => l.toolName === "batch_tool_2")).toBe(true);
    });
  });

  describe("query", () => {
    beforeAll(async () => {
      // Seed test data for query tests
      await storage.logBatch([
        createTestLog({
          organizationId: "org_query",
          connectionId: "conn_a",
          connectionTitle: "Connection A",
          toolName: "tool_alpha",
          durationMs: 100,
          timestamp: new Date("2024-01-01T10:00:00Z"),
          requestId: "req_q1",
          properties: { env: "production", region: "us-east" },
        }),
        createTestLog({
          organizationId: "org_query",
          connectionId: "conn_a",
          connectionTitle: "Connection A",
          toolName: "tool_beta",
          isError: true,
          errorMessage: "Failed",
          durationMs: 200,
          timestamp: new Date("2024-01-01T11:00:00Z"),
          requestId: "req_q2",
          properties: { env: "staging", region: "eu-west" },
        }),
        createTestLog({
          organizationId: "org_query",
          connectionId: "conn_b",
          connectionTitle: "Connection B",
          toolName: "tool_alpha",
          durationMs: 150,
          timestamp: new Date("2024-01-01T12:00:00Z"),
          requestId: "req_q3",
          properties: { env: "production", debug: "true" },
        }),
      ]);
    });

    it("should filter by organizationId", async () => {
      const { logs } = await storage.query({ organizationId: "org_query" });
      expect(logs.length).toBe(3);
      expect(logs.every((l) => l.organizationId === "org_query")).toBe(true);
    });

    it("should filter by connectionId", async () => {
      const { logs } = await storage.query({
        organizationId: "org_query",
        connectionId: "conn_a",
      });
      expect(logs.length).toBe(2);
      expect(logs.every((l) => l.connectionId === "conn_a")).toBe(true);
    });

    it("should filter by toolName", async () => {
      const { logs } = await storage.query({
        organizationId: "org_query",
        toolName: "tool_alpha",
      });
      expect(logs.length).toBe(2);
      expect(logs.every((l) => l.toolName === "tool_alpha")).toBe(true);
    });

    it("should filter by isError", async () => {
      const { logs } = await storage.query({
        organizationId: "org_query",
        isError: true,
      });
      expect(logs.length).toBe(1);
      const log = logs[0];
      expect(log).toBeDefined();
      expect(log!.isError).toBe(true);
      expect(log!.toolName).toBe("tool_beta");
    });

    it("should filter by date range", async () => {
      const { logs } = await storage.query({
        organizationId: "org_query",
        startDate: new Date("2024-01-01T10:30:00Z"),
        endDate: new Date("2024-01-01T11:30:00Z"),
      });
      expect(logs.length).toBe(1);
      const log = logs[0];
      expect(log).toBeDefined();
      expect(log!.toolName).toBe("tool_beta");
    });

    it("should paginate results", async () => {
      const { logs, total } = await storage.query({
        organizationId: "org_query",
        limit: 2,
        offset: 0,
      });
      expect(logs.length).toBe(2);
      expect(total).toBe(3);
    });

    it("should return total count with pagination", async () => {
      const { logs, total } = await storage.query({
        organizationId: "org_query",
        limit: 1,
        offset: 2,
      });
      expect(logs.length).toBe(1);
      expect(total).toBe(3);
    });
  });

  describe("property filters", () => {
    beforeAll(async () => {
      // Seed test data for property filter tests
      await storage.logBatch([
        createTestLog({
          organizationId: "org_propfilter",
          connectionId: "conn_pf",
          connectionTitle: "PropFilter Connection",
          toolName: "pf_tool",
          durationMs: 10,
          requestId: "req_pf1",
          properties: { thread_id: "abc123", user_id: "user_1" },
        }),
        createTestLog({
          organizationId: "org_propfilter",
          connectionId: "conn_pf",
          connectionTitle: "PropFilter Connection",
          toolName: "pf_tool",
          durationMs: 20,
          requestId: "req_pf2",
          properties: { thread_id: "abc123", user_id: "user_2" },
        }),
        createTestLog({
          organizationId: "org_propfilter",
          connectionId: "conn_pf",
          connectionTitle: "PropFilter Connection",
          toolName: "pf_tool",
          durationMs: 30,
          requestId: "req_pf3",
          properties: { thread_id: "xyz789", env: "production" },
        }),
        createTestLog({
          organizationId: "org_propfilter",
          connectionId: "conn_pf",
          connectionTitle: "PropFilter Connection",
          toolName: "pf_tool_no_props",
          durationMs: 40,
          requestId: "req_pf4",
          // No properties
        }),
      ]);
    });

    it("should filter by exact property match", async () => {
      const { logs } = await storage.query({
        organizationId: "org_propfilter",
        propertyFilters: {
          properties: { thread_id: "abc123" },
        },
      });
      expect(logs.length).toBe(2);
      expect(logs.every((l) => l.properties?.thread_id === "abc123")).toBe(
        true,
      );
    });

    it("should filter by multiple exact property matches", async () => {
      const { logs } = await storage.query({
        organizationId: "org_propfilter",
        propertyFilters: {
          properties: { thread_id: "abc123", user_id: "user_1" },
        },
      });
      expect(logs.length).toBe(1);
      const log = logs[0];
      expect(log).toBeDefined();
      expect(log!.properties?.thread_id).toBe("abc123");
      expect(log!.properties?.user_id).toBe("user_1");
    });

    it("should filter by property key existence", async () => {
      const { logs } = await storage.query({
        organizationId: "org_propfilter",
        propertyFilters: {
          propertyKeys: ["env"],
        },
      });
      expect(logs.length).toBe(1);
      const log = logs[0];
      expect(log).toBeDefined();
      expect(log!.properties?.env).toBe("production");
    });

    it("should filter by property pattern (contains)", async () => {
      const { logs } = await storage.query({
        organizationId: "org_propfilter",
        propertyFilters: {
          propertyPatterns: { thread_id: "%abc%" },
        },
      });
      expect(logs.length).toBe(2);
      expect(logs.every((l) => l.properties?.thread_id?.includes("abc"))).toBe(
        true,
      );
    });

    it("should combine property filters with other filters", async () => {
      // Add an error log with properties
      await storage.log(
        createTestLog({
          organizationId: "org_propfilter",
          connectionId: "conn_pf",
          connectionTitle: "PropFilter Connection",
          toolName: "pf_error_tool",
          isError: true,
          errorMessage: "Test error",
          durationMs: 50,
          requestId: "req_pf_err",
          properties: { thread_id: "abc123", error_type: "validation" },
        }),
      );

      const { logs } = await storage.query({
        organizationId: "org_propfilter",
        isError: true,
        propertyFilters: {
          properties: { thread_id: "abc123" },
        },
      });
      expect(logs.length).toBe(1);
      const log = logs[0];
      expect(log).toBeDefined();
      expect(log!.isError).toBe(true);
      expect(log!.properties?.thread_id).toBe("abc123");
    });

    it("should return correct total with property filters", async () => {
      const { logs, total } = await storage.query({
        organizationId: "org_propfilter",
        propertyFilters: {
          properties: { thread_id: "abc123" },
        },
        limit: 1,
      });
      // Should have at least 2 (could be 3 with the error log added above)
      expect(total).toBeGreaterThanOrEqual(2);
      expect(logs.length).toBe(1);
    });
  });

  describe("getStats", () => {
    beforeAll(async () => {
      // Seed test data for stats
      await storage.logBatch([
        createTestLog({
          organizationId: "org_stats",
          connectionId: "conn_stats",
          connectionTitle: "Stats Connection",
          toolName: "stats_tool",
          durationMs: 100,
          requestId: "req_s1",
        }),
        createTestLog({
          organizationId: "org_stats",
          connectionId: "conn_stats",
          connectionTitle: "Stats Connection",
          toolName: "stats_tool",
          durationMs: 200,
          requestId: "req_s2",
        }),
        createTestLog({
          organizationId: "org_stats",
          connectionId: "conn_stats",
          connectionTitle: "Stats Connection",
          toolName: "stats_tool",
          isError: true,
          errorMessage: "Error",
          durationMs: 300,
          requestId: "req_s3",
        }),
      ]);
    });

    it("should calculate correct stats", async () => {
      const stats = await storage.getStats({ organizationId: "org_stats" });
      expect(stats.totalCalls).toBe(3);
      expect(stats.errorRate).toBeCloseTo(1 / 3, 2);
      expect(stats.avgDurationMs).toBe(200); // (100 + 200 + 300) / 3
    });
  });
});
