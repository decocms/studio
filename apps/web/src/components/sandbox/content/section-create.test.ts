import { describe, expect, test } from "bun:test";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { buildSectionBlockFromCatalogEntry } from "./section-create";

const meta = {
  manifest: {
    blocks: {
      sections: {
        "site/sections/Banner.tsx": {
          type: "object",
          properties: {
            title: { type: "string" },
            show: { type: "boolean", default: true },
          },
        },
      },
    },
  },
} as unknown as LiveMeta;

const entry = {
  resolveType: "site/sections/Banner.tsx",
  title: "Banner",
  previewBlock: "",
  isSavedBlock: false,
};

describe("buildSectionBlockFromCatalogEntry", () => {
  test("writes no defaults without meta", () => {
    const { blockKey, data } = buildSectionBlockFromCatalogEntry(entry, {});
    expect(data).toEqual({
      __resolveType: "site/sections/Banner.tsx",
      name: blockKey,
    });
  });

  test("starts with the section's defaults with meta", () => {
    const { blockKey, data } = buildSectionBlockFromCatalogEntry(
      entry,
      {},
      meta,
    );
    expect(data).toEqual({
      __resolveType: "site/sections/Banner.tsx",
      name: blockKey,
      show: true,
    });
  });
});
