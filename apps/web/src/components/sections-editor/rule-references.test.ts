import { describe, expect, it } from "bun:test";
import { findSavedMatcherReferences } from "./rule-references";

const builtIn = { $ref: "#/definitions/x", namespace: "deco" };
/** A v8 schema's manifest: built-in matchers by their short names. */
const v8Meta = {
  manifest: {
    blocks: {
      matchers: {
        always: builtIn,
        campaign: builtIn,
        experiment: builtIn,
        and: { $ref: "#/definitions/and", namespace: "site" },
        device: { $ref: "#/definitions/device", namespace: "site" },
      },
      loaders: { multivariate: builtIn, lazy: builtIn },
      content: { "split-traffic": builtIn, calendar: builtIn },
      pages: { page: builtIn },
      sections: { hero: { $ref: "#/definitions/hero", namespace: "site" } },
    },
  },
  schema: {},
};

const lazy = (value: unknown) => ({ __resolveType: "lazy", value });

describe("findSavedMatcherReferences", () => {
  it("lists each use with its variant, skipping the block's own body", () => {
    const decofile = {
      Mobile: { __resolveType: "and", rules: [{ __resolveType: "Mobile" }] },
      home: {
        __resolveType: "page",
        sections: {
          __resolveType: "multivariate",
          variants: [{ rule: { __resolveType: "Mobile" }, value: lazy([]) }],
        },
      },
    };
    expect(findSavedMatcherReferences(decofile, "Mobile", v8Meta)).toEqual([
      {
        blockKey: "home",
        path: ["sections", "variants", 0, "rule"],
        variant: {
          containerPath: ["sections"],
          containerType: "multivariate",
          index: 0,
        },
      },
    ]);
    expect(findSavedMatcherReferences(decofile, "", v8Meta)).toEqual([]);
  });
});
