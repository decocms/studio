import { describe, expect, test } from "bun:test";
import type { SchemaProperty } from "./resolve-schema";
import {
  isSectionArrayField,
  isSectionBlockRefField,
} from "./section-array-field";
import { PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE } from "./section-types";

describe("isSectionArrayField", () => {
  test("detects global/page section arrays", () => {
    expect(
      isSectionArrayField({
        type: "array",
        items: {
          type: "block-ref",
          anyOfRefs: [
            { resolveType: "site/sections/Analytics.tsx", title: "Analytics" },
          ],
        },
      } as SchemaProperty),
    ).toBe(true);
  });

  test("detects page multivariate section array fields", () => {
    expect(
      isSectionArrayField({
        type: "block-ref",
        anyOfRefs: [
          {
            resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
            title: "Page Variants",
            schema: {
              type: "object",
              properties: {
                variants: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      value: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
          },
        ],
      } as SchemaProperty),
    ).toBe(true);
  });

  test("ignores config flag arrays", () => {
    expect(
      isSectionArrayField({
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", title: "Name" },
            text: { type: "string", title: "Text" },
          },
        },
      } as SchemaProperty),
    ).toBe(false);
  });

  test("detects global field by key even when items are plain objects", () => {
    expect(
      isSectionArrayField(
        {
          type: "array",
          items: { type: "object", properties: {} },
        } as SchemaProperty,
        "global",
      ),
    ).toBe(true);
  });

  test("detects sections field by key", () => {
    expect(
      isSectionArrayField(
        {
          type: "array",
          items: { type: "object" },
        } as SchemaProperty,
        "sections",
      ),
    ).toBe(true);
  });
});

describe("isSectionBlockRefField", () => {
  // The shape deco emits for a `Section`-typed prop: the multivariate branch
  // plus whichever saved blocks it happened to name (here, all multivariate).
  const countdownSection: SchemaProperty = {
    type: "block-ref",
    anyOfRefs: [
      {
        resolveType: "website/flags/multivariate/section.ts",
        title: "website/flags/multivariate/section.ts",
      },
      { resolveType: "Alerta", title: "Alerta" },
      {
        resolveType: "carrossel quadrado vestidos",
        title: "carrossel quadrado vestidos",
      },
    ],
  };

  test("a Section slot is one, however few branches the schema names", () => {
    expect(isSectionBlockRefField(countdownSection)).toBe(true);
  });

  test("a module-typed section ref is one", () => {
    expect(
      isSectionBlockRefField({
        type: "block-ref",
        anyOfRefs: [
          {
            resolveType: "site/sections/Images/BannerCollection.tsx",
            title: "site/sections/Images/BannerCollection.tsx",
          },
        ],
      }),
    ).toBe(true);
  });

  test("a loader union is not", () => {
    expect(
      isSectionBlockRefField({
        type: "block-ref",
        anyOfRefs: [
          {
            resolveType: "vtex/loaders/product/list.ts",
            title: "vtex/loaders/product/list.ts",
          },
          {
            resolveType: "shopify/loaders/product/list.ts",
            title: "shopify/loaders/product/list.ts",
          },
        ],
      }),
    ).toBe(false);
  });

  test("an array of sections is not a slot — that is the array field's job", () => {
    expect(
      isSectionBlockRefField({
        type: "array",
        items: {
          type: "block-ref",
          anyOfRefs: [
            {
              resolveType: "site/sections/Foo.tsx",
              title: "site/sections/Foo.tsx",
            },
          ],
        },
      }),
    ).toBe(false);
  });
});
