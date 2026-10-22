import { describe, expect, test } from "bun:test";
import { parseCol } from "./list-blocks";

describe("parseCol", () => {
  test("keeps a well-formed items array of strings", () => {
    expect(parseCol('{"title":"A","items":["x","y"]}', "fallback")).toEqual({
      title: "A",
      items: ["x", "y"],
    });
  });

  test("coerces non-string items instead of handing them to the inline editor", () => {
    expect(parseCol('{"title":"A","items":[1,null,"x"]}', "fallback")).toEqual({
      title: "A",
      items: ["", "", "x"],
    });
  });

  test("falls back on malformed JSON", () => {
    expect(parseCol("not json", "fallback")).toEqual({
      title: "fallback",
      items: [],
    });
  });
});
