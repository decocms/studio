import { describe, expect, it } from "bun:test";
import {
  extractSectionCatalog,
  findLivePageResolveType,
  findSiteThemeBlock,
} from "./section-catalog";
import {
  buildGlobalSectionPreviewUrl,
  buildSectionPreviewUrl,
  encodePreviewProps,
} from "./section-preview-url";
import type { LiveMeta } from "./resolve-schema";

describe("section-preview-url", () => {
  it("encodePreviewProps matches admin encodeProps", () => {
    const json = JSON.stringify({ sections: [{ __resolveType: "preview" }] });
    expect(encodePreviewProps(json)).toBe(btoa(encodeURIComponent(json)));
  });

  it("buildSectionPreviewUrl targets live previews with preview block props", () => {
    const url = buildSectionPreviewUrl(
      "https://abc.preview.example.com/current-page",
      "website/pages/Page.tsx",
      "site/sections/Hero.tsx",
    );

    expect(url).toContain("https://abc.preview.example.com/live/previews/");
    expect(url).toContain("website%2Fpages%2FPage.tsx");
    expect(url).toContain("props=");
  });

  it("buildSectionPreviewUrl appends site theme like admin", () => {
    const theme = { __resolveType: "Deco" };
    const url = buildSectionPreviewUrl(
      "https://abc.preview.example.com/",
      "website/pages/Page.tsx",
      "Header",
      theme,
    );
    const propsParam = new URL(url).searchParams.get("props");
    expect(propsParam).toBeTruthy();
    const decoded = JSON.parse(decodeURIComponent(atob(propsParam!))) as {
      sections: unknown[];
    };
    expect(decoded.sections).toHaveLength(2);
    expect(decoded.sections[0]).toEqual({
      __resolveType: "preview",
      block: "Header",
    });
    expect(decoded.sections[1]).toEqual(theme);
  });

  it("buildGlobalSectionPreviewUrl wraps a saved block in page preview props", () => {
    const url = buildGlobalSectionPreviewUrl(
      "https://abc.preview.example.com/",
      "website/pages/Page.tsx",
      "Header",
    );
    expect(url).toContain("/live/previews/website%2Fpages%2FPage.tsx");
    expect(new URL(url).searchParams.get("path")).toBe("/");
    const propsParam = new URL(url).searchParams.get("props");
    expect(propsParam).toBeTruthy();
    const decoded = JSON.parse(decodeURIComponent(atob(propsParam!))) as {
      path: string;
      sections: Array<{ __resolveType: string }>;
    };
    expect(decoded.path).toBe("/");
    expect(decoded.sections).toEqual([{ __resolveType: "Header" }]);
    expect(new URL(url).searchParams.has("__cb")).toBe(true);
  });
});

