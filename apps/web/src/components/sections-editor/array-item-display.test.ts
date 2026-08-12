import { describe, expect, test } from "bun:test";
import {
  getArrayItemDisplayLabels,
  getArrayItemImageSrc,
  getArrayItemLabel,
  renderMustacheTemplate,
} from "./array-item-display";
import type { SchemaProperty } from "./resolve-schema";

describe("getArrayItemLabel", () => {
  test("uses titleBy field for plain keys", () => {
    const item = { alt: "Summer sale" };
    const schema: SchemaProperty = { type: "object", titleBy: "alt" };
    expect(getArrayItemLabel(item, 0, schema)).toBe("Summer sale");
  });

  test("renders titleBy mustache templates", () => {
    const item = { matcher: ["/feminino/*", "/novidades"] };
    const schema: SchemaProperty = {
      type: "object",
      titleBy: "{{{matcher}}}",
    };
    expect(getArrayItemLabel(item, 0, schema)).toBe("/feminino/*,/novidades");
  });

  test("falls back to schema title mustache", () => {
    const item = { headline: "Hero", price: 10 };
    const schema: SchemaProperty = {
      type: "object",
      title: "{{headline}} - {{price}}",
    };
    expect(getArrayItemLabel(item, 0, schema)).toBe("Hero - 10");
  });

  test("prefers resolveType over static schema title", () => {
    const item = {
      __resolveType:
        "https://cdn.jsdelivr.net/gh/deco-cx/apps@0.151.1/website/flags/audience.ts",
    };
    const schema: SchemaProperty = { type: "object", title: "Routes" };
    expect(getArrayItemLabel(item, 0, schema)).toBe("Audience");
  });

  test("falls through whitespace-only title to the section name", () => {
    // Real bagaggio data: nested section with title " " (a single space).
    const item = {
      __resolveType: "site/sections/Content/BannerCarrouselDepartment.tsx",
      layout: { numberOfSliders: { mobile: 3, desktop: 6 } },
      title: " ",
    };
    expect(getArrayItemLabel(item, 0, undefined)).toBe(
      "BannerCarrouselDepartment",
    );
  });

  test("strips HTML from rich-text title fields", () => {
    const item = {
      matcher: "/garantia-vitalicia",
      title:
        '<h1 style="text-align: start"><span style="font-size: 38pt">Garantia Vitalícia</span></h1>',
      description: "<p>Obtenha tranquilidade...</p>",
    };
    const schema: SchemaProperty = {
      type: "object",
      properties: {
        matcher: { type: "string" },
        title: { type: "string", format: "rich-text" },
        description: { type: "string", format: "rich-text" },
      },
    };
    expect(getArrayItemLabel(item, 0, schema)).toBe("Garantia Vitalícia");
  });

  test("falls through empty rich-text to next key", () => {
    const item = { title: "<p></p>", name: "Fallback" };
    const schema: SchemaProperty = {
      type: "object",
      properties: {
        title: { type: "string", format: "rich-text" },
        name: { type: "string" },
      },
    };
    expect(getArrayItemLabel(item, 0, schema)).toBe("Fallback");
  });

  test("labels Lazy-wrapped item by its inner section name", () => {
    const item = {
      __resolveType: "website/sections/Rendering/Lazy.tsx",
      section: {
        __resolveType: "site/sections/Content/BannerCarrouselDepartment.tsx",
      },
    };
    expect(getArrayItemLabel(item, 0, undefined)).toBe(
      "BannerCarrouselDepartment",
    );
  });

  // Inline unions carry a per-branch Mustache title, resolved against branch data.
  const matcherUnionSchema: SchemaProperty = {
    type: "inline-union",
    inlineUnionBranches: [
      {
        title: "Categoria {{{id}}}",
        discriminators: { matcherType: "category" },
        schema: {
          type: "object",
          properties: {
            matcherType: { type: "string" },
            id: { type: "string" },
          },
        },
      },
      {
        title: "Cluster {{{value}}}",
        discriminators: { matcherType: "cluster" },
        schema: {
          type: "object",
          properties: {
            matcherType: { type: "string" },
            value: { type: "string" },
          },
        },
      },
    ],
  };

  test("labels an inline-union item by its active branch (discriminator match)", () => {
    expect(
      getArrayItemLabel(
        { matcherType: "category", id: "123" },
        0,
        matcherUnionSchema,
      ),
    ).toBe("Categoria 123");
    expect(
      getArrayItemLabel(
        { matcherType: "cluster", value: "45" },
        1,
        matcherUnionSchema,
      ),
    ).toBe("Cluster 45");
  });

  test("keeps the static branch prefix when Mustache fields are empty", () => {
    expect(
      getArrayItemLabel({ matcherType: "category" }, 0, matcherUnionSchema),
    ).toBe("Categoria");
  });

  test("falls back past a purely-Mustache branch title with empty data", () => {
    const schema: SchemaProperty = {
      type: "inline-union",
      inlineUnionBranches: [
        {
          title: "{{{value}}}",
          discriminators: { matcherType: "cluster" },
          schema: {
            type: "object",
            properties: {
              matcherType: { type: "string" },
              value: { type: "string" },
            },
          },
        },
      ],
    };
    expect(getArrayItemLabel({ matcherType: "cluster" }, 2, schema)).toBe(
      "Item 3",
    );
  });

  test("infers the branch by field presence when no discriminator matches", () => {
    const schema: SchemaProperty = {
      type: "inline-union",
      inlineUnionBranches: [
        {
          title: "Período {{{start}}}",
          schema: {
            type: "object",
            properties: { start: { type: "string" }, end: { type: "string" } },
          },
        },
        {
          title: "Produto {{{value}}}",
          schema: {
            type: "object",
            properties: { value: { type: "string" } },
          },
        },
      ],
    };
    expect(getArrayItemLabel({ value: "prod-9" }, 0, schema)).toBe(
      "Produto prod-9",
    );
  });

  test("colliding inline-union items share a clean label (no positional suffix)", () => {
    const items = [
      { matcherType: "category", id: "10" },
      { matcherType: "category", id: "10" },
    ];
    expect(getArrayItemDisplayLabels(items, matcherUnionSchema)).toEqual([
      "Categoria 10",
      "Categoria 10",
    ]);
  });

  test("colliding items keep an identical base label (no positional suffix)", () => {
    // Items with no distinguishing field share a label — intentional: the
    // breadcrumb addresses an item by index (Crumb.itemIndex), never by a unique
    // label, so no positional " N" suffix is added.
    const itemSchema: SchemaProperty = {
      type: "object",
      title: "ProductSpecifications",
      properties: { body: { type: "string" } },
    };
    const specs = [{ body: "a" }, { body: "b" }];
    expect(getArrayItemLabel(specs[0], 0, itemSchema)).toBe(
      "ProductSpecifications",
    );
    expect(getArrayItemLabel(specs[1], 1, itemSchema)).toBe(
      "ProductSpecifications",
    );
  });
});

