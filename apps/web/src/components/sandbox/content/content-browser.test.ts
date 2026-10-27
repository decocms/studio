import { describe, expect, test } from "bun:test";
import { deepLinkCollection, visibleCollection } from "./content-browser";

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

describe("visibleCollection on a Blocks (v8) site", () => {
  test("no Calendar here: its campaigns are the Calendar view", () => {
    expect(visibleCollection("calendar", false, true)).toBe("pages");
  });

  test("a v7 site keeps its Calendar", () => {
    expect(visibleCollection("calendar", false)).toBe("calendar");
  });
});

describe("deepLinkCollection", () => {
  test("v8: opens a blog collection or Sections", () => {
    expect(deepLinkCollection("posts", true)).toBe("posts");
    expect(deepLinkCollection("sections", true)).toBe("sections");
    expect(deepLinkCollection("campaigns", true)).toBeNull();
  });

  test("v7: only a blog collection, as before; anything else opens Pages", () => {
    expect(deepLinkCollection("posts", false)).toBe("posts");
    expect(deepLinkCollection("sections", false)).toBeNull();
    expect(deepLinkCollection("campaigns", false)).toBeNull();
  });

  test("anything else opens the default", () => {
    for (const v8 of [true, false]) {
      expect(deepLinkCollection(undefined, v8)).toBeNull();
      expect(deepLinkCollection("settings", v8)).toBeNull();
      expect(deepLinkCollection("nope", v8)).toBeNull();
    }
  });
});
