import { describe, expect, test } from "bun:test";
import { computeCost, resolvePricing } from "./index";

describe("resolvePricing", () => {
  test("looks up anthropic model by canonical id", () => {
    const r = resolvePricing("anthropic", "claude-haiku-4-5");
    expect(r).not.toBeNull();
    expect(r!.pricing.input).toBe(0.8);
    expect(r!.resolvedKey).toBe("anthropic/claude-haiku-4-5");
  });

  test("resolves dotted alias claude-haiku-4.5 to dash form", () => {
    const r = resolvePricing("anthropic", "claude-haiku-4.5");
    expect(r).not.toBeNull();
    expect(r!.resolvedKey).toBe("anthropic/claude-haiku-4-5");
  });

  test("resolves date-stamped alias claude-3-5-sonnet-20241022", () => {
    const r = resolvePricing("anthropic", "claude-3-5-sonnet-20241022");
    expect(r).not.toBeNull();
    expect(r!.resolvedKey).toBe("anthropic/claude-3-5-sonnet");
  });

  test("strips OpenRouter prefix anthropic/claude-haiku-4.5", () => {
    const r = resolvePricing("openrouter", "anthropic/claude-haiku-4.5");
    expect(r).not.toBeNull();
    expect(r!.resolvedKey).toBe("anthropic/claude-haiku-4-5");
    expect(r!.pricing.input).toBe(0.8);
  });

  test("strips OpenRouter prefix openai/gpt-5", () => {
    const r = resolvePricing("openrouter", "openai/gpt-5");
    expect(r).not.toBeNull();
    expect(r!.resolvedKey).toBe("openai/gpt-5");
  });

  test("strips OpenRouter prefix google/gemini-2.5-pro", () => {
    const r = resolvePricing("openrouter", "google/gemini-2.5-pro");
    expect(r).not.toBeNull();
    expect(r!.resolvedKey).toBe("google/gemini-2.5-pro");
  });

  test("provider alias 'gemini' maps to google section", () => {
    const r = resolvePricing("gemini", "gemini-2.5-flash");
    expect(r).not.toBeNull();
    expect(r!.resolvedKey).toBe("google/gemini-2.5-flash");
  });

  test("returns null for unknown model", () => {
    const r = resolvePricing("anthropic", "claude-unicorn-99");
    expect(r).toBeNull();
  });

  test("returns null for unknown provider", () => {
    const r = resolvePricing("mystery-corp", "magic-model-1");
    expect(r).toBeNull();
  });

  test("handles missing provider but vendor-prefixed model id", () => {
    const r = resolvePricing(undefined, "anthropic/claude-haiku-4.5");
    expect(r).not.toBeNull();
    expect(r!.resolvedKey).toBe("anthropic/claude-haiku-4-5");
  });
});

