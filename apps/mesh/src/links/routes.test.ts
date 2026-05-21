import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createInMemoryLinkRegistry } from "./link-registry";
import { registerLinksRoutes } from "./routes";

function buildApp(allowLocalhost = true) {
  const registry = createInMemoryLinkRegistry({ nowSeconds: () => 0 });
  const app = new Hono();
  registerLinksRoutes(app, {
    linkRegistry: registry,
    getAuthenticatedUserSub: (c) => c.req.header("x-test-sub") ?? null,
    allowLocalhostLinks: allowLocalhost,
  });
  return { app, registry };
}

describe("POST /api/links", () => {
  it("rejects when no session", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/links", {
      method: "POST",
      body: JSON.stringify({
        machineId: "m1",
        cliVersion: "1.0.0",
        protocolVersion: 1,
        capabilities: ["claude-code"],
        tunnelUrl: "http://localhost:5174",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("registers and returns linkSecret in dev (localhost)", async () => {
    const { app, registry } = buildApp(true);
    const res = await app.request("/api/links", {
      method: "POST",
      body: JSON.stringify({
        machineId: "m1",
        cliVersion: "1.0.0",
        protocolVersion: 1,
        capabilities: ["claude-code"],
        tunnelUrl: "http://localhost:5174",
      }),
      headers: {
        "content-type": "application/json",
        "x-test-sub": "user-a",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { linkSecret: string };
    expect(typeof body.linkSecret).toBe("string");
    expect(body.linkSecret.length).toBeGreaterThan(20);
    const stored = await registry.get("user-a");
    expect(stored).not.toBeNull();
    // HMAC signing requires symmetric key material — the stored value is the
    // RAW secret, identical to what the body returned (see schemas.ts JSDoc).
    expect(stored?.linkSecret).toBe(body.linkSecret);
    expect(stored?.tunnelUrl).toBe("http://localhost:5174");
  });

  it("rejects below MIN_SUPPORTED_LINK_PROTOCOL", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/links", {
      method: "POST",
      body: JSON.stringify({
        machineId: "m1",
        cliVersion: "1.0.0",
        protocolVersion: 0,
        capabilities: ["claude-code"],
        tunnelUrl: "http://localhost:5174",
      }),
      headers: {
        "content-type": "application/json",
        "x-test-sub": "user-a",
      },
    });
    expect(res.status).toBe(426);
  });

  it("rejects 409 when another machineId is active", async () => {
    const { app } = buildApp();
    const first = await app.request("/api/links", {
      method: "POST",
      body: JSON.stringify({
        machineId: "m1",
        cliVersion: "1.0.0",
        protocolVersion: 1,
        capabilities: ["claude-code"],
        tunnelUrl: "http://localhost:5174",
      }),
      headers: {
        "content-type": "application/json",
        "x-test-sub": "user-a",
      },
    });
    expect(first.status).toBe(200);
    const res = await app.request("/api/links", {
      method: "POST",
      body: JSON.stringify({
        machineId: "m2",
        cliVersion: "1.0.0",
        protocolVersion: 1,
        capabilities: ["claude-code"],
        tunnelUrl: "http://localhost:5174",
      }),
      headers: {
        "content-type": "application/json",
        "x-test-sub": "user-a",
      },
    });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/links/heartbeat", () => {
  it("returns 204 on valid linkSecret", async () => {
    const { app } = buildApp(true);
    const reg = await app.request("/api/links", {
      method: "POST",
      body: JSON.stringify({
        machineId: "m1",
        cliVersion: "1.0.0",
        protocolVersion: 1,
        capabilities: ["claude-code"],
        tunnelUrl: "http://localhost:5174",
      }),
      headers: { "content-type": "application/json", "x-test-sub": "user-a" },
    });
    expect(reg.status).toBe(200);
    const { linkSecret } = (await reg.json()) as { linkSecret: string };

    // Heartbeat carries userSub in X-Mesh-User-Sub and the secret in
    // X-Link-Secret (not Authorization: Bearer) so it never enters Better
    // Auth's API-key validator on the cluster.
    const hb = await app.request("/api/links/heartbeat", {
      method: "POST",
      headers: {
        "x-link-secret": linkSecret,
        "x-mesh-user-sub": "user-a",
      },
    });
    expect(hb.status).toBe(204);
  });

  it("returns 401 on wrong linkSecret", async () => {
    const { app } = buildApp(true);
    await app.request("/api/links", {
      method: "POST",
      body: JSON.stringify({
        machineId: "m1",
        cliVersion: "1.0.0",
        protocolVersion: 1,
        capabilities: ["claude-code"],
        tunnelUrl: "http://localhost:5174",
      }),
      headers: { "content-type": "application/json", "x-test-sub": "user-a" },
    });

    const hb = await app.request("/api/links/heartbeat", {
      method: "POST",
      headers: {
        "x-link-secret": "not-the-real-secret",
        "x-mesh-user-sub": "user-a",
      },
    });
    expect(hb.status).toBe(401);
  });
});

describe("GET /api/links/me", () => {
  it("returns offline when no link", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/links/me", {
      headers: { "x-test-sub": "user-a" },
    });
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("offline");
  });
});
