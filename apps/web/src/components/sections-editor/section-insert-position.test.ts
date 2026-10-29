import { describe, expect, it } from "bun:test";
import { defaultSectionInsertIndex } from "./section-insert-position";

const LAZY = "website/sections/Rendering/Lazy.tsx";

const decofile = {
  Header: { __resolveType: "site/sections/Header/Header.tsx" },
  Footer: { __resolveType: "site/sections/Footer/Footer.tsx" },
  "Footer Farm ETC": { __resolveType: "site/sections/Footer/Footer.tsx" },
  "Textos de SEO - PDC": {
    __resolveType: "site/sections/NewSearch/SEOTexts.tsx",
  },
  Rodape: { __resolveType: "site/sections/Rodape.tsx", name: "Site footer" },
  PreFooterBanner: { __resolveType: "site/sections/Images/Banner.tsx" },
};

describe("defaultSectionInsertIndex", () => {
  it("inserts before a saved footer block closing the page", () => {
    expect(
      defaultSectionInsertIndex(
        [
          { __resolveType: "Header" },
          { __resolveType: "site/sections/Hero/Hero.tsx" },
          { __resolveType: "Footer" },
        ],
        decofile,
      ),
    ).toBe(2);
  });

  it("inserts before a lazy-wrapped footer", () => {
    expect(
      defaultSectionInsertIndex(
        [
          { __resolveType: "Header" },
          {
            __resolveType: LAZY,
            section: { __resolveType: "Footer Farm ETC" },
          },
        ],
        decofile,
      ),
    ).toBe(1);
  });

  it("inserts before an inline footer section", () => {
    expect(
      defaultSectionInsertIndex(
        [
          { __resolveType: "site/sections/Hero/Hero.tsx" },
          { __resolveType: "site/sections/Footer/Footer.tsx" },
        ],
        {},
      ),
    ).toBe(1);
  });

  it("recognizes a saved block by its name", () => {
    expect(
      defaultSectionInsertIndex(
        [{ __resolveType: "Header" }, { __resolveType: "Rodape" }],
        decofile,
      ),
    ).toBe(1);
  });

  it("keeps content sections above the footer in place", () => {
    expect(
      defaultSectionInsertIndex(
        [
          { __resolveType: "Header" },
          { __resolveType: "site/sections/NewSearch/SearchContainer.tsx" },
          { __resolveType: "Textos de SEO - PDC" },
          { __resolveType: "Footer" },
        ],
        decofile,
      ),
    ).toBe(3);
  });

  it("appends when the page does not end in a footer", () => {
    expect(
      defaultSectionInsertIndex(
        [
          { __resolveType: "Footer" },
          { __resolveType: "site/sections/Hero/Hero.tsx" },
        ],
        decofile,
      ),
    ).toBe(2);
    expect(
      defaultSectionInsertIndex(
        [{ __resolveType: "Header" }, { __resolveType: "PreFooterBanner" }],
        decofile,
      ),
    ).toBe(2);
  });

  it("returns 0 for an empty page", () => {
    expect(defaultSectionInsertIndex([], decofile)).toBe(0);
  });

  it("stops on a saved block that points to itself", () => {
    expect(
      defaultSectionInsertIndex([{ __resolveType: "Loop" }], {
        Loop: { __resolveType: "Loop" },
      }),
    ).toBe(1);
  });
});
