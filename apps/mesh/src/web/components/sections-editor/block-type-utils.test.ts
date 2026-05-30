import { describe, expect, it } from "bun:test";
import {
  isAutoPreviewBlockKey,
  isManifestSectionResolveType,
  isSavedBlockResolveType,
  parseSavedBlockSchemaTitle,
} from "./block-type-utils";
import type { LiveMeta } from "./resolve-schema";

const meta: LiveMeta = {
  manifest: {
    blocks: {
      sections: {
        "site/sections/Header/Header.tsx": { $ref: "#/definitions/Header" },
      },
      loaders: {
        "vtex/loaders/legacy/productList.ts": {
          $ref: "#/definitions/ProductList",
        },
      },
    },
  },
  schema: {},
};

describe("block-type-utils", () => {
  it("parseSavedBlockSchemaTitle extracts block id and module path", () => {
    expect(
      parseSavedBlockSchemaTitle("#site/sections/Header/Header.tsx@Header"),
    ).toEqual({
      moduleResolveType: "site/sections/Header/Header.tsx",
      blockId: "Header",
    });
  });

  it("isManifestSectionResolveType distinguishes sections from loaders", () => {
    expect(
      isManifestSectionResolveType(meta, "site/sections/Header/Header.tsx"),
    ).toBe(true);
    expect(
      isManifestSectionResolveType(meta, "vtex/loaders/legacy/productList.ts"),
    ).toBe(false);
  });

  it("isSavedBlockResolveType detects block id references", () => {
    expect(isSavedBlockResolveType("Header")).toBe(true);
    expect(isSavedBlockResolveType("site/sections/Header/Header.tsx")).toBe(
      false,
    );
  });

  it("isAutoPreviewBlockKey detects generated preview stubs", () => {
    expect(isAutoPreviewBlockKey("Preview%20%2Fsections%2FFooter.tsx")).toBe(
      true,
    );
    expect(isAutoPreviewBlockKey("Header")).toBe(false);
    expect(isAutoPreviewBlockKey("%")).toBe(false);
  });
});
