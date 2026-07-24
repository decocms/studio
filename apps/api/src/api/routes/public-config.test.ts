// CredentialVault requires a valid 32-byte base64 ENCRYPTION_KEY.
// Must be set before any import triggers getSettings(), which freezes
// the settings singleton on first access. (Same pattern as
// the OAuth proxy e2e coverage.)
process.env.ENCRYPTION_KEY ??= Buffer.from("0".repeat(32)).toString("base64");

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getSettings, setGlobalSettings } from "@/settings";
import publicConfigRoutes from "./public-config";

describe("GET /api/config", () => {
  let originalKey: string | undefined;
  let originalHost: string | undefined;
  let originalMapsKey: string | undefined;
  const originalSettings = getSettings();

  beforeEach(() => {
    originalKey = process.env.POSTHOG_KEY;
    originalHost = process.env.POSTHOG_HOST;
    originalMapsKey = process.env.GOOGLE_MAPS_API_KEY;
    setGlobalSettings(originalSettings);
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.POSTHOG_KEY;
    else process.env.POSTHOG_KEY = originalKey;
    if (originalHost === undefined) delete process.env.POSTHOG_HOST;
    else process.env.POSTHOG_HOST = originalHost;
    if (originalMapsKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = originalMapsKey;
    setGlobalSettings(originalSettings);
  });

  it("sends Cache-Control: no-store so version-drift polling isn't defeated by caching", async () => {
    const res = await publicConfigRoutes.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns posthog config when POSTHOG_KEY is set", async () => {
    process.env.POSTHOG_KEY = "phc_test_key";
    delete process.env.POSTHOG_HOST;

    const res = await publicConfigRoutes.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.config.posthog).toEqual({
      key: "phc_test_key",
      // First-party reverse proxy default (see public-config.ts).
      host: "https://ph.studio.decocms.com",
    });
  });

  it("returns posthog: null when POSTHOG_KEY is unset", async () => {
    delete process.env.POSTHOG_KEY;

    const res = await publicConfigRoutes.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.posthog).toBeNull();
  });

  it("respects POSTHOG_HOST when both are set", async () => {
    process.env.POSTHOG_KEY = "phc_test_key";
    process.env.POSTHOG_HOST = "https://eu.i.posthog.com";

    const res = await publicConfigRoutes.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.posthog).toEqual({
      key: "phc_test_key",
      host: "https://eu.i.posthog.com",
    });
  });

  it("returns googleMapsApiKey when GOOGLE_MAPS_API_KEY is set", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "  maps_test_key  ";

    const res = await publicConfigRoutes.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Trimmed before exposing.
    expect(body.config.googleMapsApiKey).toBe("maps_test_key");
  });

  it("returns googleMapsApiKey: null when GOOGLE_MAPS_API_KEY is unset", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const res = await publicConfigRoutes.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.googleMapsApiKey).toBeNull();
  });

  it("reports agent-sandbox runtime availability when agent-sandbox provider is configured", async () => {
    setGlobalSettings({
      ...originalSettings,
      localMode: false,
      sandboxProviderKind: "agent-sandbox",
    });

    const res = await publicConfigRoutes.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.runtime).toEqual({ agentSandbox: true });
  });

  it("does not report agent-sandbox runtime availability for user-desktop provider", async () => {
    setGlobalSettings({
      ...originalSettings,
      localMode: false,
      sandboxProviderKind: "user-desktop",
    });

    const res = await publicConfigRoutes.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.runtime).toEqual({ agentSandbox: false });
  });

  it("does not report agent-sandbox in local mode even with the agent-sandbox provider", async () => {
    setGlobalSettings({
      ...originalSettings,
      localMode: true,
      sandboxProviderKind: "agent-sandbox",
    });

    const res = await publicConfigRoutes.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    // No cloud agent-sandbox cluster exists locally → cloud Decopilot unavailable.
    expect(body.config.runtime).toEqual({ agentSandbox: false });
  });
});
