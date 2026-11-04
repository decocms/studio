import { describe, expect, test } from "bun:test";
import { brandsWrittenTo } from "./brand-events";

describe("brandsWrittenTo", () => {
  test("a brand's guide and files name the brand", () => {
    expect(
      brandsWrittenTo("home", [
        "brands/aurora/brand.md",
        "brands/aurora/tokens.css",
        "brands/aurora/campaigns/verao.json",
      ]),
    ).toEqual(["aurora"]);
  });

  test("the brand folder itself counts, so a new brand shows up", () => {
    expect(brandsWrittenTo("home", ["brands/aurora"])).toEqual(["aurora"]);
  });

  test("cards have an event of their own", () => {
    expect(
      brandsWrittenTo("home", [
        "brands/aurora/cards/abc.json",
        "brands/aurora/cards",
      ]),
    ).toEqual([]);
    expect(brandsWrittenTo("home", ["brands/aurora/cardsy.md"])).toEqual([
      "aurora",
    ]);
  });

  test("nothing outside the brands folder, and nothing on another volume", () => {
    expect(
      brandsWrittenTo("home", [
        "users/u1/brands/aurora/brand.md",
        "brands/",
        "claude-sessions/x.jsonl",
      ]),
    ).toEqual([]);
    expect(brandsWrittenTo("public", ["brands/aurora/brand.md"])).toEqual([]);
  });

  test("a move names both ends, each brand once", () => {
    expect(
      brandsWrittenTo("home", [
        "brands/aurora/brand.md",
        "brands/boreal/brand.md",
        "/brands/aurora/logo.svg",
      ]),
    ).toEqual(["aurora", "boreal"]);
  });
});
