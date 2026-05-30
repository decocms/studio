import { describe, expect, it } from "bun:test";
import {
  extractGlobalSections,
  extractPages,
  hasEditableDecoContent,
} from "./page-list";
import type { LiveMeta } from "./resolve-schema";

describe("page-list", () => {
  it("extractPages finds page blocks with paths", () => {
    const decofile = {
      "pages-home-abc123456789": {
        __resolveType: "website/pages/Page.tsx",
        name: "Home",
        path: "/",
      },
      Header: {
        __resolveType: "site/sections/Header.tsx",
      },
    };

    expect(extractPages(decofile)).toEqual([
      { key: "pages-home-abc123456789", name: "Home", path: "/" },
    ]);
  });

  it("extractGlobalSections uses catalog filters for saved blocks", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          sections: {
            "site/sections/Header.tsx": { $ref: "#/definitions/Header" },
            "site/sections/Theme/Theme.tsx": { $ref: "#/definitions/Theme" },
          },
        },
      },
      schema: {},
    };
    const decofile = {
      Header: {
        __resolveType: "site/sections/Header.tsx",
        name: "Site Header",
      },
      "Preview Hero": {
        __resolveType: "site/sections/Hero.tsx",
      },
      "pages-about-abc123456789": {
        __resolveType: "website/pages/Page.tsx",
        path: "/about",
      },
    };

    const sections = extractGlobalSections(decofile, meta);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toEqual({
      key: "Header",
      name: "Site Header",
      resolveType: "site/sections/Header.tsx",
    });
  });

  it("hasEditableDecoContent is true when pages exist", () => {
    expect(
      hasEditableDecoContent(
        {
          "pages-home-abc123456789": {
            __resolveType: "website/pages/Page.tsx",
            path: "/",
          },
        },
        null,
      ),
    ).toBe(true);
  });

  it("hasEditableDecoContent is true when only global sections exist", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          sections: {
            "site/sections/Header.tsx": { $ref: "#/definitions/Header" },
          },
        },
      },
      schema: {},
    };
    const decofile = {
      Header: { __resolveType: "site/sections/Header.tsx", name: "Header" },
    };
    expect(hasEditableDecoContent(decofile, meta)).toBe(true);
  });

  it("hasEditableDecoContent is false without pages or sections", () => {
    expect(hasEditableDecoContent({}, null)).toBe(false);
    expect(
      hasEditableDecoContent({ Header: { __resolveType: "site/x" } }, null),
    ).toBe(false);
  });
});
