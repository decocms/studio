import { describe, expect, it } from "bun:test";
import { previousSlugsOf } from "./org-previous-slug";

describe("previousSlugsOf", () => {
  it("reads string and object metadata", () => {
    expect(previousSlugsOf('{"previousSlugs":["deco"]}')).toEqual(["deco"]);
    expect(previousSlugsOf({ previousSlugs: ["a", 1, "b"] })).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns [] for missing, malformed, or non-array values", () => {
    expect(previousSlugsOf(null)).toEqual([]);
    expect(previousSlugsOf("not json")).toEqual([]);
    expect(previousSlugsOf('{"archived":true}')).toEqual([]);
    expect(previousSlugsOf('{"previousSlugs":"deco"}')).toEqual([]);
  });
});
