import { describe, expect, test } from "bun:test";
import type { LiveMeta, SchemaProperty } from "./resolve-schema";
import {
  blockRefLoaderConfigHasData,
  detectBlockRefType,
  enrichBlockRefOptions,
  lazyWrappedInner,
  moduleResolveTypeFromBlockData,
  resolveNestedBlockRefSchema,
  schemaWithoutDiscriminator,
  type BlockRefOption,
} from "./block-ref-field-utils";

const SECTION_VARIANTS = "website/flags/multivariate/section.ts";
const THEME_SECTION = "site/sections/Theme/Theme.tsx";

const baseRefs: BlockRefOption[] = [
  {
    resolveType: SECTION_VARIANTS,
    title: "Section Variants",
    schema: {
      type: "object",
      properties: {
        variants: { type: "array", items: { type: "object" } },
      },
    } satisfies SchemaProperty,
  },
  {
    resolveType: "Deco",
    title: "Deco",
    schema: {
      type: "object",
      properties: {
        variants: { type: "array" },
        primary: { type: "string" },
      },
    } satisfies SchemaProperty,
  },
];

describe("detectBlockRefType", () => {
  test("prefers saved block id over property scoring on theme data", () => {
    const themeData = {
      __resolveType: THEME_SECTION,
      variants: [{ value: { primary: "#000" } }],
    };
    expect(detectBlockRefType(themeData, baseRefs, "Deco")).toBe("Deco");
  });

  test("returns saved block id even when it is missing from schema refs", () => {
    const refs = baseRefs.filter((ref) => ref.resolveType !== "Deco");
    const themeData = {
      __resolveType: THEME_SECTION,
      primary: "#000",
    };
    expect(detectBlockRefType(themeData, refs, "Deco")).toBe("Deco");
  });

  test("matches multivariate module type directly", () => {
    const mvData = {
      __resolveType: SECTION_VARIANTS,
      variants: [{ rule: { __resolveType: "website/matchers/always.ts" } }],
    };
    expect(detectBlockRefType(mvData, baseRefs)).toBe(SECTION_VARIANTS);
  });

  test("prefers module resolve type over multivariate property scoring", () => {
    const refs = baseRefs.filter((ref) => ref.resolveType !== "Deco");
    const themeData = {
      __resolveType: THEME_SECTION,
      variants: [{ value: { primary: "#000" } }],
      primary: "#111",
    };
    expect(detectBlockRefType(themeData, refs)).toBe(THEME_SECTION);
  });

  test("matches union branch by hidden type discriminator", () => {
    const cardRefs: BlockRefOption[] = [
      {
        resolveType: "image-card",
        title: "ImageCard",
        discriminatorValue: "image-card",
        schema: {
          type: "object",
          properties: {
            type: { type: "string", default: "image-card" },
            image: { type: "string" },
          },
        } satisfies SchemaProperty,
      },
      {
        resolveType: "text-card",
        title: "TextCard",
        discriminatorValue: "text-card",
        schema: {
          type: "object",
          properties: {
            type: { type: "string", default: "text-card" },
            line1: { type: "object" },
          },
        } satisfies SchemaProperty,
      },
    ];
    expect(
      detectBlockRefType({ type: "image-card", image: { src: "x" } }, cardRefs),
    ).toBe("image-card");
    expect(detectBlockRefType({ type: "text-card", line1: {} }, cardRefs)).toBe(
      "text-card",
    );
  });

  test("prefers __resolveType over type discriminator", () => {
    const cardRefs: BlockRefOption[] = [
      {
        resolveType: "image-card",
        title: "ImageCard",
        discriminatorValue: "image-card",
        schema: {
          type: "object",
          properties: {
            type: { type: "string", default: "image-card" },
            image: { type: "string" },
          },
        } satisfies SchemaProperty,
      },
      {
        resolveType: "text-card",
        title: "TextCard",
        discriminatorValue: "text-card",
        schema: {
          type: "object",
          properties: {
            type: { type: "string", default: "text-card" },
            line1: { type: "object" },
          },
        } satisfies SchemaProperty,
      },
    ];
    expect(
      detectBlockRefType(
        {
          __resolveType: "image-card",
          type: "text-card",
          line1: {},
        },
        cardRefs,
      ),
    ).toBe("image-card");
  });
});

