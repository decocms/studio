import { describe, expect, test } from "bun:test";
import { deepLinkCollection, visibleCollection } from "./content-browser";

describe("visibleCollection on a Blocks (v8) site", () => {
  test("no Calendar here: its campaigns are the Calendar view", () => {
    expect(visibleCollection("calendar", true)).toBe("pages");
  });

  test("a v7 site keeps its Calendar", () => {
    expect(visibleCollection("calendar")).toBe("calendar");
  });

  test("never touches another collection", () => {
    for (const v8 of [true, false]) {
      expect(visibleCollection("pages", v8)).toBe("pages");
      expect(visibleCollection("sections", v8)).toBe("sections");
    }
  });
});

/**
 * Blog collections left the Site Editor for their own view; the router sends
 * the Blog Manager's `?contentCollection=posts` there before this reads it.
 */
describe("deepLinkCollection", () => {
  test("v8: opens Sections", () => {
    expect(deepLinkCollection("sections", true)).toBe("sections");
    expect(deepLinkCollection("campaigns", true)).toBeNull();
  });

  test("v7: nothing; the link opens Pages", () => {
    expect(deepLinkCollection("sections", false)).toBeNull();
    expect(deepLinkCollection("campaigns", false)).toBeNull();
  });

  test("a blog collection or anything else opens the default", () => {
    for (const v8 of [true, false]) {
      expect(deepLinkCollection(undefined, v8)).toBeNull();
      expect(deepLinkCollection("posts", v8)).toBeNull();
      expect(deepLinkCollection("settings", v8)).toBeNull();
      expect(deepLinkCollection("nope", v8)).toBeNull();
    }
  });
});
