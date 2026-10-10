import { describe, expect, test } from "bun:test";
import { slugFor } from "./cover-image";

describe("slugFor", () => {
  test("folds accents so the bucket listing stays readable", () => {
    expect(slugFor("Mochila para educação infantil")).toBe(
      "mochila-para-educacao-infantil",
    );
  });

  test("falls back when the alt text has nothing to slug", () => {
    expect(slugFor("")).toBe("cover");
    expect(slugFor("!!! ???")).toBe("cover");
  });

  test("bounds the name, since the alt text is a sentence", () => {
    expect(slugFor("a".repeat(200)).length).toBe(60);
  });

  test("never leaves a dangling separator", () => {
    expect(slugFor("  Volta às aulas!  ")).toBe("volta-as-aulas");
  });
});
