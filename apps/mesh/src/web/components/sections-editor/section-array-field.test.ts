import { describe, expect, test } from "bun:test";
import type { SchemaProperty } from "./resolve-schema";
import { isSectionArrayField } from "./section-array-field";
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
