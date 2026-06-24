import { afterEach, describe, expect, it } from "bun:test";
import { getSettings, setGlobalSettings } from "../../settings";
import type { Settings } from "../../settings/types";
import { AI_PROVIDER_OAUTH_URL } from "./oauth-url";

const originalSettings = getSettings();

function setBaseUrl(baseUrl: string): void {
  setGlobalSettings({
    ...getSettings(),
    baseUrl,
  } as Settings);
}

afterEach(() => {
  setGlobalSettings(originalSettings);
});

describe("AI_PROVIDER_OAUTH_URL input validation", () => {
  it("accepts localhost subdomain callbacks for local sandbox origins", () => {
    setBaseUrl("http://localhost:5174");

    const result = AI_PROVIDER_OAUTH_URL.inputSchema.safeParse({
      providerId: "openrouter",
      callbackUrl:
        "http://psi-fornacis-c5d1f5b0da4206c1.localhost:5174/oauth/callback/ai-provider",
    });

    expect(result.success).toBe(true);
  });

  it("accepts localhost alias callbacks on a different local dev port", () => {
    setBaseUrl("http://localhost:3000");

    const result = AI_PROVIDER_OAUTH_URL.inputSchema.safeParse({
      providerId: "openrouter",
      callbackUrl:
        "http://psi-fornacis-c5d1f5b0da4206c1.localhost:5174/oauth/callback/ai-provider",
    });

    expect(result.success).toBe(true);
  });

  it("rejects callbacks from unrelated origins", () => {
    setBaseUrl("http://localhost:5174");

    const result = AI_PROVIDER_OAUTH_URL.inputSchema.safeParse({
      providerId: "openrouter",
      callbackUrl: "https://evil.example/oauth/callback/ai-provider",
    });

    expect(result.success).toBe(false);
  });
});
