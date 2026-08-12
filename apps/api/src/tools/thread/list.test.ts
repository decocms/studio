import { describe, expect, it } from "bun:test";
import { COLLECTION_THREADS_LIST } from "./list";

describe("COLLECTION_THREADS_LIST input schema", () => {
  it("accepts a reasonably sized trigger_ids filter", () => {
    const result = COLLECTION_THREADS_LIST.inputSchema.safeParse({
      where: { trigger_ids: ["a", "b"] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an oversized trigger_ids filter", () => {
    const trigger_ids = Array.from({ length: 1001 }, (_, i) => `t${i}`);
    const result = COLLECTION_THREADS_LIST.inputSchema.safeParse({
      where: { trigger_ids },
    });
    expect(result.success).toBe(false);
  });
});