describe("enrichBlockRefOptions", () => {
  test("adds saved block and module resolve type options", () => {
    const refs = enrichBlockRefOptions(
      baseRefs.filter((ref) => ref.resolveType !== "Deco"),
      {
        savedBlockKey: "Deco",
        editorValue: {
          __resolveType: THEME_SECTION,
          primary: "#000",
        },
      },
    );

    expect(refs.map((ref) => ref.resolveType)).toEqual([
      SECTION_VARIANTS,
      "Deco",
      THEME_SECTION,
    ]);
  });
});

describe("resolveNestedBlockRefSchema", () => {
  const meta: LiveMeta = {
    manifest: {
      blocks: {
        flags: {
          [SECTION_VARIANTS]: { $ref: "#/definitions/MvSection" },
        },
        sections: {
          [THEME_SECTION]: { $ref: "#/definitions/Theme" },
        },
      },
    },
    schema: {
      definitions: {
        MvSection: {
          type: "object",
          properties: {
            variants: { type: "array", title: "Variants" },
          },
        },
        Theme: {
          type: "object",
          properties: {
            primary: { type: "string", title: "Primary" },
          },
        },
      },
    },
  };

  test("loads schema from saved block module type, not anyOf stub", () => {
    const resolved = resolveNestedBlockRefSchema(
      {
        __resolveType: SECTION_VARIANTS,
        variants: [],
      },
      meta,
      baseRefs[0]?.schema,
    );
    expect(resolved?.properties?.variants?.title).toBe("Variants");
  });

  test("unwraps lazy wrapper for schema lookup", () => {
    const resolved = resolveNestedBlockRefSchema(
      {
        __resolveType: "website/sections/Rendering/Lazy.tsx",
        section: { __resolveType: THEME_SECTION, primary: "blue" },
      },
      meta,
    );
    expect(resolved?.properties?.primary?.title).toBe("Primary");
  });

  test("does not fall back to anyOf stub when live meta is missing", () => {
    const resolved = resolveNestedBlockRefSchema(
      { __resolveType: THEME_SECTION, primary: "blue" },
      undefined,
      baseRefs[0]?.schema,
    );
    expect(resolved).toBeNull();
  });
});

describe("moduleResolveTypeFromBlockData", () => {
  test("returns inner section from lazy wrapper", () => {
    expect(
      moduleResolveTypeFromBlockData({
        __resolveType: "website/sections/Rendering/Lazy.tsx",
        section: { __resolveType: THEME_SECTION },
      }),
    ).toBe(THEME_SECTION);
  });
});

describe("schemaWithoutDiscriminator", () => {
  test("removes discriminator property from nested schema", () => {
    const schema = {
      type: "object",
      properties: {
        type: { type: "string", default: "image-card" },
        image: { type: "string" },
      },
    } satisfies SchemaProperty;
    const stripped = schemaWithoutDiscriminator(schema, "type");
    expect(stripped?.properties?.type).toBeUndefined();
    expect(stripped?.properties?.image).toBeDefined();
  });
});

describe("blockRefLoaderConfigHasData", () => {
  test("returns true when editing a saved block pointer", () => {
    expect(blockRefLoaderConfigHasData({}, "Deco")).toBe(true);
  });

  test("returns false for empty object values", () => {
    expect(blockRefLoaderConfigHasData({})).toBe(false);
  });

  test("returns true when multivariate flag has variants", () => {
    expect(
      blockRefLoaderConfigHasData({
        __resolveType: SECTION_VARIANTS,
        variants: [{ value: [] }],
      }),
    ).toBe(true);
  });
});

describe("lazyWrappedInner", () => {
  const LAZY = "website/sections/Rendering/Lazy.tsx";

  test("returns the inner section for a Lazy-wrapped value (so the form binds real props)", () => {
    const wrapper = {
      __resolveType: LAZY,
      section: {
        __resolveType: "site/sections/Content/BannerCarrouselDepartment.tsx",
        carrousels: [{ matcher: "/x" }],
        title: "T",
      },
    };
    const inner = lazyWrappedInner(wrapper);
    expect(inner?.["title"]).toBe("T");
    expect(Array.isArray(inner?.["carrousels"])).toBe(true);
  });

  test("returns null for non-Lazy block-ref values", () => {
    expect(
      lazyWrappedInner({
        __resolveType: "site/sections/Content/BannerCarrouselDepartment.tsx",
        carrousels: [],
      }),
    ).toBeNull();
  });

  test("returns null when there is no inner section object", () => {
    expect(lazyWrappedInner({ __resolveType: LAZY })).toBeNull();
    expect(lazyWrappedInner({ __resolveType: LAZY, section: "x" })).toBeNull();
    expect(lazyWrappedInner(null)).toBeNull();
    expect(lazyWrappedInner([])).toBeNull();
  });
});
