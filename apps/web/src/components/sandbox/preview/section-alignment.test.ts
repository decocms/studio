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
const HEADER = "site/sections/Header.tsx";
const SEO_TITLE = "site/sections/Seo/SeoTitle.tsx";
const VIDEO = "site/sections/ContentRetrofit/Video.tsx";
const CONTENT = "site/sections/LandingPage/Content.tsx";
const MOSAIC = "site/sections/MosaicParallax.tsx";
const STICKY = "site/sections/LandingPage/StickyTextOverlay.tsx";
const QUOTE = "site/sections/LandingPage/Quote.tsx";
const MODAL = "site/sections/LandingPage/RichMediaModal.tsx";
const TABBED = "site/sections/TabbedProductShelf.tsx";
const PAGE_CHROME = "site/sections/PageChrome.tsx";

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

  // The regression this module exists for: a section with no node shifted the rest.
  it("leaves a section that rendered no node unmapped without shifting the rest", () => {
    expect(alignSections([[HERO], [SHELF], [FOOTER]], [HERO, FOOTER])).toEqual([
      0,
      null,
      1,
    ]);
  });

  // Reported shape: matching counts made the old alignment map one slot early.
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
    // classic keeps the wrapper; TanStack renders the inner section
    expect(alignSections([[LAZY, SHELF]], [LAZY])).toEqual([0]);
    expect(alignSections([[LAZY, SHELF]], [SHELF])).toEqual([0]);
  });

  it("does not let a wildcard steal a node an exact match wants", () => {
    // [] = multivariate: must take the leftover node, not Footer's.
    expect(alignSections([[], [FOOTER]], [BANNER, FOOTER])).toEqual([0, 1]);
    expect(alignSections([[FOOTER], []], [FOOTER, BANNER])).toEqual([0, 1]);
  });

  it("never maps a section onto a node whose key it cannot render", () => {
    const result = alignSections([[HERO], [SHELF]], [HERO, ANALYTICS, FOOTER]);
    expect(result[0]).toBe(0);
    expect(result[1]).toBeNull();
  });

  it("falls back to positional only when nothing matches and counts line up", () => {
    expect(alignSections([[HERO], [SHELF]], ["a", "b"])).toEqual([0, 1]);
    // Ambiguous — refuse to guess.
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

  describe("out of order, by key", () => {
    // osklen's landing pages (/trkk, /pranchas-surf, /kaapuera, ...): a SEO
    // section saved ahead of the header, which the layout renders first; the
    // page chrome renders nothing. In order only, the header lost its node.
    it("maps a header the layout renders before a section saved ahead of it", () => {
      expect(
        alignSections(
          [[SEO_TITLE], [HEADER], [VIDEO], [CONTENT], [FOOTER], [PAGE_CHROME]],
          [HEADER, SEO_TITLE, VIDEO, CONTENT, FOOTER],
        ),
      ).toEqual([1, 0, 2, 3, 4, null]);
    });

    it("maps the whole /trkk page, repeated keys included", () => {
      const saved = [
        SEO_TITLE,
        HEADER,
        VIDEO,
        CONTENT,
        MOSAIC,
        CONTENT,
        STICKY,
        QUOTE,
        MODAL,
        TABBED,
        MODAL,
        FOOTER,
        PAGE_CHROME,
      ];
      const dom = [HEADER, ...saved.slice(0, 1), ...saved.slice(2, 12)];
      expect(
        alignSections(
          saved.map((key) => [key]),
          dom,
        ),
      ).toEqual([1, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, null]);
    });

    it("leaves a page whose DOM follows its array as it was (listing page)", () => {
      expect(
        alignSections(
          [[HEADER], [VIDEO], [CONTENT], [FOOTER], [PAGE_CHROME]],
          [HEADER, VIDEO, CONTENT, FOOTER],
        ),
      ).toEqual([0, 1, 2, 3, null]);
      // ...and without header/footer markers (osklen before this change).
      expect(
        alignSections(
          [[SEO_TITLE], [HEADER], [VIDEO], [CONTENT], [FOOTER], [PAGE_CHROME]],
          [SEO_TITLE, VIDEO, CONTENT],
        ),
      ).toEqual([0, null, 1, 2, null, null]);
    });

    it("maps two sections rendered in swapped order", () => {
      expect(alignSections([[HERO], [SHELF]], [SHELF, HERO])).toEqual([1, 0]);
    });

    it("keeps repeated keys in order when another section moves past them", () => {
      expect(
        alignSections([[SHELF], [HEADER], [SHELF]], [HEADER, SHELF, SHELF]),
      ).toEqual([1, 0, 2]);
      expect(
        alignSections([[SHELF], [BANNER], [SHELF]], [BANNER, SHELF, SHELF]),
      ).toEqual([1, 0, 2]);
      expect(
        alignSections(
          [[SHELF], [SHELF], [HEADER], [SHELF]],
          [HEADER, SHELF, SHELF, SHELF],
        ),
      ).toEqual([1, 2, 0, 3]);
    });

    it("matches a Lazy out of order by its inner key", () => {
      expect(
        alignSections([[SEO_TITLE], [LAZY, SHELF]], [SHELF, SEO_TITLE]),
      ).toEqual([1, 0]);
    });

    it("never moves a wildcard out of order onto a framework node", () => {
      expect(alignSections([[], [HEADER]], [HEADER, SEO])).toEqual([null, 0]);
    });

    it("still never maps a section onto a node whose key it cannot render", () => {
      expect(
        alignSections([[HERO], [HEADER], [SHELF]], [SHELF, ANALYTICS, HERO]),
      ).toEqual([2, null, 0]);
    });

    it("lets a framework node the page doesn't list stay unmapped", () => {
      expect(
        alignSections(
          [[SEO_TITLE], [HEADER], [FOOTER]],
          [HEADER, THEME, SEO_TITLE, FOOTER],
        ),
      ).toEqual([2, 0, 3]);
    });
  });
});
