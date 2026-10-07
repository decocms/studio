import { describe, expect, test } from "bun:test";
import { parseFaqItems } from "./faq-items";

describe("parseFaqItems", () => {
  test("reads the stored array the editor writes", () => {
    expect(
      parseFaqItems([
        { title: "Entrega?", body: [{ __resolveType: "p", html: "2 dias" }] },
      ]),
    ).toEqual([
      { title: "Entrega?", body: [{ __resolveType: "p", html: "2 dias" }] },
    ]);
  });

  test("reads the JSON-encoded form an import hands over", () => {
    expect(parseFaqItems('[{"title":"Troca?"}]')).toEqual([
      { title: "Troca?", body: [] },
    ]);
  });

  test("normalizes a missing or non-array body to an empty answer", () => {
    expect(parseFaqItems([{ title: "q", body: "nope" }])).toEqual([
      { title: "q", body: [] },
    ]);
  });

  test("drops entries that aren't objects", () => {
    expect(parseFaqItems(["q", null, 3, { title: "ok" }])).toEqual([
      { title: "ok", body: [] },
    ]);
  });

  test("returns nothing for an absent or malformed value", () => {
    expect(parseFaqItems(undefined)).toEqual([]);
    expect(parseFaqItems("not json")).toEqual([]);
    expect(parseFaqItems({})).toEqual([]);
  });
});
