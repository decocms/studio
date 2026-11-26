import { describe, expect, test } from "bun:test";
import { costTotal, createCostCollector, llmCostUsd } from "./costs.ts";

describe("llmCostUsd", () => {
  test("the provider's reported cost wins", () => {
    expect(
      llmCostUsd({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-5.5",
        promptTokens: 1_000_000,
        completionTokens: 0,
        costUsd: 1.5,
      }),
    ).toBe(1.5);
  });

  test("without it, the list price of a known model", () => {
    expect(
      llmCostUsd({
        provider: "anthropic",
        model: "anthropic/claude-sonnet-5.5",
        promptTokens: 1_000_000,
        completionTokens: 100_000,
      }),
    ).toBe(3);
  });

  test("an unknown model is unpriced, never free", () => {
    expect(
      llmCostUsd({
        provider: "deco",
        model: "some/other-model",
        promptTokens: 10,
        completionTokens: 10,
      }),
    ).toBeNull();
  });
});

describe("createCostCollector", () => {
  test("keys drafts in call order and sums what is priced", () => {
    const c = createCostCollector("d1");
    c.llm({
      provider: "openrouter",
      model: "m",
      promptTokens: 1,
      completionTokens: 2,
      costUsd: 0.25,
    });
    c.scan({
      label: "uxFunnelSegments",
      bytesProcessed: 1024 ** 4,
      bytesBilled: 1024 ** 4,
      cacheHit: false,
      rows: 3,
    });
    c.scan({
      label: "uxPageFunnel",
      bytesProcessed: null,
      bytesBilled: 1024 ** 4,
      cacheHit: true,
      rows: 3,
    });
    c.llm({
      provider: "deco",
      model: "x",
      promptTokens: 1,
      completionTokens: 1,
    });
    expect(c.drafts.map((d) => [d.key, d.provider, d.costUsd])).toEqual([
      ["c0", "openrouter", 0.25],
      ["c1", "bigquery", 6.25],
      ["c2", "bigquery", 0],
      ["c3", "deco", null],
    ]);
    expect(c.drafts.every((d) => d.jobId === "d1")).toBe(true);
    expect(costTotal(c)).toBe(6.5);
  });
});