describe("section-catalog", () => {
  it("findLivePageResolveType prefers manifest page blocks", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          pages: {
            "website/pages/Page.tsx": { $ref: "#/definitions/Page" },
          },
        },
      },
      schema: {},
    };

    expect(findLivePageResolveType(meta)).toBe("website/pages/Page.tsx");
  });

  it("findSiteThemeBlock reads theme from site block", () => {
    expect(
      findSiteThemeBlock({
        site: { theme: { __resolveType: "Deco" } },
      }),
    ).toEqual({ __resolveType: "Deco" });
  });

  it("extractSectionCatalog merges manifest sections, schema refs, and saved blocks", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          pages: {
            "website/pages/Page.tsx": { $ref: "#/definitions/Page" },
          },
          sections: {
            "site/sections/Hero.tsx": { $ref: "#/definitions/Hero" },
            "site/sections/Footer/Footer.tsx": {
              $ref: "#/definitions/FooterSection",
            },
            "site/sections/Header/Header.tsx": {
              $ref: "#/definitions/HeaderSection",
            },
          },
          loaders: {
            "vtex/loaders/legacy/productList.ts": {
              $ref: "#/definitions/ProductList",
            },
          },
        },
      },
      schema: {
        definitions: {
          Page: {
            type: "object",
            properties: {
              sections: {
                type: "array",
                items: {
                  anyOf: [{ $ref: "#/definitions/HeroSection" }],
                },
              },
            },
          },
          HeroSection: {
            allOf: [
              {
                properties: {
                  __resolveType: {
                    enum: ["site/sections/Hero.tsx"],
                  },
                },
              },
            ],
            title: "Hero",
          },
          Hero: {
            title: "Hero",
            description: "Hero section",
          },
          FooterSection: {
            title: "Footer",
          },
        },
      },
    };

    const decofile = {
      Header: {
        __resolveType: "site/sections/Header/Header.tsx",
        title: "Header",
      },
      "Product List Loader": {
        __resolveType: "vtex/loaders/legacy/productList.ts",
      },
      "Preview /sections/Footer.tsx": {
        __resolveType: "site/sections/Footer/Footer.tsx",
      },
      "pages-home": {
        __resolveType: "website/pages/Page.tsx",
        path: "/",
      },
    };

    const catalog = extractSectionCatalog(meta, decofile);
    const resolveTypes = catalog.map((entry) => entry.resolveType);

    expect(resolveTypes).toContain("site/sections/Hero.tsx");
    expect(resolveTypes).toContain("site/sections/Footer/Footer.tsx");
    expect(resolveTypes).toContain("Header");
    expect(resolveTypes).not.toContain("Product List Loader");
    expect(resolveTypes).not.toContain("Preview /sections/Footer.tsx");
  });

  it("extractSectionCatalog includes manifest sections even when page anyOf is populated", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          pages: {
            "website/pages/Page.tsx": { $ref: "#/definitions/Page" },
          },
          sections: {
            "site/sections/Hero.tsx": { $ref: "#/definitions/Hero" },
            "site/sections/Benefits.tsx": { $ref: "#/definitions/Benefits" },
          },
        },
      },
      schema: {
        definitions: {
          Page: {
            type: "object",
            properties: {
              sections: {
                type: "array",
                items: {
                  anyOf: [{ $ref: "#/definitions/HeroSection" }],
                },
              },
            },
          },
          HeroSection: {
            allOf: [
              {
                properties: {
                  __resolveType: {
                    enum: ["site/sections/Hero.tsx"],
                  },
                },
              },
            ],
            title: "Hero",
          },
          Hero: { title: "Hero" },
          Benefits: { title: "Benefits" },
        },
      },
    };

    const catalog = extractSectionCatalog(meta, {});
    expect(catalog.map((entry) => entry.resolveType)).toContain(
      "site/sections/Benefits.tsx",
    );
  });

  it("extractSectionCatalog excludes Theme sections", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          pages: {
            "website/pages/Page.tsx": { $ref: "#/definitions/Page" },
          },
          sections: {
            "site/sections/Theme/Theme.tsx": { $ref: "#/definitions/Theme" },
            "site/sections/Hero.tsx": { $ref: "#/definitions/Hero" },
            "site/sections/Header/Header.tsx": {
              $ref: "#/definitions/HeaderSection",
            },
          },
        },
      },
      schema: { definitions: { Theme: {}, Hero: {}, HeaderSection: {} } },
    };

    const decofile = {
      Deco: { __resolveType: "site/sections/Theme/Theme.tsx" },
      Header: { __resolveType: "site/sections/Header/Header.tsx" },
    };

    const catalog = extractSectionCatalog(meta, decofile);
    const resolveTypes = catalog.map((entry) => entry.resolveType);

    expect(resolveTypes).not.toContain("site/sections/Theme/Theme.tsx");
    expect(resolveTypes).not.toContain("Deco");
    expect(resolveTypes).toContain("site/sections/Hero.tsx");
    expect(resolveTypes).toContain("Header");
  });
});
