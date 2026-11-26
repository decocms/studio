import { describe, expect, test } from "bun:test";
import { jsonField, normalizeAnchorId, parseJsonArray } from "./primitives";

describe("normalizeAnchorId", () => {
  test("drops whitespace at the ends and in the middle", () => {
    expect(normalizeAnchorId(" minha faq 1 ")).toBe("minhafaq1");
    expect(normalizeAnchorId("a\tb\nc")).toBe("abc");
  });

  test("leaves an id with no whitespace as it is", () => {
    expect(normalizeAnchorId("perguntas-frequentes")).toBe(
      "perguntas-frequentes",
    );
  });

  test("turns whitespace alone into no id", () => {
    expect(normalizeAnchorId(" \n ")).toBe("");
  });
});

describe("jsonField", () => {
  test("passes an already-encoded string through unchanged", () => {
    expect(jsonField('[{"title":"a"}]')).toBe('[{"title":"a"}]');
  });

  test("re-encodes a stored array instead of coercing it to an empty string", () => {
    const stored = [{ title: "a" }, { title: "b" }];
    const field = jsonField(stored);
    expect(parseJsonArray(field)).toEqual(stored);
  });

  test("falls back to the given default for null/undefined", () => {
    expect(jsonField(undefined)).toBe("[]");
    expect(jsonField(null, {})).toBe("{}");
  });
});
