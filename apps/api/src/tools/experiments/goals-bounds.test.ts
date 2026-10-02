import { describe, expect, it } from "bun:test";
import { EXPERIMENT_CREATE } from "./create";
import { EXPERIMENT_UPDATE } from "./update";

const tooMany = Array.from({ length: 21 }, (_, i) => `goal-${i}`);
const tooLong = ["a".repeat(201)];

describe("EXPERIMENT_CREATE goals bounds", () => {
  it("rejects more than 20 goals", () => {
    const result = EXPERIMENT_CREATE.inputSchema.safeParse({
      site: "my-site",
      key: "k",
      name: "n",
      goals: tooMany,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized goal string", () => {
    const result = EXPERIMENT_CREATE.inputSchema.safeParse({
      site: "my-site",
      key: "k",
      name: "n",
      goals: tooLong,
    });
    expect(result.success).toBe(false);
  });
});

describe("EXPERIMENT_UPDATE goals bounds", () => {
  it("rejects more than 20 goals", () => {
    const result = EXPERIMENT_UPDATE.inputSchema.safeParse({
      site: "my-site",
      key: "k",
      goals: tooMany,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized goal string", () => {
    const result = EXPERIMENT_UPDATE.inputSchema.safeParse({
      site: "my-site",
      key: "k",
      goals: tooLong,
    });
    expect(result.success).toBe(false);
  });
});
