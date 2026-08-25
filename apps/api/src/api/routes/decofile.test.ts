import { describe, expect, test } from "bun:test";
import { patchBodySchema } from "./decofile";

describe("decofile patchBodySchema", () => {
  test("accepts a reasonably sized patch", () => {
    const result = patchBodySchema.safeParse({
      set: { "pages/home": {} },
      delete: ["pages/old"],
    });
    expect(result.success).toBe(true);
  });

  test("rejects a patch touching more than 500 blocks", () => {
    // Before the fix: unbounded, one commit tree write per key.
    const result = patchBodySchema.safeParse({
      delete: Array.from({ length: 501 }, (_, i) => `pages/block_${i}`),
    });
    expect(result.success).toBe(false);
  });
});
