import { describe, expect, test } from "bun:test";
import { deepLinkCollection, visibleCollection } from "./content-browser";

describe("visibleCollection on a Blocks (v8) site", () => {
  test("no Calendar here: its campaigns are the Calendar view", () => {
    expect(visibleCollection("calendar", true)).toBe("pages");
  });

  test("a v7 site keeps its Calendar", () => {
    expect(visibleCollection("calendar")).toBe("calendar");
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