describe("getArrayItemDisplayLabels (no positional suffix)", () => {
  const schema: SchemaProperty = {
    type: "object",
    properties: { name: { type: "string" } },
  };

  test("keeps colliding base labels un-suffixed (display only)", () => {
    const items = [
      { name: "Cozinha – Festival da CASA" },
      { name: "Cozinha – Festival da CASA" },
    ];
    // getArrayItemLabels would return "... 1"/"... 2"; the display variant must not.
    expect(getArrayItemDisplayLabels(items, schema)).toEqual([
      "Cozinha – Festival da CASA",
      "Cozinha – Festival da CASA",
    ]);
  });

  test("still resolves distinct base labels", () => {
    const items = [{ name: "Alpha" }, { name: "Beta" }];
    expect(getArrayItemDisplayLabels(items, schema)).toEqual(["Alpha", "Beta"]);
  });
});

describe("getArrayItemImageSrc", () => {
  test("renders @image mustache from schema", () => {
    const item = {
      image: {
        mobile: "https://example.com/mobile.jpg",
        desktop: "https://example.com/desktop.jpg",
      },
    };
    const schema: SchemaProperty = {
      type: "object",
      image: "{{{image.mobile}}}",
    };
    expect(getArrayItemImageSrc(item, schema)).toBe(
      "https://example.com/mobile.jpg",
    );
  });

  test("rejects non-https rendered URLs", () => {
    const item = {
      image: { mobile: "http://example.com/mobile.jpg" },
    };
    const schema: SchemaProperty = {
      type: "object",
      image: "{{{image.mobile}}}",
    };
    expect(getArrayItemImageSrc(item, schema)).toBeUndefined();
  });

  test("defaults to image.mobile when image is a nested object", () => {
    const item = {
      image: {
        mobile: "https://example.com/mobile.jpg",
      },
    };
    const schema: SchemaProperty = {
      type: "object",
      properties: {
        image: {
          type: "object",
          properties: {
            mobile: { type: "string", format: "image-uri" },
            desktop: { type: "string", format: "image-uri" },
          },
        },
      },
    };
    expect(getArrayItemImageSrc(item, schema)).toBe(
      "https://example.com/mobile.jpg",
    );
  });
});

describe("renderMustacheTemplate", () => {
  test("supports dot paths", () => {
    expect(
      renderMustacheTemplate("{{{image.mobile}}}", {
        image: { mobile: "https://example.com/a.jpg" },
      }),
    ).toBe("https://example.com/a.jpg");
  });

  test("supports array indices in dot paths", () => {
    expect(
      renderMustacheTemplate("{{{banners.0.desktop.image}}}", {
        banners: [{ desktop: { image: "https://example.com/a.jpg" } }],
      }),
    ).toBe("https://example.com/a.jpg");
  });
});
