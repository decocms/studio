// CredentialVault requires a valid 32-byte base64 ENCRYPTION_KEY.
// Must be set before any import triggers getSettings(), which freezes
// the settings singleton on first access.
process.env.ENCRYPTION_KEY ??= Buffer.from("0".repeat(32)).toString("base64");

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import type { MeshDatabase } from "../database";
import type { EventBus } from "../event-bus";
import { setGlobalSettings, getSettings } from "../settings";
import { createApp } from "./app";

// If settings were already frozen by a prior test file without
// ENCRYPTION_KEY, re-initialize them now that the env var is set.
if (!getSettings().encryptionKey) {
  setGlobalSettings({
    ...getSettings(),
    encryptionKey: process.env.ENCRYPTION_KEY!,
  });
}

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
  let database: MeshDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    app = await createApp({ database, eventBus: createMockEventBus() });
  });

  afterEach(async () => {
    // Shutdown the app first to stop all background tasks (RunRegistry,
    // expired API key cleanup, monitoring retention, plugin hooks, etc.)
    // before destroying the database. Without this, background tasks race
    // against database teardown and produce "driver has already been
    // destroyed" errors — which can cause timeouts in CI.
    if (app) {
      await app.shutdown();
    }
    if (database) {
      await closeTestPgDatabase(database);
    }
  });
  describe("liveness check", () => {
    it("should respond to liveness probe", async () => {
      const res = await app.request("/health/live");
      expect(res.status).toBe(200);

      const json = (await res.json()) as { status: string };
      expect(json.status).toBe("ok");
    });
  });

  describe("readiness check", () => {
    it("should return 200 with per-service status (postgres up, nats down in test)", async () => {
      const res = await app.request("/health/ready");
      expect(res.status).toBe(200);

      const json = (await res.json()) as {
        status: string;
        services: Record<string, { status: string }>;
      };
      expect(json.status).toBe("ready");
      expect(json.services.postgres?.status).toBe("up");
      expect(json.services.nats?.status).toBe("down");
    });

    it("should return 503 when postgres is unreachable", async () => {
      // Simulate an outage by ending the connection pool. createApp wires
      // its own queries through this same pool, so subsequent queries
      // fail with "pool ended" / connection-closed errors — exactly the
      // failure mode the readiness probe is designed to catch.
      if (!database.pool.ended) {
        await database.pool.end();
      }

      const res = await app.request("/health/ready");
      expect(res.status).toBe(503);

      const json = (await res.json()) as {
        status: string;
        services: Record<string, { status: string }>;
      };
      expect(json.status).toBe("not_ready");
      expect(json.services.postgres?.status).toBe("down");
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
      const res = await app.request("/health/live", {
        headers: { Origin: "http://localhost:3000" },
      });

      const corsHeader = res.headers.get("access-control-allow-origin");
      expect(corsHeader).toBeTruthy();
    });

    it("should allow credentials", async () => {
      const res = await app.request("/health/live", {
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
