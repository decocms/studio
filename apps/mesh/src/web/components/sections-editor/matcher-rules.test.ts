import { describe, expect, it } from "bun:test";
import {
  buildMatcherBlockData,
  buildMatcherBlockReference,
  getSavedMatcherBlockKey,
  inlineMatcherRule,
  isSavedMatcherBlockReference,
  listSavedMatcherBlocks,
  readMatcherRuleFormState,
  resolveEffectiveMatcherRule,
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
    Header: {
      __resolveType: "site/sections/Header.tsx",
      title: "Header",
    },
    "pages-home-abc123": {
      __resolveType: "website/pages/Page.tsx",
      path: "/",
      name: "Home",
    },
  };

  it("lists only saved matcher blocks (globals), excluding sections and pages", () => {
    expect(listSavedMatcherBlocks(null, decofile)).toEqual([
      {
        blockKey: "MobilePromo",
        matcherResolveType: "website/matchers/device.ts",
        name: "Mobile Promo",
      },
    ]);
  });

  it("sorts saved matcher blocks by display name", () => {
    const result = listSavedMatcherBlocks(null, {
      Zeta: { __resolveType: "website/matchers/random.ts", name: "Alpha rule" },
      Alpha: { __resolveType: "website/matchers/random.ts", name: "Zeta rule" },
    });
    expect(result.map((b) => b.blockKey)).toEqual(["Zeta", "Alpha"]);
  });

  it("falls back to blockKey for name and sort when name is absent", () => {
    const result = listSavedMatcherBlocks(null, {
      Bravo: { __resolveType: "website/matchers/random.ts" },
      Alpha: { __resolveType: "website/matchers/random.ts" },
    });
    expect(result).toEqual([
      {
        blockKey: "Alpha",
        matcherResolveType: "website/matchers/random.ts",
        name: undefined,
      },
      {
        blockKey: "Bravo",
        matcherResolveType: "website/matchers/random.ts",
        name: undefined,
      },
    ]);
  });

  it("excludes auto-generated preview stubs", () => {
    expect(
      listSavedMatcherBlocks(null, {
        "Preview MobilePromo": {
          __resolveType: "website/matchers/device.ts",
          mobile: true,
        },
      }),
    ).toEqual([]);
  });

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

  it("rejects section and page keys masquerading as matcher refs", () => {
    expect(
      isSavedMatcherBlockReference({ __resolveType: "Header" }, decofile),
    ).toBe(false);
    expect(
      isSavedMatcherBlockReference(
        { __resolveType: "pages-home-abc123" },
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

  it("reads matcher form state for inline and saved refs", () => {
    expect(
      readMatcherRuleFormState(
        { __resolveType: "website/matchers/device.ts", mobile: true },
        decofile,
      ),
    ).toEqual({
      resolveType: "website/matchers/device.ts",
      formValue: { mobile: true },
    });

    expect(
      readMatcherRuleFormState({ __resolveType: "MobilePromo" }, decofile),
    ).toEqual({
      resolveType: "website/matchers/device.ts",
      formValue: { mobile: true },
    });
  });

  it("resolves effective matcher rules", () => {
    expect(
      resolveEffectiveMatcherRule({ __resolveType: "MobilePromo" }, decofile),
    ).toEqual({
      __resolveType: "website/matchers/device.ts",
      mobile: true,
    });
  });

  it("returns saved matcher block keys", () => {
    expect(
      getSavedMatcherBlockKey({ __resolveType: "MobilePromo" }, decofile),
    ).toBe("MobilePromo");
    expect(
      getSavedMatcherBlockKey({ __resolveType: "Header" }, decofile),
    ).toBeNull();
  });
});