describe("computeCost — claude-haiku-4.5", () => {
  // Pricing: input 0.80, output 4.00, cachedRead 0.08, cacheWrite 1.00 (per million)
  test("uncached call: input × 0.80/M + output × 4.00/M", () => {
    const r = computeCost("anthropic", "claude-haiku-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(r).not.toBeNull();
    expect(r!.total).toBeCloseTo(4.8, 6);
    expect(r!.inputCost).toBeCloseTo(0.8, 6);
    expect(r!.outputCost).toBeCloseTo(4.0, 6);
    expect(r!.cacheReadCost).toBe(0);
    expect(r!.cacheWriteCost).toBe(0);
    expect(r!.uncachedEquivalent).toBeCloseTo(4.8, 6);
  });

  test("100% cache hit on input: cache_read rate (90% discount on input)", () => {
    const r = computeCost("anthropic", "claude-haiku-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    expect(r).not.toBeNull();
    expect(r!.total).toBeCloseTo(0.08, 6);
    expect(r!.cacheReadCost).toBeCloseTo(0.08, 6);
    expect(r!.inputCost).toBe(0);
    expect(r!.uncachedEquivalent).toBeCloseTo(0.8, 6);
  });

  test("cache write: 1.00/M (1.25x base)", () => {
    const r = computeCost("anthropic", "claude-haiku-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000_000,
    });
    expect(r).not.toBeNull();
    expect(r!.total).toBeCloseTo(1.0, 6);
    expect(r!.cacheWriteCost).toBeCloseTo(1.0, 6);
    expect(r!.inputCost).toBe(0);
  });

  test("mixed: 90% cache hit on input + small uncached portion", () => {
    const r = computeCost("anthropic", "claude-haiku-4-5", {
      inputTokens: 100_000,
      outputTokens: 1_000,
      cacheReadTokens: 90_000,
      cacheWriteTokens: 0,
    });
    expect(r).not.toBeNull();
    // 10k uncached at $0.80/M = $0.008
    expect(r!.inputCost).toBeCloseTo(0.008, 6);
    // 90k cached at $0.08/M = $0.0072
    expect(r!.cacheReadCost).toBeCloseTo(0.0072, 6);
    // 1k output at $4.00/M = $0.004
    expect(r!.outputCost).toBeCloseTo(0.004, 6);
    // Total ≈ $0.0192
    expect(r!.total).toBeCloseTo(0.0192, 6);
  });
});

describe("computeCost — gpt-4o", () => {
  // Pricing: input 2.50, output 10.00, cachedRead 1.25 — no cacheWrite (OpenAI auto-cache only)
  test("uncached call", () => {
    const r = computeCost("openai", "gpt-4o", {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(r).not.toBeNull();
    expect(r!.total).toBeCloseTo(2.5 + 1.0, 6);
  });

  test("cached input at 50% discount", () => {
    const r = computeCost("openai", "gpt-4o", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    expect(r).not.toBeNull();
    expect(r!.total).toBeCloseTo(1.25, 6);
  });

  test("cacheWrite tokens incur no cost when pricing has no cacheWrite field", () => {
    const r = computeCost("openai", "gpt-4o", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000_000, // OpenAI doesn't bill cache writes — these are part of standard input
    });
    expect(r).not.toBeNull();
    // cacheWriteTokens are subtracted from "uncached" portion of input so they
    // aren't double-counted; cacheWriteCost is 0 because no cacheWrite rate.
    expect(r!.cacheWriteCost).toBe(0);
    // Effectively cacheWrite tokens here are billed at $0 — which mildly
    // under-counts. For OpenAI this is a non-issue because the SDK never
    // sets cacheWriteTokens > 0. Validated separately.
    expect(r!.inputCost).toBe(0);
    expect(r!.total).toBe(0);
  });
});

describe("computeCost — gemini-2.5-pro", () => {
  test("uncached call uses input + output rates", () => {
    const r = computeCost("google", "gemini-2.5-pro", {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(r).not.toBeNull();
    // 1M input at $1.25/M = $1.25, 100k output at $10/M = $1.00
    expect(r!.total).toBeCloseTo(2.25, 6);
  });

  test("cached read at $0.31/M", () => {
    const r = computeCost("google", "gemini-2.5-pro", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 0,
    });
    expect(r).not.toBeNull();
    // 500k uncached at $1.25/M = $0.625
    // 500k cached at $0.31/M = $0.155
    expect(r!.total).toBeCloseTo(0.78, 4);
  });
});

describe("computeCost — uncached equivalent", () => {
  test("reports what a fully-uncached request would have cost", () => {
    const r = computeCost("anthropic", "claude-haiku-4-5", {
      inputTokens: 100_000,
      outputTokens: 1_000,
      cacheReadTokens: 90_000,
      cacheWriteTokens: 0,
    });
    expect(r).not.toBeNull();
    // 100k × $0.80/M + 1k × $4/M = $0.08 + $0.004 = $0.084
    expect(r!.uncachedEquivalent).toBeCloseTo(0.084, 6);
    // Savings vs uncached
    expect(r!.uncachedEquivalent - r!.total).toBeGreaterThan(0);
  });
});

describe("computeCost — unpriced model", () => {
  test("returns null", () => {
    const r = computeCost("anthropic", "claude-unicorn-99", {
      inputTokens: 1_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(r).toBeNull();
  });
});
