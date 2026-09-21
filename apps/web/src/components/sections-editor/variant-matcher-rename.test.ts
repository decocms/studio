import { describe, expect, it } from "bun:test";
import { planVariantMatcherRename } from "./variant-matcher-rename";

describe("planVariantMatcherRename", () => {
  const decofile = {
    MobilePromo: {
      __resolveType: "website/matchers/device.ts",
      mobile: true,
      name: "Mobile Promo",
    },
    Header: {
      __resolveType: "site/sections/Header.tsx",
      title: "Header",
    },
  };

  it("promotes an inline matcher to a new named global block", () => {
    const action = planVariantMatcherRename(
      { __resolveType: "website/matchers/random.ts", traffic: 0.5 },
      "Half Traffic",
      decofile,
      null,
    );
    expect(action).toEqual({
      kind: "createBlock",
      blockId: "Half Traffic",
      blockData: {
        __resolveType: "website/matchers/random.ts",
        traffic: 0.5,
        name: "Half Traffic",
      },
      reference: { __resolveType: "Half Traffic" },
    });
  });

  it("rejects a name whose block id collides with an existing decofile key", () => {
    const action = planVariantMatcherRename(
      { __resolveType: "website/matchers/random.ts", traffic: 0.5 },
      "Header",
      decofile,
      null,
    );
    expect(action.kind).toBe("error");
    if (action.kind === "error") {
      expect(action.reason).toBe("invalid-block-id");
      expect(action.message).toBeTruthy();
    }
  });

  it("renames the display name of an already-referenced global block", () => {
    const action = planVariantMatcherRename(
      { __resolveType: "MobilePromo" },
      "Only Mobile",
      decofile,
      null,
    );
    expect(action).toEqual({
      kind: "updateBlock",
      blockKey: "MobilePromo",
      blockData: {
        __resolveType: "website/matchers/device.ts",
        mobile: true,
        name: "Only Mobile",
      },
    });
  });

  it("inlines a referenced global block when the name is cleared", () => {
    const action = planVariantMatcherRename(
      { __resolveType: "MobilePromo" },
      "   ",
      decofile,
      null,
    );
    expect(action).toEqual({
      kind: "inline",
      blockKey: "MobilePromo",
      inlinedRule: {
        __resolveType: "website/matchers/device.ts",
        mobile: true,
      },
    });
  });

  it("is a no-op when clearing the name of an already-inline rule", () => {
    const action = planVariantMatcherRename(
      { __resolveType: "website/matchers/random.ts", traffic: 0.5 },
      "",
      decofile,
      null,
    );
    expect(action).toEqual({ kind: "noop" });
  });

  it("errors when the variant has no matcher rule", () => {
    expect(
      planVariantMatcherRename(undefined, "Whatever", decofile, null),
    ).toEqual({ kind: "error", reason: "no-matcher-rule" });
  });
});
