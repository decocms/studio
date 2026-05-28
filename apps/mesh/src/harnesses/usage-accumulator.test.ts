import { describe, expect, test } from "bun:test";
import { createUsageAccumulator } from "./usage-accumulator";

describe("createUsageAccumulator", () => {
  test("starts at zero", () => {
    const acc = createUsageAccumulator();
    expect(acc.totalTokens()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(acc.cacheTotals()).toEqual({ read: 0, write: 0, input: 0 });
    expect(acc.cost()).toBe(0);
  });

  test("addStep accumulates input/output/total tokens", () => {
    const acc = createUsageAccumulator();
    acc.addStep(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      undefined,
    );
    acc.addStep(
      { inputTokens: 200, outputTokens: 75, totalTokens: 275 },
      undefined,
    );
    expect(acc.totalTokens()).toEqual({
      inputTokens: 300,
      outputTokens: 125,
      totalTokens: 425,
    });
  });

  test("addStep accumulates cache tokens from inputTokenDetails", () => {
    const acc = createUsageAccumulator();
    acc.addStep(
      {
        inputTokens: 10_000,
        outputTokens: 100,
        totalTokens: 10_100,
        inputTokenDetails: {
          cacheReadTokens: 9_000,
          cacheWriteTokens: 500,
        },
      },
      undefined,
    );
    expect(acc.cacheTotals()).toEqual({
      read: 9_000,
      write: 500,
      input: 10_000,
    });
  });

  test("addStep with undefined usage is a no-op for tokens", () => {
    const acc = createUsageAccumulator();
    acc.addStep(undefined, undefined);
    expect(acc.totalTokens()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(acc.cacheTotals()).toEqual({ read: 0, write: 0, input: 0 });
  });

  test("addStep accumulates OpenRouter cost when provider metadata reports it", () => {
    const acc = createUsageAccumulator();
    acc.addStep(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      { openrouter: { usage: { cost: 0.01 } } },
    );
    acc.addStep(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      { openrouter: { usage: { cost: 0.02 } } },
    );
    expect(acc.cost()).toBeCloseTo(0.03, 6);
  });

  test("addStep ignores cost for providers that don't report it", () => {
    const acc = createUsageAccumulator();
    acc.addStep(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      {
        anthropic: {
          /* no cost field */
        } as Record<string, unknown>,
      },
    );
    expect(acc.cost()).toBe(0);
  });

  test("buildStepUsage returns cumulative shape with cache details", () => {
    const acc = createUsageAccumulator();
    acc.addStep(
      {
        inputTokens: 10_000,
        outputTokens: 100,
        totalTokens: 10_100,
        inputTokenDetails: {
          cacheReadTokens: 9_000,
          cacheWriteTokens: 500,
        },
      },
      undefined,
    );
    const step = acc.buildStepUsage();
    expect(step).toEqual({
      inputTokens: 10_000,
      outputTokens: 100,
      totalTokens: 10_100,
      contextTokens: 10_000,
      cachedInputTokens: 9_000,
      inputTokenDetails: {
        cacheReadTokens: 9_000,
        cacheWriteTokens: 500,
        noCacheTokens: 10_000 - 9_000 - 500,
      },
    });
  });

  test("buildStepUsage includes openrouter cost when nonzero", () => {
    const acc = createUsageAccumulator();
    acc.addStep(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      { openrouter: { usage: { cost: 0.05 } } },
    );
    const step = acc.buildStepUsage();
    expect(step.providerMetadata).toEqual({
      openrouter: { usage: { cost: 0.05 } },
    });
  });

  test("buildStepUsage omits providerMetadata when cost is zero", () => {
    const acc = createUsageAccumulator();
    acc.addStep(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      undefined,
    );
    const step = acc.buildStepUsage();
    expect(step.providerMetadata).toBeUndefined();
  });

  test("buildFinalUsage uses totalUsage when present and nonzero", () => {
    const acc = createUsageAccumulator();
    acc.addStep(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      undefined,
    );
    const final = acc.buildFinalUsage({
      totalUsage: {
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
      } as never,
      providerKey: undefined,
    });
    expect(final?.inputTokens).toBe(200);
    expect(final?.outputTokens).toBe(100);
    expect(final?.totalTokens).toBe(300);
  });

  test("buildFinalUsage falls back to step totals when totalUsage is zeroed (abort case)", () => {
    const acc = createUsageAccumulator();
    acc.addStep(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      undefined,
    );
    const final = acc.buildFinalUsage({
      totalUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      } as never,
      providerKey: undefined,
    });
    expect(final?.inputTokens).toBe(100);
    expect(final?.outputTokens).toBe(50);
    expect(final?.totalTokens).toBe(150);
  });

  test("buildFinalUsage returns undefined when no usage at all", () => {
    const acc = createUsageAccumulator();
    const final = acc.buildFinalUsage({
      totalUsage: null,
      providerKey: undefined,
    });
    expect(final).toBeUndefined();
  });

  test("buildFinalUsage carries reasoningTokens from totalUsage", () => {
    const acc = createUsageAccumulator();
    acc.addStep(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      undefined,
    );
    const final = acc.buildFinalUsage({
      totalUsage: {
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        reasoningTokens: 42,
      } as never,
      providerKey: undefined,
    });
    expect(final?.reasoningTokens).toBe(42);
  });

  test("buildFinalUsage attaches cache breakdown", () => {
    const acc = createUsageAccumulator();
    acc.addStep(
      {
        inputTokens: 10_000,
        outputTokens: 100,
        totalTokens: 10_100,
        inputTokenDetails: {
          cacheReadTokens: 9_000,
          cacheWriteTokens: 500,
        },
      },
      undefined,
    );
    const final = acc.buildFinalUsage({
      totalUsage: {
        inputTokens: 10_000,
        outputTokens: 100,
        totalTokens: 10_100,
      } as never,
      providerKey: undefined,
    });
    expect(final?.cachedInputTokens).toBe(9_000);
    expect(final?.inputTokenDetails).toEqual({
      cacheReadTokens: 9_000,
      cacheWriteTokens: 500,
      noCacheTokens: 10_000 - 9_000 - 500,
    });
  });

  test("buildFinalUsage merges accumulated cost into provider metadata", () => {
    const acc = createUsageAccumulator();
    acc.addStep(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      { openrouter: { usage: { cost: 0.05, prompt_tokens: 100 } } },
    );
    const final = acc.buildFinalUsage({
      totalUsage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      } as never,
      providerKey: "openrouter",
    });
    const openrouter = final?.providerMetadata?.openrouter as
      | { usage?: { cost?: number } }
      | undefined;
    expect(openrouter?.usage?.cost).toBe(0.05);
  });

  test("addStep returns the new cumulative totals", () => {
    const acc = createUsageAccumulator();
    const after1 = acc.addStep(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      undefined,
    );
    expect(after1).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    const after2 = acc.addStep(
      { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
      undefined,
    );
    expect(after2).toEqual({
      inputTokens: 150,
      outputTokens: 75,
      totalTokens: 225,
    });
  });
});
