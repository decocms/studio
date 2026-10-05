import { describe, expect, it } from "bun:test";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { resolveAppEditorSchema } from "./app-editor-schema";
import {
  CMS_SETTINGS_BLOCK_KEY,
  CMS_SETTINGS_RESOLVE_TYPE,
  hasCmsSettingsType,
  readCmsSettingsBlock,
} from "./cms-settings";

/** As `deco schema` writes it: the type in the `content` group. */
const meta: LiveMeta = {
  manifest: {
    blocks: {
      content: {
        seo: { $ref: "#/definitions/c2Vv", namespace: "site" },
        "cms-settings": {
          $ref: "#/definitions/Y21zLXNldHRpbmdz",
          namespace: "deco",
        },
      },
    },
  },
  schema: {
    definitions: {
      Y21zLXNldHRpbmdz: {
        title: "cms-settings",
        type: "object",
        required: ["__resolveType"],
        properties: {
          __resolveType: {
            type: "string",
            enum: ["cms-settings"],
            default: "cms-settings",
          },
          preview: {
            type: "object",
            title: "Preview",
            properties: {
              hosts: {
                type: "array",
                title: "Hosts",
                items: { type: "string" },
              },
            },
          },
          telemetry: {
            type: "object",
            title: "Telemetry",
            properties: {
              enabled: { type: "boolean", title: "Enabled", default: true },
              errorSampleRate: { type: "number", default: 0.05 },
            },
          },
          analytics: {
            type: "object",
            title: "Analytics",
            properties: {
              enabled: { type: "boolean", title: "Enabled", default: true },
            },
          },
        },
      },
    },
  },
};

describe("cms-settings", () => {
  it("is offered only when the schema describes the type", () => {
    expect(hasCmsSettingsType(meta)).toBe(true);
    expect(hasCmsSettingsType(undefined)).toBe(false);
    // Published 8.1.0-next.3: a content group without it.
    expect(
      hasCmsSettingsType({
        manifest: { blocks: { content: { seo: { $ref: "#/x" } } } },
        schema: {},
      }),
    ).toBe(false);
    // A v7 meta.
    expect(
      hasCmsSettingsType({
        manifest: { blocks: { sections: { "site/sections/Hero.tsx": {} } } },
        schema: {},
      }),
    ).toBe(false);
  });

  it("stands in for an absent block with its type only (defaults)", () => {
    expect(readCmsSettingsBlock({})).toEqual({
      kind: "absent",
      block: { __resolveType: CMS_SETTINGS_RESOLVE_TYPE },
    });
    expect(readCmsSettingsBlock({ [CMS_SETTINGS_BLOCK_KEY]: null }).kind).toBe(
      "absent",
    );
  });

  it("edits the saved block as is, variants included", () => {
    const block = {
      __resolveType: "cms-settings",
      preview: { hosts: ["staging.example.com"] },
      telemetry: {
        __resolveType: "multivariate",
        variants: [{ rule: { __resolveType: "always" }, value: {} }],
      },
    };
    expect(readCmsSettingsBlock({ CMS: block })).toEqual({
      kind: "saved",
      block,
    });
  });

  it("does not edit a block named CMS of another type", () => {
    expect(readCmsSettingsBlock({ CMS: { __resolveType: "hero" } })).toEqual({
      kind: "conflict",
      resolveType: "hero",
    });
    expect(readCmsSettingsBlock({ CMS: "text" })).toEqual({
      kind: "conflict",
      resolveType: "",
    });
  });

  it("resolves the form from the schema: the three sections", () => {
    const schema = resolveAppEditorSchema(CMS_SETTINGS_RESOLVE_TYPE, meta);
    expect(Object.keys(schema?.properties ?? {})).toEqual(
      expect.arrayContaining(["preview", "telemetry", "analytics"]),
    );
  });
});
