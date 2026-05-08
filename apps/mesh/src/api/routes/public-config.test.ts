// CredentialVault requires a valid 32-byte base64 ENCRYPTION_KEY.
// Must be set before any import triggers getSettings(), which freezes
// the settings singleton on first access. (Same pattern as
// apps/mesh/src/api/routes/oauth-proxy.e2e.test.ts.)
process.env.ENCRYPTION_KEY ??= Buffer.from("0".repeat(32)).toString("base64");

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import publicConfigRoutes from "./public-config";

describe("GET /api/config", () => {
  let originalKey: string | undefined;
  let originalHost: string | undefined;

  beforeEach(() => {
    originalKey = process.env.POSTHOG_KEY;
    originalHost = process.env.POSTHOG_HOST;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.POSTHOG_KEY;
    else process.env.POSTHOG_KEY = originalKey;
    if (originalHost === undefined) delete process.env.POSTHOG_HOST;
    else process.env.POSTHOG_HOST = originalHost;
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
      host: "https://us.i.posthog.com",
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
});
