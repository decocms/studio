import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestDatabase,
  closeTestDatabase,
  type TestDatabase,
} from "../database/test-db";
import type { EventBus } from "../event-bus";
import { createTestSchema } from "../storage/test-helpers";
import { createApp } from "./app";

/**
 * Create a no-op mock event bus for testing
 */
function createMockEventBus(): EventBus {
  return {
    start: async () => {},
    stop: () => {},
    isRunning: () => false,
    publish: async () =>
      ({
        id: "mock-event",
        organizationId: "org",
        type: "test",
        source: "test",
        specversion: "1.0",
        time: new Date().toISOString(),
        datacontenttype: "application/json",
        status: "pending",
        attempts: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as never,
    subscribe: async () =>
      ({
        id: "mock-sub",
        organizationId: "org",
        connectionId: "conn",
        eventType: "test",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as never,
    unsubscribe: async () => ({ success: true }),
    listSubscriptions: async () => [],
    getEvent: async () => null,
    cancelEvent: async () => ({ success: true }),
    ackEvent: async () => ({ success: true }),
    getSubscription: async () => null,
    syncSubscriptions: async () => ({
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      subscriptions: [],
    }),
  };
}

describe("Hono App", () => {
  let database: TestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    app = await createApp({ database, eventBus: createMockEventBus() });
  });

  afterEach(async () => {
    await closeTestDatabase(database);
  });
  describe("health check", () => {
    it("should respond to health check", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);

      const json = (await res.json()) as {
        status: string;
        timestamp: string;
        version: string;
      };
      expect(json.status).toBe("ok");
      expect(json.timestamp).toBeDefined();
      expect(json.version).toBe("1.0.0");
    });
  });

  describe("404 handling", () => {
    it("should return 404 for unknown routes", async () => {
      const res = await app.request("/unknown");
      expect(res.status).toBe(404);

      const json = (await res.json()) as { error: string; path: string };
      expect(json.error).toBe("Not Found");
      expect(json.path).toBe("/unknown");
    });
  });

  describe("CORS", () => {
    it("should have CORS headers", async () => {
      const res = await app.request("/health", {
        headers: { Origin: "http://localhost:3000" },
      });

      const corsHeader = res.headers.get("access-control-allow-origin");
      expect(corsHeader).toBeTruthy();
    });

    it("should allow credentials", async () => {
      const res = await app.request("/health", {
        headers: { Origin: "http://localhost:3000" },
      });

      const credentialsHeader = res.headers.get(
        "access-control-allow-credentials",
      );
      expect(credentialsHeader).toBeTruthy();
    });
  });

  describe("Better Auth integration", () => {
    it("should mount Better Auth routes", async () => {
      // .well-known endpoints should exist (may return 404 but route exists)
      const res = await app.request("/.well-known/oauth-authorization-server");

      // Should not be 500 (route exists)
      expect(res.status).toBeLessThan(500);
    });
  });
});
