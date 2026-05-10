import { describe, expect, it } from "bun:test";
import {
  reshapeSimpleMode,
  inferAutomationTier,
  __testing,
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

  it("returns input unchanged when already in the new `{ tiers: ... }` shape", () => {
    const already = {
      tiers: {
        fast: { keyId: "k1", modelId: "haiku" },
        smart: null,
        thinking: null,
        image: null,
        web_research: null,
      },
    };
    const result = reshapeSimpleMode(already);
    expect(result).toBe(already);
  });

  it("treats a partially-populated `tiers` object as already reshaped", () => {
    // Only `smart` key is present, but the presence of `tiers` is enough.
    const already = {
      tiers: {
        smart: { keyId: "k", modelId: "m" },
        fast: null,
        thinking: null,
        image: null,
        web_research: null,
      },
    };
    const result = reshapeSimpleMode(already);
    expect(result).toBe(already);
  });
});

describe("inferAutomationTier", () => {
  it("keeps existing tier when present", () => {
    const result = inferAutomationTier({
      tier: "fast",
      credentialId: "k",
      thinking: { id: "m" },
    });
    expect(result).toBe("fast");
  });

  it("returns 'thinking' when the legacy model declared reasoning capability", () => {
    const result = inferAutomationTier({
      credentialId: "k",
      thinking: { id: "o3", capabilities: { reasoning: true } },
    });
    expect(result).toBe("thinking");
  });

  it("returns 'smart' as the default when no signal is available", () => {
    const result = inferAutomationTier({
      credentialId: "k",
      thinking: { id: "sonnet" },
    });
    expect(result).toBe("smart");
  });

  it("returns 'smart' for an empty/unknown legacy shape", () => {
    expect(inferAutomationTier({})).toBe("smart");
  });
});

describe("idempotency helpers", () => {
  it("isAlreadyReshapedSimpleMode detects new shape", () => {
    expect(
      __testing.isAlreadyReshapedSimpleMode({
        tiers: { fast: null, smart: null },
      }),
    ).toBe(true);
    expect(__testing.isAlreadyReshapedSimpleMode({ tiers: {} })).toBe(false);
    expect(__testing.isAlreadyReshapedSimpleMode(null)).toBe(false);
    expect(
      __testing.isAlreadyReshapedSimpleMode({
        enabled: true,
        chat: { fast: null },
      }),
    ).toBe(false);
  });

  it("isAlreadyReshapedAutomationModels detects new shape", () => {
    expect(__testing.isAlreadyReshapedAutomationModels({ tier: "fast" })).toBe(
      true,
    );
    expect(__testing.isAlreadyReshapedAutomationModels({ tier: "smart" })).toBe(
      true,
    );
    expect(
      __testing.isAlreadyReshapedAutomationModels({
        tier: "thinking",
      }),
    ).toBe(true);
    // Has legacy keys alongside `tier` — not yet reshaped.
    expect(
      __testing.isAlreadyReshapedAutomationModels({
        tier: "smart",
        credentialId: "k",
      }),
    ).toBe(false);
    expect(
      __testing.isAlreadyReshapedAutomationModels({
        tier: "smart",
        thinking: { id: "m" },
      }),
    ).toBe(false);
    expect(__testing.isAlreadyReshapedAutomationModels({})).toBe(false);
  });
});
