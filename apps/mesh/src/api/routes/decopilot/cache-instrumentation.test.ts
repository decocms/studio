import { describe, expect, test } from "bun:test";
import {
  addCacheStep,
  emptyCacheAccumulator,
  OPENROUTER_CACHE_PROVIDER_OPTIONS,
  withCachedToolPrefix,
} from "./cache-instrumentation";

describe("OPENROUTER_CACHE_PROVIDER_OPTIONS", () => {
  test("is the canonical ephemeral 5m shape", () => {
    expect(OPENROUTER_CACHE_PROVIDER_OPTIONS).toEqual({
      openrouter: { cache_control: { type: "ephemeral", ttl: "5m" } },
    });
  });
});

describe("withCachedToolPrefix", () => {
  test("sorts by name and marks only the last tool", () => {
    const tools = {
      zeta: { description: "z", inputSchema: {} as never } as never,
      alpha: { description: "a", inputSchema: {} as never } as never,
      mid: { description: "m", inputSchema: {} as never } as never,
    } as Record<string, unknown> as Parameters<typeof withCachedToolPrefix>[0];
    const out = withCachedToolPrefix(tools);
    const keys = Object.keys(out);
    expect(keys).toEqual(["alpha", "mid", "zeta"]);
    expect(
      (out.alpha as { providerOptions?: unknown }).providerOptions,
    ).toBeUndefined();
    expect(
      (out.mid as { providerOptions?: unknown }).providerOptions,
    ).toBeUndefined();
    expect(
      (
        out.zeta as {
          providerOptions?: { anthropic?: { cacheControl?: unknown } };
        }
      ).providerOptions?.anthropic?.cacheControl,
    ).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  test("empty toolset returns empty object (no marker to attach)", () => {
    const out = withCachedToolPrefix(
      {} as Parameters<typeof withCachedToolPrefix>[0],
    );
    expect(Object.keys(out)).toEqual([]);
  });

  test("preserves existing providerOptions on the marked tool", () => {
    const tools = {
      only: {
        description: "x",
        inputSchema: {} as never,
        providerOptions: { openai: { someFlag: true } },
      } as never,
    } as Parameters<typeof withCachedToolPrefix>[0];
    const out = withCachedToolPrefix(tools);
    const po = (
      out.only as unknown as {
        providerOptions: { openai: unknown; anthropic: unknown };
      }
    ).providerOptions;
    expect(po.openai).toEqual({ someFlag: true });
    expect(po.anthropic).toEqual({
      cacheControl: { type: "ephemeral", ttl: "5m" },
    });
  });
});

describe("CacheAccumulator", () => {
  test("emptyCacheAccumulator returns zeroed state", () => {
    const acc = emptyCacheAccumulator();
    expect(acc).toEqual({
      read: 0,
      write: 0,
      input: 0,
      output: 0,
      cost: 0,
      uncachedEquivalent: 0,
      pricingUnknown: false,
    });
  });

  test("addCacheStep accumulates read/write/input/output and cost", () => {
    const acc = emptyCacheAccumulator();
    addCacheStep(
      acc,
      {
        inputTokens: 10_000,
        outputTokens: 100,
        inputTokenDetails: {
          cacheReadTokens: 9_000,
          cacheWriteTokens: 500,
        },
      },
      "anthropic",
      "claude-haiku-4-5",
    );
    expect(acc.read).toBe(9_000);
    expect(acc.write).toBe(500);
    expect(acc.input).toBe(10_000);
    expect(acc.output).toBe(100);
    expect(acc.cost).toBeGreaterThan(0);
    expect(acc.uncachedEquivalent).toBeGreaterThan(acc.cost);
    expect(acc.pricingUnknown).toBe(false);
  });

  test("addCacheStep flags pricingUnknown for unpriced models", () => {
    const acc = emptyCacheAccumulator();
    addCacheStep(
      acc,
      {
        inputTokens: 1_000,
        outputTokens: 100,
      },
      "anthropic",
      "claude-unicorn-99",
    );
    expect(acc.pricingUnknown).toBe(true);
    expect(acc.cost).toBe(0);
  });

  test("addCacheStep with undefined usage is a no-op", () => {
    const acc = emptyCacheAccumulator();
    addCacheStep(acc, undefined, "anthropic", "claude-haiku-4-5");
    expect(acc).toEqual(emptyCacheAccumulator());
  });

  test("multiple steps accumulate", () => {
    const acc = emptyCacheAccumulator();
    addCacheStep(
      acc,
      {
        inputTokens: 1_000,
        outputTokens: 50,
        inputTokenDetails: { cacheReadTokens: 800 },
      },
      "anthropic",
      "claude-haiku-4-5",
    );
    addCacheStep(
      acc,
      {
        inputTokens: 500,
        outputTokens: 25,
        inputTokenDetails: { cacheReadTokens: 400 },
      },
      "anthropic",
      "claude-haiku-4-5",
    );
    expect(acc.read).toBe(1_200);
    expect(acc.input).toBe(1_500);
    expect(acc.output).toBe(75);
  });
});
