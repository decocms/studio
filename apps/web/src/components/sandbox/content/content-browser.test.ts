import { describe, expect, test } from "bun:test";
import { visibleCollection } from "./content-browser";

/**
 * The context tab is the one collection an org can turn off, and it is reached
 * by clicking rather than by link — so the case that matters is an admin
 * flipping the flag while someone is standing on it.
 */
describe("visibleCollection", () => {
  test("sends someone standing on the context tab back to posts", () => {
    expect(visibleCollection("context", false)).toBe("posts");
  });

  test("leaves the context tab alone when the org turned it on", () => {
    expect(visibleCollection("context", true)).toBe("context");
  });

  test("never touches a collection the flag has nothing to do with", () => {
    for (const blogAi of [true, false]) {
      expect(visibleCollection("pages", blogAi)).toBe("pages");
      expect(visibleCollection("posts", blogAi)).toBe("posts");
      expect(visibleCollection("sections", blogAi)).toBe("sections");
    }
  });
});
