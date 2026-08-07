import { describe, expect, it } from "bun:test";
import { alignSections } from "./section-alignment";

const HERO = "site/sections/Hero.tsx";
const SHELF = "site/sections/ProductShelf.tsx";
const FOOTER = "site/sections/Footer.tsx";
const BANNER = "site/sections/Banner.tsx";
const SEO = "website/sections/Seo/Seo.tsx";
const THEME = "website/sections/Theme/Theme.tsx";
const ANALYTICS = "website/sections/Analytics/Analytics.tsx";
const LAZY = "website/sections/Rendering/Lazy.tsx";

describe("alignSections", () => {
  it("maps a clean 1:1 page positionally", () => {
    expect(
      alignSections([[HERO], [SHELF], [FOOTER]], [HERO, SHELF, FOOTER]),
    ).toEqual([0, 1, 2]);
  });

  it("skips framework sections that lead, trail, and interleave", () => {
    expect(
      alignSections(
        [[HERO], [SHELF], [FOOTER]],
        [THEME, SEO, HERO, ANALYTICS, SHELF, FOOTER, ANALYTICS],
      ),
    ).toEqual([2, 4, 5]);
  });

  // The regression this module exists for. On TanStack a Lazy/SingleDeferred is
  // unwrapped, so a section that hasn't streamed in yet contributes NO
  // top-level node. Forcing every section to claim a node shifted everything
  // below it by one, and clicking a component opened its neighbour's props.
  it("leaves a section that rendered no node unmapped without shifting the rest", () => {
    expect(alignSections([[HERO], [SHELF], [FOOTER]], [HERO, FOOTER])).toEqual([
      0,
      null,
      1,
    ]);
  });

  // The exact shape reported from TanStack sites: a leading framework section
  // makes the node count match the section count, so the old alignment happily
  // mapped every section one slot early — Hero's click opened the Shelf form.
  it("does not mistake a leading framework node for the first section", () => {
    expect(
      alignSections([[HERO], [SHELF], [FOOTER]], [SEO, HERO, FOOTER]),
    ).toEqual([1, null, 2]);
  });

  it("does not shift when several sections rendered nothing", () => {
    expect(
      alignSections([[HERO], [SHELF], [BANNER], [FOOTER]], [HERO, FOOTER]),
    ).toEqual([0, null, null, 1]);
  });

  it("keeps decofile positions for hidden (null-candidate) sections", () => {
    expect(alignSections([[HERO], null, [SHELF]], [SEO, HERO, SHELF])).toEqual([
      1,
      null,
      2,
    ]);
  });

  it("matches a Lazy against either its wrapper or its unwrapped inner key", () => {
    // classic runtime keeps the wrapper; TanStack renders the inner section
    expect(alignSections([[LAZY, SHELF]], [LAZY])).toEqual([0]);
    expect(alignSections([[LAZY, SHELF]], [SHELF])).toEqual([0]);
  });

  it("does not let a wildcard steal a node an exact match wants", () => {
    // [] = multivariate, rendered key unpredictable. It must take the leftover
    // node, not the one the exact-keyed Footer matches.
    expect(alignSections([[], [FOOTER]], [BANNER, FOOTER])).toEqual([0, 1]);
    expect(alignSections([[FOOTER], []], [FOOTER, BANNER])).toEqual([0, 1]);
  });

  it("never maps a section onto a node whose key it cannot render", () => {
    const result = alignSections([[HERO], [SHELF]], [HERO, ANALYTICS, FOOTER]);
    expect(result[0]).toBe(0);
    expect(result[1]).toBeNull();
  });

  it("falls back to positional only when nothing matches and counts line up", () => {
    // Unknown key convention, but an unambiguous 1:1 count.
    expect(alignSections([[HERO], [SHELF]], ["a", "b"])).toEqual([0, 1]);
    // Ambiguous — refuse to guess rather than open the wrong props.
    expect(alignSections([[HERO], [SHELF]], ["a", "b", "c"])).toEqual([
      null,
      null,
    ]);
  });

  it("handles empty inputs", () => {
    expect(alignSections([], [HERO])).toEqual([]);
    expect(alignSections([[HERO]], [])).toEqual([null]);
    expect(alignSections([null], [])).toEqual([null]);
  });
});
