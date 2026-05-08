import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Hono } from "hono";
import type { MeshContext } from "../../core/mesh-context";
import { CredentialVault } from "../../encryption/credential-vault";
import {
  createTestDatabase,
  closeTestDatabase,
  type TestDatabase,
} from "../../database/test-db";
import {
  createTestSchema,
  seedCommonTestFixtures,
} from "../../storage/test-helpers";
import { createDownstreamTokenRoutes } from "./downstream-token";

describe("Downstream Token Routes", () => {
  let database: TestDatabase;
  let app: Hono<{ Variables: { meshContext: MeshContext } }>;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);

    // Create test connection for FK constraint
    const { sql } = await import("kysely");
    const now = new Date().toISOString();
    await sql`
      INSERT INTO connections (id, organization_id, created_by, title, connection_type, connection_url, status, created_at, updated_at)
      VALUES ('conn_1', 'org_test', 'user_test', 'Test', 'HTTP', 'https://test.com', 'active', ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);

    const vault = new CredentialVault(CredentialVault.generateKey());

    const ctx = {
      db: database.db,
      vault,
      organization: { id: "org_1" },
      auth: { user: { id: "user_1" } },
      storage: {
        connections: {
          findById: mock(async () => ({ id: "conn_1" })),
        },
      },
    } as unknown as MeshContext;

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("meshContext", ctx);
      await next();
    });
    app.route("/", createDownstreamTokenRoutes());
  });

  afterEach(async () => {
    await closeTestDatabase(database);
    mock.restore();
  });

  it("rejects invalid tokenEndpoint", async () => {
    const res = await app.request("/connections/conn_1/oauth-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accessToken: "at",
        tokenEndpoint: "not-a-url",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("tokenEndpoint must be a valid URL");
  });

  it("rejects non-http(s) tokenEndpoint", async () => {
    const res = await app.request("/connections/conn_1/oauth-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accessToken: "at",
        tokenEndpoint: "javascript:alert(1)",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("tokenEndpoint must be an http(s) URL");
  });

  it("accepts http(s) tokenEndpoint", async () => {
    const res = await app.request("/connections/conn_1/oauth-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accessToken: "at",
        refreshToken: "rt",
        expiresIn: 3600,
        tokenEndpoint: "https://example.com/token",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; expiresAt: string };
    expect(body.success).toBe(true);
    expect(body.expiresAt).toBeTruthy();
  });
});
