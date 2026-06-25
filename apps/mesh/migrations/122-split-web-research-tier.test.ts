import { describe, expect, it } from "bun:test";
import { __testing } from "./122-split-web-research-tier";

const { splitWebResearchTier, isAlreadySplit } = __testing;

describe("splitWebResearchTier", () => {
  it("routes a deep-research model into deep_research and leaves web_search null", () => {
    const result = splitWebResearchTier({
      tiers: {
        smart: { keyId: "k1", modelId: "claude-sonnet-4-6" },
        web_research: { keyId: "k2", modelId: "perplexity/deep-research" },
      },
    });
    expect(result?.tiers?.deep_research).toEqual({
      keyId: "k2",
      modelId: "perplexity/deep-research",
    });
    // Quick slot stays null so runtime falls back to the curated quick default
    // rather than launching a slow research job on every quick lookup.
    expect(result?.tiers?.web_search).toBeNull();
    // Legacy key is dropped.
    expect("web_research" in (result?.tiers ?? {})).toBe(false);
    // Other tiers are preserved untouched.
    expect(result?.tiers?.smart).toEqual({
      keyId: "k1",
      modelId: "claude-sonnet-4-6",
    });
  });

  it("routes a non-deep (sonar) model into web_search and leaves deep_research null", () => {
    const result = splitWebResearchTier({
      tiers: {
        web_research: { keyId: "k2", modelId: "perplexity/sonar" },
      },
    });
    expect(result?.tiers?.web_search).toEqual({
      keyId: "k2",
      modelId: "perplexity/sonar",
    });
    expect(result?.tiers?.deep_research).toBeNull();
    expect("web_research" in (result?.tiers ?? {})).toBe(false);
  });

  it("classifies by id substring regardless of punctuation/casing", () => {
    // "Deep-Research" / "deep_research" all normalize to "deepresearch".
    const result = splitWebResearchTier({
      tiers: {
        web_research: { keyId: "k", modelId: "Gemini-2.5-Deep_Research" },
      },
    });
    expect(result?.tiers?.deep_research?.modelId).toBe(
      "Gemini-2.5-Deep_Research",
    );
    expect(result?.tiers?.web_search).toBeNull();
  });

  it("leaves both slots null and drops the legacy key when no web_research slot is set", () => {
    const result = splitWebResearchTier({
      tiers: { smart: { keyId: "k", modelId: "m" }, web_research: null },
    });
    expect(result?.tiers?.web_search).toBeNull();
    expect(result?.tiers?.deep_research).toBeNull();
    expect("web_research" in (result?.tiers ?? {})).toBe(false);
  });

  it("returns null when simpleMode is null", () => {
    expect(splitWebResearchTier(null)).toBeNull();
  });

  it("is idempotent — an already-split config is returned unchanged", () => {
    const already = {
      tiers: {
        web_search: { keyId: "k", modelId: "perplexity/sonar" },
        deep_research: null,
      },
    };
    expect(splitWebResearchTier(already)).toBe(already);
  });
});

describe("isAlreadySplit", () => {
  it("is true when either split key is present", () => {
    expect(isAlreadySplit({ tiers: { web_search: null } })).toBe(true);
    expect(isAlreadySplit({ tiers: { deep_research: null } })).toBe(true);
    expect(
      isAlreadySplit({ tiers: { web_search: { keyId: "k", modelId: "m" } } }),
    ).toBe(true);
  });

  it("is false for a legacy (web_research only) or empty config", () => {
    expect(isAlreadySplit({ tiers: { web_research: null } })).toBe(false);
    expect(isAlreadySplit({ tiers: {} })).toBe(false);
    expect(isAlreadySplit(null)).toBe(false);
    expect(isAlreadySplit({})).toBe(false);
  });
});
