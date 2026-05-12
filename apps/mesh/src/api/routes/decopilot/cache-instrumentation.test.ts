import { describe, expect, test } from "bun:test";
import {
  addCacheStep,
  cacheHitRatio,
  cacheStatus,
  costSection,
  emptyCacheAccumulator,
  OPENROUTER_CACHE_PROVIDER_OPTIONS,
  renderCacheBox,
  usageSection,
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

describe("cacheStatus / cacheHitRatio", () => {
  test("HIT when read > 0", () => {
    const acc = { ...emptyCacheAccumulator(), read: 1, input: 1 };
    expect(cacheStatus(acc)).toBe("HIT ✅");
  });

  test("WRITE when only write > 0", () => {
    const acc = { ...emptyCacheAccumulator(), write: 1 };
    expect(cacheStatus(acc)).toBe("WRITE 📝");
  });

  test("MISS when both zero", () => {
    expect(cacheStatus(emptyCacheAccumulator())).toBe("MISS ❌");
  });

  test("hitRatio = read / input", () => {
    const acc = { ...emptyCacheAccumulator(), read: 80, input: 100 };
    expect(cacheHitRatio(acc)).toBeCloseTo(0.8, 6);
  });

  test("hitRatio is 0 when input is 0", () => {
    expect(cacheHitRatio(emptyCacheAccumulator())).toBe(0);
  });
});

describe("costSection / usageSection", () => {
  test("costSection shows discount % when priced", () => {
    const acc = {
      ...emptyCacheAccumulator(),
      cost: 0.1,
      uncachedEquivalent: 1.0,
    };
    const rows = costSection(acc);
    const map = new Map(rows);
    expect(map.get("cost")).toBe("$0.100000");
    expect(map.get("if uncached")).toBe("$1.000000");
    expect(map.get("saved")).toBe("$0.900000 (90.0%)");
  });

  test("costSection shows n/a when pricing unknown", () => {
    const acc = { ...emptyCacheAccumulator(), pricingUnknown: true };
    const rows = costSection(acc);
    expect(rows.find(([k]) => k === "cost")?.[1]).toContain("unpriced");
    expect(rows.find(([k]) => k === "saved")?.[1]).toBe("(n/a)");
  });

  test("usageSection includes provider/model/tokens/hit_ratio", () => {
    const acc = {
      ...emptyCacheAccumulator(),
      input: 1_000,
      output: 50,
      read: 800,
      write: 0,
    };
    const rows = usageSection(acc, "openrouter", "anthropic/claude-haiku-4.5");
    const map = new Map(rows);
    expect(map.get("provider")).toBe("openrouter");
    expect(map.get("model")).toBe("anthropic/claude-haiku-4.5");
    expect(map.get("input")).toBe("1000");
    expect(map.get("output")).toBe("50");
    expect(map.get("cache rd")).toBe("800");
    expect(map.get("cache wr")).toBe("0");
    expect(map.get("hit_ratio")).toBe("80.0%");
  });
});

describe("renderCacheBox", () => {
  test("emits header, sections separated by rules, and footer", () => {
    const out = renderCacheBox({
      tag: "decopilot:cache",
      status: "HIT ✅",
      sections: [
        [
          ["org", "org_x"],
          ["vmcp", "vmcp_y"],
        ],
        [
          ["provider", "openrouter"],
          ["input", "100"],
        ],
        [["cost", "$0.0001"]],
      ],
      footer: "[decopilot:cache] === end ===",
    });
    expect(out).toContain("[decopilot:cache] HIT ✅");
    expect(out).toContain("org      : org_x");
    expect(out).toContain("vmcp     : vmcp_y");
    expect(out).toContain("provider : openrouter");
    expect(out).toContain("input    : 100");
    expect(out).toContain("cost     : $0.0001");
    expect(out).toContain("[decopilot:cache] === end ===");
    // Section separator (thin rule) appears between sections, not at top/bottom.
    const thinRules = (out.match(/╠─/g) ?? []).length;
    expect(thinRules).toBe(2); // 3 sections → 2 separators
  });

  test("all box rows have the same visual width (alignment sanity)", () => {
    const out = renderCacheBox({
      tag: "decopilot:cache subtask",
      status: "MISS ❌",
      sections: [[["k", "v"]]],
      footer: "",
    });
    const lines = out.split("\n").filter((l) => l.startsWith("║"));
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
  });
});
