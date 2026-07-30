import { describe, expect, test } from "bun:test";
import {
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

  describe("collision disambiguation (siblings)", () => {
    // An object array with no distinguishing field: every item's label falls
    // back to the item schema title, so all rows collapse to one string. The
    // breadcrumb addresses an item by its label and the transient open-index is
    // wiped whenever the form subtree remounts (formResetKey), so a non-unique
    // label makes every item resolve back to the first one — the "all items
    // show the same content" bug. Positional suffixes keep them addressable.
    const itemSchema: SchemaProperty = {
      type: "object",
      title: "ProductSpecifications",
      properties: { body: { type: "string" } },
    };
    const specs = [{ body: "a" }, { body: "b" }, { body: "c" }];

    test("suffixes the position when the base label collides", () => {
      expect(getArrayItemLabel(specs[0], 0, itemSchema, specs)).toBe(
        "ProductSpecifications 1",
      );
      expect(getArrayItemLabel(specs[2], 2, itemSchema, specs)).toBe(
        "ProductSpecifications 3",
      );
    });

    test("leaves a unique label untouched", () => {
      const mixed = [{ title: "Alpha" }, { title: "Beta" }];
      const schema: SchemaProperty = {
        type: "object",
        properties: { title: { type: "string" } },
      };
      expect(getArrayItemLabel(mixed[0], 0, schema, mixed)).toBe("Alpha");
      expect(getArrayItemLabel(mixed[1], 1, schema, mixed)).toBe("Beta");
    });

    test("only the colliding items get a suffix", () => {
      const mixed = [{ title: "Dup" }, { title: "Unique" }, { title: "Dup" }];
      const schema: SchemaProperty = {
        type: "object",
        properties: { title: { type: "string" } },
      };
      expect(getArrayItemLabel(mixed[0], 0, schema, mixed)).toBe("Dup 1");
      expect(getArrayItemLabel(mixed[1], 1, schema, mixed)).toBe("Unique");
      expect(getArrayItemLabel(mixed[2], 2, schema, mixed)).toBe("Dup 3");
    });

    test("no siblings argument keeps the legacy bare label", () => {
      expect(getArrayItemLabel(specs[1], 1, itemSchema)).toBe(
        "ProductSpecifications",
      );
    });
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
