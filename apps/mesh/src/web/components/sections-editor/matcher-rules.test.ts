import { describe, expect, it } from "bun:test";
import {
  buildMatcherBlockData,
  buildMatcherBlockReference,
  inlineMatcherRule,
  isSavedMatcherBlockReference,
  resolveVariantRuleLabel,
  unwrapMatcherRule,
} from "./matcher-rules";

describe("matcher-rules", () => {
  const decofile = {
    MobilePromo: {
      __resolveType: "website/matchers/device.ts",
      mobile: true,
      name: "Mobile Promo",
    },
  };

  it("detects saved matcher block references", () => {
    expect(
      isSavedMatcherBlockReference({ __resolveType: "MobilePromo" }, decofile),
    ).toBe(true);
    expect(
      isSavedMatcherBlockReference(
        { __resolveType: "website/matchers/device.ts", mobile: true },
        decofile,
      ),
    ).toBe(false);
  });

  it("unwraps inline and saved matcher rules", () => {
    expect(
      unwrapMatcherRule(
        { __resolveType: "website/matchers/device.ts", mobile: true },
        decofile,
      ),
    ).toEqual({
      resolveType: "website/matchers/device.ts",
      data: { mobile: true },
    });

    expect(
      unwrapMatcherRule({ __resolveType: "MobilePromo" }, decofile),
    ).toEqual({
      resolveType: "website/matchers/device.ts",
      data: { mobile: true },
      blockKey: "MobilePromo",
    });
  });

  it("inlines saved matcher rules for persistence on the page", () => {
    expect(
      inlineMatcherRule({ __resolveType: "MobilePromo" }, decofile),
    ).toEqual({
      __resolveType: "website/matchers/device.ts",
      mobile: true,
    });
  });

  it("labels saved matcher blocks from block name", () => {
    expect(
      resolveVariantRuleLabel(
        { __resolveType: "MobilePromo" },
        decofile,
        () => "Fallback",
      ),
    ).toBe("Mobile Promo");
  });

  it("builds matcher block payloads and references", () => {
    expect(
      buildMatcherBlockData(
        "website/matchers/device.ts",
        { mobile: true },
        "Mobile Promo",
      ),
    ).toEqual({
      __resolveType: "website/matchers/device.ts",
      mobile: true,
      name: "Mobile Promo",
    });
    expect(buildMatcherBlockReference("MobilePromo")).toEqual({
      __resolveType: "MobilePromo",
    });
  });
});
