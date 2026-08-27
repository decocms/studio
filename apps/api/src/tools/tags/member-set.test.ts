import { describe, expect, test } from "bun:test";
import { MEMBER_TAGS_SET } from "./member-set";

describe("MEMBER_TAGS_SET input schema", () => {
  test("accepts a reasonably sized tagIds array", () => {
    const result = MEMBER_TAGS_SET.inputSchema.safeParse({
      memberId: "member_1",
      tagIds: ["tag_1", "tag_2"],
    });
    expect(result.success).toBe(true);
  });

  test("rejects a tagIds array over the bound", () => {
    // Before the fix: unbounded, and each id drives its own serial DB query.
    const result = MEMBER_TAGS_SET.inputSchema.safeParse({
      memberId: "member_1",
      tagIds: Array.from({ length: 1001 }, (_, i) => `tag_${i}`),
    });
    expect(result.success).toBe(false);
  });
});
