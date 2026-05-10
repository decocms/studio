import { describe, expect, it } from "bun:test";
import {
  reshapeSimpleMode,
  inferAutomationTier,
} from "./077-tier-only-model-selection";

describe("reshapeSimpleMode", () => {
  it("copies enabled-true config into the flat tiers map", () => {
    const result = reshapeSimpleMode({
      enabled: true,
      chat: {
        fast: { keyId: "k1", modelId: "haiku" },
        smart: { keyId: "k1", modelId: "sonnet" },
        thinking: null,
      },
      image: { keyId: "k2", modelId: "imagen" },
      webResearch: null,
    });
    expect(result.tiers.fast).toEqual({ keyId: "k1", modelId: "haiku" });
    expect(result.tiers.smart).toEqual({ keyId: "k1", modelId: "sonnet" });
    expect(result.tiers.thinking).toBeNull();
    expect(result.tiers.image).toEqual({ keyId: "k2", modelId: "imagen" });
    expect(result.tiers.web_research).toBeNull();
  });

  it("returns empty tiers when enabled is false (runtime resolves on demand)", () => {
    const result = reshapeSimpleMode({
      enabled: false,
      chat: { fast: null, smart: null, thinking: null },
      image: null,
      webResearch: null,
    });
    expect(result.tiers.fast).toBeNull();
    expect(result.tiers.smart).toBeNull();
    expect(result.tiers.thinking).toBeNull();
    expect(result.tiers.image).toBeNull();
    expect(result.tiers.web_research).toBeNull();
  });

  it("returns empty tiers when legacy config is null", () => {
    const result = reshapeSimpleMode(null);
    expect(result.tiers.smart).toBeNull();
    expect(result.tiers.fast).toBeNull();
  });
});

describe("inferAutomationTier", () => {
  it("keeps existing tier when present", () => {
    const result = inferAutomationTier(
      {
        tier: "fast",
        credentialId: "k",
        thinking: { id: "m" },
      },
      [],
    );
    expect(result).toBe("fast");
  });

  it("returns 'thinking' for reasoning capability", () => {
    const result = inferAutomationTier(
      {
        credentialId: "k",
        thinking: { id: "o3", capabilities: { reasoning: true } },
      },
      [{ modelId: "o3", capabilities: ["reasoning", "text"], limits: null }],
    );
    expect(result).toBe("thinking");
  });

  it("returns 'fast' for low-cost models", () => {
    const result = inferAutomationTier(
      { credentialId: "k", thinking: { id: "haiku" } },
      [
        {
          modelId: "haiku",
          capabilities: ["text"],
          limits: null,
          priceUsdPerMillionOutputTokens: 1.5,
        },
        {
          modelId: "sonnet",
          capabilities: ["text"],
          limits: null,
          priceUsdPerMillionOutputTokens: 15,
        },
        {
          modelId: "opus",
          capabilities: ["text"],
          limits: null,
          priceUsdPerMillionOutputTokens: 75,
        },
      ],
    );
    expect(result).toBe("fast");
  });

  it("returns 'smart' for everything else", () => {
    const result = inferAutomationTier(
      { credentialId: "k", thinking: { id: "sonnet" } },
      [
        {
          modelId: "sonnet",
          capabilities: ["text"],
          limits: null,
          priceUsdPerMillionOutputTokens: 15,
        },
      ],
    );
    expect(result).toBe("smart");
  });
});
