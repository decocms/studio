// CredentialVault requires a valid 32-byte base64 ENCRYPTION_KEY.
// Must be set before any import triggers getSettings(), which freezes
// the settings singleton on first access. (Same pattern as
// apps/api/src/api/routes/public-config.test.ts.)
process.env.ENCRYPTION_KEY ??= Buffer.from("0".repeat(32)).toString("base64");

import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { decode } from "@nats-io/jwt";
import type { StudioContext } from "@/core/studio-context";
import { getSettings, setGlobalSettings } from "@/settings";
import type { Settings } from "@/settings";
import {
  buildNatsOperatorArtifacts,
  generateNatsOperatorKeys,
} from "@/services/nats-operator-config";
import {
  allowedConnectionTypesForUrl,
  createLinkSessionRoutes,
} from "./session";

// The session route reads getSettings(), so driving the real global settings
// singleton keeps the route's view consistent without mocks — this stays a pure
// unit test (no DB, no network, no module mocking).
const baseSettings = getSettings();

function withSettings(overrides: Partial<Settings>): void {
  setGlobalSettings({ ...baseSettings, ...overrides } as Settings);
}

function createApp(userId: string | null) {
  const app = new Hono<{ Variables: { studioContext: StudioContext } }>();
  app.use("*", async (c, next) => {
    c.set("studioContext", {
      auth: userId ? { user: { id: userId } } : undefined,
    } as unknown as StudioContext);
    await next();
  });
  app.route("/", createLinkSessionRoutes());
  return app;
}

describe("POST /api/links/session", () => {
  afterEach(() => {
    setGlobalSettings(baseSettings);
  });

  it("returns 401 when unauthenticated", async () => {
    const app = createApp(null);
    const res = await app.request("/links/session", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("local mode (operator NATS): mints real per-user scoped creds (same path as prod)", async () => {
    // Local dev now runs NATS in operator mode and supplies the same account
    // JWT + signing key as prod, so it takes the real mint path — no bypass.
    const keys = generateNatsOperatorKeys();
    const artifacts = await buildNatsOperatorArtifacts(keys);

    withSettings({
      localMode: true,
      // Dev hands the daemon a TCP URL (Node nats transport speaks raw TCP).
      natsPublicUrl: "nats://127.0.0.1:14222",
      natsTunnelPublicEnabled: true,
      natsTunnelSessionTtlSeconds: 300,
      natsAccountJwt: artifacts.tunnelAccountJwt,
      natsAccountSigningKey: artifacts.tunnelSigningSeed,
    });

    const app = createApp("local-user");
    const res = await app.request("/links/session", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connection.urls).toEqual(["nats://127.0.0.1:14222"]);
    // Real minted creds are returned (not anonymous).
    expect(typeof body.connection.credentials).toBe("string");
    expect(body.connection.credentials).toContain(
      "-----BEGIN NATS USER JWT-----",
    );
    expect(typeof body.tunnelHostname).toBe("string");
    expect(typeof body.expiresAt).toBe("string");

    // A TCP public URL grants STANDARD (so the dev daemon's TCP connect works).
    const creds: string = body.connection.credentials;
    const jwtLine = creds
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.split(".").length === 3 && !l.startsWith("---"));
    expect(jwtLine).toBeDefined();
    const userClaims = decode(jwtLine!) as {
      nats: { allowed_connection_types?: string[] };
    };
    expect(userClaims.nats.allowed_connection_types).toContain("STANDARD");
  });

  it("non-local mode: returns 503 when production NATS credentials are missing", async () => {
    withSettings({
      localMode: false,
      // Even with the tunnel enabled + a public URL, missing account JWT /
      // signing key must keep the production path unavailable.
      natsTunnelPublicEnabled: true,
      natsPublicUrl: "nats://public.example:4222",
      natsAccountJwt: undefined,
      natsAccountSigningKey: undefined,
    });

    const app = createApp("user-1");
    const res = await app.request("/links/session", { method: "POST" });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "link session unavailable" });
  });
});

describe("allowedConnectionTypesForUrl", () => {
  it("grants WEBSOCKET only for ws/wss URLs (production)", () => {
    expect(allowedConnectionTypesForUrl("wss://public.example:443")).toEqual([
      "WEBSOCKET",
    ]);
    expect(allowedConnectionTypesForUrl("ws://localhost:8080")).toEqual([
      "WEBSOCKET",
    ]);
  });

  it("grants STANDARD + WEBSOCKET for nats/tls TCP URLs (dev)", () => {
    expect(allowedConnectionTypesForUrl("nats://127.0.0.1:14222")).toEqual([
      "STANDARD",
      "WEBSOCKET",
    ]);
    expect(allowedConnectionTypesForUrl("tls://nats.internal:4222")).toEqual([
      "STANDARD",
      "WEBSOCKET",
    ]);
  });
});
