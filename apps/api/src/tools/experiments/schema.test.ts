import { describe, expect, test } from "bun:test";
import { EXPERIMENT_CREATE } from "./create";
import { EXPERIMENT_UPDATE } from "./update";
import { variantsInputSchema } from "./schema";

const baseVariant = { id: "control", weight: 100 };

describe("variantsInputSchema", () => {
  test("rejects more than 20 variants", () => {
    const variants = Array.from({ length: 21 }, (_, i) => ({
      id: `v${i}`,
      weight: i === 0 ? 100 : 0,
    }));
    expect(variantsInputSchema.safeParse(variants).success).toBe(false);
  });

  test("rejects a variant id over 120 chars", () => {
    const result = variantsInputSchema.safeParse([
      { id: "x".repeat(121), weight: 100 },
    ]);
    expect(result.success).toBe(false);
  });

  test("rejects a description over 500 chars", () => {
    const result = variantsInputSchema.safeParse([
      { ...baseVariant, description: "x".repeat(501) },
    ]);
    expect(result.success).toBe(false);
  });

  test("accepts a valid single variant", () => {
    expect(variantsInputSchema.safeParse([baseVariant]).success).toBe(true);
  });
});

describe("EXPERIMENT_CREATE input bounds", () => {
  test("rejects a name over 200 chars", () => {
    const result = EXPERIMENT_CREATE.inputSchema.safeParse({
      site: "my-site",
      key: "valentine-banner",
      name: "x".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  test("rejects more than 20 goals", () => {
    const result = EXPERIMENT_CREATE.inputSchema.safeParse({
      site: "my-site",
      key: "valentine-banner",
      name: "Valentine Banner",
      goals: Array.from({ length: 21 }, (_, i) => `goal-${i}`),
    });
    expect(result.success).toBe(false);
  });

  test("rejects a goal over 200 chars", () => {
    const result = EXPERIMENT_CREATE.inputSchema.safeParse({
      site: "my-site",
      key: "valentine-banner",
      name: "Valentine Banner",
      goals: ["x".repeat(201)],
    });
    expect(result.success).toBe(false);
  });
});

describe("EXPERIMENT_UPDATE input bounds", () => {
  test("rejects a name over 200 chars", () => {
    const result = EXPERIMENT_UPDATE.inputSchema.safeParse({
      site: "my-site",
      key: "valentine-banner",
      name: "x".repeat(201),
    });
    expect(result.success).toBe(false);
  });
});
