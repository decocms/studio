import { describe, expect, test } from "bun:test";
import type {
  LiveMeta,
  SchemaProperty,
} from "@/components/sections-editor/resolve-schema";
import {
  applySchemaExcludeFields,
  hasEditableAppEditorSchema,
} from "./app-editor-schema";

describe("applySchemaExcludeFields", () => {
  const siteSchema: SchemaProperty = {
    type: "object",
    properties: {
      siteName: { type: "string", title: "Site name" },
      seo: { type: "object", title: "SEO" },
    },
  };

  test("drops excluded fields when other properties remain", () => {
    const result = applySchemaExcludeFields(siteSchema, ["seo"]);
    expect(Object.keys(result?.properties ?? {})).toEqual(["siteName"]);
  });

  test("keeps excluded fields when they are the only editable properties", () => {
    const seoOnly: SchemaProperty = {
      type: "object",
      properties: {
        seo: { type: "object", title: "SEO" },
      },
    };
    const result = applySchemaExcludeFields(seoOnly, ["seo"]);
    expect(Object.keys(result?.properties ?? {})).toEqual(["seo"]);
  });

  test("returns null when base schema is null", () => {
    expect(applySchemaExcludeFields(null, ["seo"])).toBeNull();
  });
});

describe("hasEditableAppEditorSchema", () => {
  const meta: LiveMeta = {
    manifest: {
      blocks: {
        apps: {
          "site/apps/site.ts": { $ref: "#/definitions/SiteApp" },
        },
      },
    },
    schema: {
      definitions: {
        SiteApp: {
          type: "object",
          properties: {
            seo: { type: "object", title: "SEO" },
          },
        },
      },
    },
  };

  test("is true for seo-only site schema when seo is not excluded", () => {
    expect(hasEditableAppEditorSchema("site/apps/site.ts", meta)).toBe(true);
  });

  test("is true for seo-only site schema when excluding seo (fallback)", () => {
    expect(hasEditableAppEditorSchema("site/apps/site.ts", meta, ["seo"])).toBe(
      true,
    );
  });
});
