import { describe, expect, it } from "bun:test";
import {
  DEFAULT_LOGO,
  getProviderLogo,
  PROVIDER_LOGOS,
} from "./ai-providers-logos.ts";

describe("getProviderLogo", () => {
  it("returns the providerId's logo when there is a direct match", () => {
    expect(
      getProviderLogo({ providerId: "anthropic", modelId: "claude" }),
    ).toBe(PROVIDER_LOGOS.anthropic);
  });

  it("prefers the modelId's upstream prefix over providerId", () => {
    expect(
      getProviderLogo({ providerId: "openrouter", modelId: "openai/gpt-4o" }),
    ).toBe(PROVIDER_LOGOS.openai);
  });

  it("falls back to providerId when the upstream prefix is unknown", () => {
    expect(getProviderLogo({ providerId: "openai", modelId: "foo/bar" })).toBe(
      PROVIDER_LOGOS.openai,
    );
  });

  it("infers the upstream provider from an unprefixed modelId", () => {
    expect(
      getProviderLogo({ providerId: "litellm", modelId: "claude-3-5-sonnet" }),
    ).toBe(PROVIDER_LOGOS.anthropic);
    expect(
      getProviderLogo({ providerId: "litellm", modelId: "gpt-4o-mini" }),
    ).toBe(PROVIDER_LOGOS.openai);
  });

  it("returns the default logo when nothing matches", () => {
    expect(
      getProviderLogo({
        providerId: "unknown-provider",
        modelId: "mystery-model",
      }),
    ).toBe(DEFAULT_LOGO);
  });
});
