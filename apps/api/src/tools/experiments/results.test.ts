import { describe, expect, it } from "bun:test";
import { EXPERIMENT_RESULTS } from "./results";

describe("EXPERIMENT_RESULTS", () => {
  const base = { site: "acme", key: "Cross Sell Bag" };

  it("rejects more than 20 goals", () => {
    const result = EXPERIMENT_RESULTS.inputSchema.safeParse({
      ...base,
      goals: Array.from({ length: 21 }, (_, i) => `goal-${i}`),
    });

    expect(result.success).toBe(false);
  });

  it("accepts 20 goals", () => {
    const result = EXPERIMENT_RESULTS.inputSchema.safeParse({
      ...base,
      goals: Array.from({ length: 20 }, (_, i) => `goal-${i}`),
    });

    expect(result.success).toBe(true);
  });

  it("rejects a reversed since/until range", () => {
    const result = EXPERIMENT_RESULTS.inputSchema.safeParse({
      ...base,
      since: "2026-02-01",
      until: "2026-01-01",
    });

    expect(result.success).toBe(false);
  });

  it("accepts an in-order since/until range", () => {
    const result = EXPERIMENT_RESULTS.inputSchema.safeParse({
      ...base,
      since: "2026-01-01",
      until: "2026-02-01",
    });

    expect(result.success).toBe(true);
  });
});
