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

  test("deep-merges into existing anthropic.* siblings without dropping them", () => {
    const tools = {
      only: {
        description: "x",
        inputSchema: {} as never,
        providerOptions: {
          anthropic: {
            disableParallelToolUse: true,
            thinking: { budgetTokens: 1024 },
          },
        },
      } as never,
    } as Parameters<typeof withCachedToolPrefix>[0];
    const out = withCachedToolPrefix(tools);
    const po = (
      out.only as unknown as {
        providerOptions: {
          anthropic: {
            disableParallelToolUse?: boolean;
            thinking?: { budgetTokens?: number };
            cacheControl?: unknown;
          };
        };
      }
    ).providerOptions;
    expect(po.anthropic.disableParallelToolUse).toBe(true);
    expect(po.anthropic.thinking).toEqual({ budgetTokens: 1024 });
    expect(po.anthropic.cacheControl).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
  });

  test("overwrites pre-existing anthropic.cacheControl on the marked tool", () => {
    const tools = {
      only: {
        description: "x",
        inputSchema: {} as never,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
        },
      } as never,
    } as Parameters<typeof withCachedToolPrefix>[0];
    const out = withCachedToolPrefix(tools);
    const po = (
      out.only as unknown as {
        providerOptions: { anthropic: { cacheControl: unknown } };
      }
    ).providerOptions;
    expect(po.anthropic.cacheControl).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
  });
});

describe("CacheAccumulator", () => {
  test("emptyCacheAccumulator returns zeroed state", () => {
    expect(emptyCacheAccumulator()).toEqual({
      read: 0,
      write: 0,
      input: 0,
    });
  });

  test("addCacheStep accumulates read/write/input", () => {
    const acc = emptyCacheAccumulator();
    addCacheStep(acc, {
      inputTokens: 10_000,
      inputTokenDetails: {
        cacheReadTokens: 9_000,
        cacheWriteTokens: 500,
      },
    });
    expect(acc).toEqual({
      read: 9_000,
      write: 500,
      input: 10_000,
    });
  });

  test("addCacheStep with undefined usage is a no-op", () => {
    const acc = emptyCacheAccumulator();
    addCacheStep(acc, undefined);
    expect(acc).toEqual(emptyCacheAccumulator());
  });

  test("multiple steps accumulate", () => {
    const acc = emptyCacheAccumulator();
    addCacheStep(acc, {
      inputTokens: 1_000,
      inputTokenDetails: { cacheReadTokens: 800 },
    });
    addCacheStep(acc, {
      inputTokens: 500,
      inputTokenDetails: { cacheReadTokens: 400 },
    });
    expect(acc.read).toBe(1_200);
    expect(acc.input).toBe(1_500);
  });
});
