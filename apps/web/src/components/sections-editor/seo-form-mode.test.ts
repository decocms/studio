import { describe, expect, test } from "bun:test";
import { DEFAULT_SEO_RESOLVE_TYPE } from "./seo-block";
import {
  filterSeoSchema,
  GENERAL_SEO_FIELD_KEYS,
  getSeoFormMode,
  PDP_SEO_FIELD_KEYS,
  PLP_SEO_FIELD_KEYS,
} from "./seo-form-mode";
import type { SchemaProperty } from "./resolve-schema";

const sampleSchema: SchemaProperty = {
  type: "object",
  properties: {
    __resolveType: { type: "string" },
    type: { type: "string", enum: ["website", "article"] },
    title: { type: "string", title: "Title Override" },
    description: { type: "string" },
    canonical: { type: "string" },
    favicon: { type: "string", format: "image-uri" },
    image: { type: "string", format: "image-uri" },
    themeColor: { type: "string", format: "color-input" },
    titleTemplate: { type: "string" },
    jsonLD: { type: "block-ref", title: "Data Source" },
    omitVariants: { type: "boolean", title: "Omit Variants" },
    noIndexing: { type: "boolean" },
    ignoreStructuredData: { type: "boolean" },
    configJsonLD: { type: "object" },
  },
};

describe("getSeoFormMode", () => {
  test("classifies SeoV2 as general", () => {
    expect(getSeoFormMode(DEFAULT_SEO_RESOLVE_TYPE)).toBe("general");
  });

  test("classifies PDP and PLP resolve types", () => {
    expect(getSeoFormMode("commerce/sections/Seo/SeoPDPV2.tsx")).toBe("pdp");
    expect(getSeoFormMode("commerce/sections/Seo/SeoPLPV2.tsx")).toBe("plp");
  });
});

describe("filterSeoSchema", () => {
  test("general keeps only admin base fields", () => {
    const filtered = filterSeoSchema(sampleSchema, DEFAULT_SEO_RESOLVE_TYPE);
    expect(Object.keys(filtered.properties ?? {}).sort()).toEqual(
      [...GENERAL_SEO_FIELD_KEYS].sort(),
    );
  });

  test("pdp keeps commerce PDP fields", () => {
    const filtered = filterSeoSchema(
      sampleSchema,
      "commerce/sections/Seo/SeoPDPV2.tsx",
    );
    expect(Object.keys(filtered.properties ?? {}).sort()).toEqual(
      [...PDP_SEO_FIELD_KEYS].sort(),
    );
  });

  test("plp keeps commerce PLP fields", () => {
    const filtered = filterSeoSchema(
      sampleSchema,
      "commerce/sections/Seo/SeoPLPV2.tsx",
    );
    expect(Object.keys(filtered.properties ?? {}).sort()).toEqual(
      [...PLP_SEO_FIELD_KEYS].sort(),
    );
  });

  test("unknown type returns full schema", () => {
    const filtered = filterSeoSchema(
      sampleSchema,
      "site/sections/Seo/SeoCustom.tsx",
    );
    expect(filtered).toBe(sampleSchema);
  });
});
