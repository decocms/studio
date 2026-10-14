import { describe, expect, it } from "bun:test";
import { discardPlan } from "./discard-patch";

const home = ".deco/blocks/pages-home.json";
const promo = ".deco/blocks/Promo.json";

describe("discardPlan", () => {
  it("writes main's body back, and deletes a block only the draft has", () => {
    expect(
      discardPlan([home, promo], {
        diffs: {
          [home]: { from: '{"title":"main"}', to: '{"title":"edited"}' },
          [promo]: { from: null, to: '{"title":"new"}' },
        },
      }),
    ).toEqual({
      patch: { set: { "pages-home": { title: "main" } }, delete: ["Promo"] },
      drop: [],
    });
  });

  it("restores a block the draft deleted", () => {
    expect(
      discardPlan([promo], {
        diffs: { [promo]: { from: '{"title":"main"}', to: null } },
      }),
    ).toEqual({ patch: { set: { Promo: { title: "main" } } }, drop: [] });
  });

  it("only drops the draft's entry where the draft already equals main", () => {
    expect(discardPlan([home], { diffs: {} })).toEqual({
      patch: null,
      drop: [home],
    });
    expect(
      discardPlan([home, promo], {
        diffs: { [promo]: { from: '{"title":"main"}', to: '{"a":1}' } },
      }),
    ).toEqual({ patch: { set: { Promo: { title: "main" } } }, drop: [home] });
  });

  it("is null without a diff, for a path that isn't a block, or for a body that isn't one", () => {
    expect(discardPlan([home], null)).toBeNull();
    expect(
      discardPlan(["README.md"], {
        diffs: { "README.md": { from: "a", to: "b" } },
      }),
    ).toBeNull();
    expect(
      discardPlan([home], { diffs: { [home]: { from: "[1]", to: "{}" } } }),
    ).toBeNull();
  });
});
