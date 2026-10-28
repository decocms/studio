import { describe, expect, it } from "bun:test";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { resolveAppEditorSchema } from "./app-editor-schema";
import {
  applyCmsSettingsEdits,
  CMS_SETTINGS_BLOCK_KEY,
  CMS_SETTINGS_RESOLVE_TYPE,
  cmsSettingsSectionLock,
  hasCmsSettingsType,
  isCollectorUrl,
  isUnchangedCmsSettingsEdit,
  percentToRate,
  rateToPercent,
  readCmsSettingsBlock,
  readCmsSettingsField,
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

describe("the Settings page's values", () => {
  const variants = {
    __resolveType: "multivariate",
    variants: [{ rule: { __resolveType: "always" }, value: false }],
  };

  it("shows a rate as a percentage and stores the percentage as a rate", () => {
    expect(rateToPercent(0.05)).toBe(5);
    expect(rateToPercent(0)).toBe(0);
    expect(rateToPercent(1)).toBe(100);
    expect(rateToPercent(0.001)).toBe(0.1);
    expect(rateToPercent(0.07)).toBe(7);
    expect(percentToRate("5")).toBe(0.05);
    expect(percentToRate("0.1")).toBe(0.001);
    expect(percentToRate("0,5")).toBe(0.005);
    expect(percentToRate("100")).toBe(1);
    expect(percentToRate("0")).toBe(0);
    for (const bad of ["", " ", "-1", "100.1", "abc", "Infinity"]) {
      expect(percentToRate(bad)).toBeNull();
    }
    // Round trip.
    for (const rate of [0, 0.05, 0.123, 0.5, 1]) {
      expect(percentToRate(String(rateToPercent(rate)))).toBe(rate);
    }
  });

  it("shows each field's default when the block leaves it out", () => {
    const absent = { __resolveType: CMS_SETTINGS_RESOLVE_TYPE };
    expect(readCmsSettingsField(absent, "telemetry.enabled")).toEqual({
      kind: "value",
      value: true,
      isDefault: true,
    });
    expect(readCmsSettingsField(absent, "telemetry.metrics")).toMatchObject({
      value: true,
    });
    expect(
      readCmsSettingsField(absent, "telemetry.errorSampleRate"),
    ).toMatchObject({ value: 0.05, isDefault: true });
    expect(
      readCmsSettingsField(absent, "telemetry.traceSampleRate"),
    ).toMatchObject({ value: 0, isDefault: true });
    expect(readCmsSettingsField(absent, "analytics.enabled")).toMatchObject({
      value: true,
    });
    expect(readCmsSettingsField(absent, "analytics.collector")).toMatchObject({
      value: "",
      isDefault: true,
    });
    // A saved value wins.
    expect(
      readCmsSettingsField(
        { telemetry: { errorSampleRate: 0.2 } },
        "telemetry.errorSampleRate",
      ),
    ).toEqual({ kind: "value", value: 0.2, isDefault: false });
  });

  it("writes only the changed fields, every other key as saved", () => {
    const block = {
      __resolveType: "cms-settings",
      preview: { hosts: ["staging.example.com"] },
      custom: { kept: true },
      telemetry: { traceSampleRate: 0.01, extra: "kept" },
    };
    const before = structuredClone(block);
    const next = applyCmsSettingsEdits(block, {
      "telemetry.errorSampleRate": 0.1,
    });
    expect(next).toEqual({
      __resolveType: "cms-settings",
      preview: { hosts: ["staging.example.com"] },
      custom: { kept: true },
      telemetry: { traceSampleRate: 0.01, extra: "kept", errorSampleRate: 0.1 },
    });
    // No defaults written, no section it didn't touch, input untouched.
    expect(next.analytics).toBeUndefined();
    expect(block).toEqual(before);
  });

  it("creates the block from nothing with only what was changed", () => {
    const absent = { __resolveType: CMS_SETTINGS_RESOLVE_TYPE };
    expect(
      applyCmsSettingsEdits(absent, { "analytics.enabled": false }),
    ).toEqual({
      __resolveType: "cms-settings",
      analytics: { enabled: false },
    });
  });

  it("removes a field whose edit is undefined (an emptied collector)", () => {
    expect(
      applyCmsSettingsEdits(
        {
          __resolveType: "cms-settings",
          analytics: { collector: "https://c.example.com", enabled: true },
        },
        { "analytics.collector": undefined },
      ),
    ).toEqual({ __resolveType: "cms-settings", analytics: { enabled: true } });
  });

  it("never overwrites a field or section set with variants", () => {
    const block = {
      __resolveType: "cms-settings",
      telemetry: variants,
      analytics: { enabled: variants, collector: "https://c.example.com" },
    };
    expect(cmsSettingsSectionLock(block, "telemetry")).toBe("variants");
    expect(cmsSettingsSectionLock(block, "analytics")).toBeNull();
    expect(readCmsSettingsField(block, "telemetry.metrics")).toEqual({
      kind: "locked",
      reason: "variants",
    });
    expect(readCmsSettingsField(block, "analytics.enabled")).toEqual({
      kind: "locked",
      reason: "variants",
    });
    expect(readCmsSettingsField(block, "analytics.collector")).toMatchObject({
      kind: "value",
      value: "https://c.example.com",
    });
    const next = applyCmsSettingsEdits(block, {
      "telemetry.enabled": false,
      "telemetry.errorSampleRate": 0.5,
      "analytics.enabled": false,
      "analytics.collector": "https://d.example.com",
    });
    expect(next.telemetry).toEqual(variants);
    expect(next.analytics).toEqual({
      enabled: variants,
      collector: "https://d.example.com",
    });
  });

  it("leaves a value of another kind to the block form", () => {
    const block = { telemetry: { errorSampleRate: "high" }, analytics: "x" };
    expect(readCmsSettingsField(block, "telemetry.errorSampleRate")).toEqual({
      kind: "locked",
      reason: "other",
    });
    expect(readCmsSettingsField(block, "analytics.enabled")).toEqual({
      kind: "locked",
      reason: "other",
    });
    const next = applyCmsSettingsEdits(block, {
      "telemetry.errorSampleRate": 0.1,
      "analytics.enabled": true,
    });
    expect(next.telemetry).toEqual({ errorSampleRate: "high" });
    expect(next.analytics).toBe("x");
  });

  it("ignores an edit of the wrong kind", () => {
    expect(applyCmsSettingsEdits({}, { "telemetry.enabled": "yes" })).toEqual({
      __resolveType: "cms-settings",
    });
  });

  it("accepts an empty collector or an http(s) address", () => {
    expect(isCollectorUrl("")).toBe(true);
    expect(isCollectorUrl("https://collector.example.com/e")).toBe(true);
    expect(isCollectorUrl("http://localhost:8080")).toBe(true);
    expect(isCollectorUrl("collector.example.com")).toBe(false);
    expect(isCollectorUrl("ftp://x.example.com")).toBe(false);
  });

  it("removes nothing that isn't there: no empty section", () => {
    const block = { __resolveType: "cms-settings" };
    expect(
      applyCmsSettingsEdits(block, { "analytics.collector": undefined }),
    ).toEqual({ __resolveType: "cms-settings" });
    expect(
      applyCmsSettingsEdits(
        { ...block, analytics: { enabled: false } },
        { "analytics.collector": undefined },
      ),
    ).toEqual({ ...block, analytics: { enabled: false } });
    expect(
      applyCmsSettingsEdits(
        { ...block, analytics: { collector: "https://c.example.com" } },
        { "analytics.collector": undefined },
      ),
    ).toEqual({ ...block, analytics: {} });
  });

  it("knows an edit back to what is saved, a left-out field at its default", () => {
    const absent = { __resolveType: "cms-settings" };
    expect(isUnchangedCmsSettingsEdit(absent, "telemetry.enabled", true)).toBe(
      true,
    );
    expect(isUnchangedCmsSettingsEdit(absent, "telemetry.enabled", false)).toBe(
      false,
    );
    expect(
      isUnchangedCmsSettingsEdit(absent, "analytics.collector", undefined),
    ).toBe(true);
    expect(
      isUnchangedCmsSettingsEdit(absent, "telemetry.errorSampleRate", 0.05),
    ).toBe(true);
    const saved = {
      ...absent,
      analytics: { collector: "https://c.example.com" },
    };
    expect(
      isUnchangedCmsSettingsEdit(saved, "analytics.collector", undefined),
    ).toBe(false);
    const variants = { telemetry: { __resolveType: "multivariate" } };
    expect(
      isUnchangedCmsSettingsEdit(variants, "telemetry.enabled", true),
    ).toBe(false);
  });
});
