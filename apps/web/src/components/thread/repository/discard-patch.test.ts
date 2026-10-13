import { describe, expect, it } from "bun:test";
import { discardPatch } from "./discard-patch";

const home = ".deco/blocks/pages-home.json";
const promo = ".deco/blocks/Promo.json";

describe("discardPatch", () => {
  it("writes main's body back, and deletes a block only the draft has", () => {
    expect(
      discardPatch([home, promo], {
        diffs: {
          [home]: { from: '{"title":"main"}', to: '{"title":"edited"}' },
          [promo]: { from: null, to: '{"title":"new"}' },
        },
      }),
    ).toEqual({ set: { "pages-home": { title: "main" } }, delete: ["Promo"] });
  });

  it("restores a block the draft deleted", () => {
    expect(
      discardPatch([promo], {
        diffs: { [promo]: { from: '{"title":"main"}', to: null } },
      }),
    ).toEqual({ set: { Promo: { title: "main" } } });
  });

  it("is null without the bodies, for a path that isn't a block, or for a body that isn't one", () => {
    expect(discardPatch([home], null)).toBeNull();
    expect(discardPatch([home], { diffs: {} })).toBeNull();
    expect(
      discardPatch(["README.md"], {
        diffs: { "README.md": { from: "a", to: "b" } },
      }),
    ).toBeNull();
    expect(
      discardPatch([home], { diffs: { [home]: { from: "[1]", to: "{}" } } }),
    ).toBeNull();
  });
});
