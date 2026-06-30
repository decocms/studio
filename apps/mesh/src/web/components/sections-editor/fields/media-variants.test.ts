import { describe, expect, test } from "bun:test";
import {
  appendMediaVariant,
  deleteMediaVariant,
  duplicateMediaVariant,
  flattenMediaMultivariate,
  isMediaMultivariateWrapper,
  parseMediaVariants,
  reorderMediaVariant,
  updateMediaVariantRule,
  updateMediaVariantValue,
  wrapAsMediaMultivariate,
  type MediaMultivariateWrapper,
} from "./media-variants";

const RESOLVE_TYPE = "website/flags/multivariate/image.ts";
const ALWAYS_RT = "website/matchers/always.ts";

function makeWrapper(urls: string[]): MediaMultivariateWrapper {
  return {
    __resolveType: RESOLVE_TYPE,
    variants: urls.map((url) => ({
      rule: { __resolveType: ALWAYS_RT },
      value: url,
    })),
  };
}

describe("isMediaMultivariateWrapper", () => {
  test("returns true for valid wrapper", () => {
    expect(isMediaMultivariateWrapper(makeWrapper(["a.png"]))).toBe(true);
  });

  test("returns false for plain string", () => {
    expect(isMediaMultivariateWrapper("https://img.png")).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(isMediaMultivariateWrapper(null)).toBe(false);
    expect(isMediaMultivariateWrapper(undefined)).toBe(false);
  });

  test("returns false for object without variants", () => {
    expect(isMediaMultivariateWrapper({ __resolveType: RESOLVE_TYPE })).toBe(
      false,
    );
  });
});

describe("wrapAsMediaMultivariate / flattenMediaMultivariate round-trip", () => {
  test("wraps a URL and flattens back to the same URL", () => {
    const url = "https://example.com/image.png";
    const wrapped = wrapAsMediaMultivariate(url, RESOLVE_TYPE);
    expect(wrapped.__resolveType).toBe(RESOLVE_TYPE);
    expect(wrapped.variants).toHaveLength(2);
    expect(flattenMediaMultivariate(wrapped)).toBe(url);
  });

  test("wraps an empty URL", () => {
    const wrapped = wrapAsMediaMultivariate("", RESOLVE_TYPE);
    expect(flattenMediaMultivariate(wrapped)).toBe("");
  });
});

describe("flattenMediaMultivariate", () => {
  test("picks the always variant", () => {
    const wrapper: MediaMultivariateWrapper = {
      __resolveType: RESOLVE_TYPE,
      variants: [
        {
          rule: { __resolveType: "website/matchers/device.ts" },
          value: "mobile.png",
        },
        { rule: { __resolveType: ALWAYS_RT }, value: "default.png" },
      ],
    };
    expect(flattenMediaMultivariate(wrapper)).toBe("default.png");
  });

  test("picks the last variant when no always variant", () => {
    const wrapper: MediaMultivariateWrapper = {
      __resolveType: RESOLVE_TYPE,
      variants: [
        {
          rule: { __resolveType: "website/matchers/device.ts" },
          value: "mobile.png",
        },
        {
          rule: { __resolveType: "website/matchers/device.ts" },
          value: "desktop.png",
        },
      ],
    };
    expect(flattenMediaMultivariate(wrapper)).toBe("desktop.png");
  });

  test("returns empty string for empty variants", () => {
    const wrapper: MediaMultivariateWrapper = {
      __resolveType: RESOLVE_TYPE,
      variants: [],
    };
    expect(flattenMediaMultivariate(wrapper)).toBe("");
  });
});

describe("parseMediaVariants", () => {
  test("extracts variants with rules and values", () => {
    const wrapper = makeWrapper(["a.png", "b.png"]);
    const variants = parseMediaVariants(wrapper);
    expect(variants).toHaveLength(2);
    expect(variants[0]!.value).toBe("a.png");
    expect(variants[1]!.value).toBe("b.png");
  });
});

describe("appendMediaVariant", () => {
  test("adds a variant cloned from last", () => {
    const wrapper = makeWrapper(["a.png"]);
    const result = appendMediaVariant(wrapper);
    expect(result.variants).toHaveLength(2);
    expect(result.variants[1]!.value).toBe("a.png");
  });
});

describe("deleteMediaVariant", () => {
  test("removes variant at index", () => {
    const wrapper = makeWrapper(["a.png", "b.png", "c.png"]);
    const result = deleteMediaVariant(wrapper, 1);
    expect(result).not.toBeNull();
    expect(result!.variants).toHaveLength(2);
    expect(result!.variants[0]!.value).toBe("a.png");
    expect(result!.variants[1]!.value).toBe("c.png");
  });

  test("returns null when only 1 variant", () => {
    const wrapper = makeWrapper(["a.png"]);
    expect(deleteMediaVariant(wrapper, 0)).toBeNull();
  });
});

describe("duplicateMediaVariant", () => {
  test("clones variant at index", () => {
    const wrapper = makeWrapper(["a.png", "b.png"]);
    const result = duplicateMediaVariant(wrapper, 0);
    expect(result.variants).toHaveLength(3);
    expect(result.variants[0]!.value).toBe("a.png");
    expect(result.variants[1]!.value).toBe("a.png");
    expect(result.variants[2]!.value).toBe("b.png");
  });

  test("returns wrapper unchanged for out-of-bounds index", () => {
    const wrapper = makeWrapper(["a.png"]);
    const result = duplicateMediaVariant(wrapper, 5);
    expect(result.variants).toHaveLength(1);
  });
});

describe("reorderMediaVariant", () => {
  test("moves variant from one position to another", () => {
    const wrapper = makeWrapper(["a.png", "b.png", "c.png"]);
    const result = reorderMediaVariant(wrapper, 0, 2);
    expect(result.variants[0]!.value).toBe("b.png");
    expect(result.variants[1]!.value).toBe("c.png");
    expect(result.variants[2]!.value).toBe("a.png");
  });

  test("returns wrapper unchanged for same index", () => {
    const wrapper = makeWrapper(["a.png", "b.png"]);
    const result = reorderMediaVariant(wrapper, 1, 1);
    expect(result.variants[0]!.value).toBe("a.png");
    expect(result.variants[1]!.value).toBe("b.png");
  });

  test("returns wrapper unchanged for out-of-bounds", () => {
    const wrapper = makeWrapper(["a.png"]);
    const result = reorderMediaVariant(wrapper, 0, 5);
    expect(result.variants).toHaveLength(1);
  });
});

describe("updateMediaVariantValue", () => {
  test("updates URL at index", () => {
    const wrapper = makeWrapper(["a.png", "b.png"]);
    const result = updateMediaVariantValue(wrapper, 1, "new.png");
    expect(result.variants[0]!.value).toBe("a.png");
    expect(result.variants[1]!.value).toBe("new.png");
  });

  test("returns wrapper unchanged for out-of-bounds index", () => {
    const wrapper = makeWrapper(["a.png"]);
    const result = updateMediaVariantValue(wrapper, 5, "x.png");
    expect(result.variants[0]!.value).toBe("a.png");
  });
});

describe("updateMediaVariantRule", () => {
  test("updates rule at index", () => {
    const wrapper = makeWrapper(["a.png", "b.png"]);
    const newRule = { __resolveType: "website/matchers/device.ts" };
    const result = updateMediaVariantRule(wrapper, 0, newRule);
    expect(result.variants[0]!.rule).toEqual(newRule);
    expect(result.variants[1]!.rule.__resolveType).toBe(ALWAYS_RT);
  });
});
