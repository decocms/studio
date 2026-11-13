import { describe, expect, test } from "bun:test";
import { isBlockBody, isIndexStub, stubNames } from "./block-body";
import { listingOf, type ContentIndex } from "./hosted-content";
import { applyCmsSettingsEdits } from "@/components/sandbox/content/cms-settings";

const settings = {
  __resolveType: "cms-settings",
  telemetry: { enabled: true, metrics: false },
  analytics: { enabled: true, collector: "https://collector.example.test" },
  extra: { preserve: true },
};
const index: ContentIndex = {
  revision: "r1",
  resolvedRef: null,
  sequence: 1,
  draft: {},
  entries: { CMS: { version: "v1", meta: { type: "cms-settings" } } },
};

describe("CMS bodies and listing metadata", () => {
  test("Settings must wait for its body before seeding a form", () => {
    const unloaded = listingOf(index, {}).CMS;
    expect(isIndexStub(unloaded)).toBe(true);
    expect(isBlockBody(unloaded)).toBe(false);
    // Editing a listing entry is the original failure: it carries the marker.
    expect(
      stubNames({
        CMS: applyCmsSettingsEdits(unloaded as Record<string, unknown>, {
          "telemetry.enabled": false,
        }),
      }),
    ).toEqual(["CMS"]);
    const loaded = listingOf(index, { CMS: settings }).CMS;
    expect(isBlockBody(loaded)).toBe(true);
    const edited = applyCmsSettingsEdits(loaded as Record<string, unknown>, {
      "telemetry.enabled": false,
    });
    expect(stubNames({ CMS: edited })).toEqual([]);
    expect(edited).toEqual({
      ...settings,
      telemetry: { ...settings.telemetry, enabled: false },
    });
  });

  test("copied and nested listing entries cannot become persisted blocks", () => {
    const stub = listingOf(index, {}).CMS;
    expect(stubNames({ copy: { ...(stub as object), name: "copy" } })).toEqual([
      "copy",
    ]);
    expect(
      stubNames({ page: { sections: [stub] }, complete: settings }),
    ).toEqual(["page"]);
    expect(isBlockBody({ sections: [stub] })).toBe(false);
  });

  test("absent, invalid and empty bodies stay distinct", () => {
    for (const value of [null, undefined, [], "CMS"])
      expect(isBlockBody(value)).toBe(false);
    expect(isBlockBody({})).toBe(true);
    expect(listingOf({ ...index, entries: {} }, {}).CMS).toBeUndefined();
  });
});
