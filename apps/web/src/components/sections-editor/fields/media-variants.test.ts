import { describe, expect, test } from "bun:test";
import {
  appendVariant,
  deleteVariant,
  duplicateVariant,
  flattenMultivariate,
  isMultivariateWrapper,
  reorderVariant,
  selectedIndexAfterDelete,
  updateVariantRule,
  updateVariantValue,
  wrapAsMultivariate,
  type MultivariateWrapper,
} from "./media-variants";

const RESOLVE_TYPE = "website/flags/multivariate/image.ts";
const ALWAYS_RT = "website/matchers/always.ts";

function makeWrapper(values: unknown[]): MultivariateWrapper {
  return {
    __resolveType: RESOLVE_TYPE,
    variants: values.map((value) => ({
      rule: { __resolveType: ALWAYS_RT },
      value,
    })),
  };
}

describe("isMultivariateWrapper", () => {
  test("returns true for valid wrapper", () => {
    expect(isMultivariateWrapper(makeWrapper(["a.png"]))).toBe(true);
  });

  test("returns true for object-valued wrapper", () => {
    expect(
      isMultivariateWrapper(
        makeWrapper([{ desktop: "a.png", mobile: "b.png" }]),
      ),
    ).toBe(true);
  });

  test("returns false for plain string", () => {
    expect(isMultivariateWrapper("https://img.png")).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(isMultivariateWrapper(null)).toBe(false);
    expect(isMultivariateWrapper(undefined)).toBe(false);
  });

  test("returns false for object without variants", () => {
    expect(isMultivariateWrapper({ __resolveType: RESOLVE_TYPE })).toBe(false);
  });
});

describe("wrapAsMultivariate / flattenMultivariate round-trip", () => {
  test("wraps a string and flattens back to the same string", () => {
    const url = "https://example.com/image.png";
    const wrapped = wrapAsMultivariate(url, RESOLVE_TYPE);
    expect(wrapped.__resolveType).toBe(RESOLVE_TYPE);
    expect(wrapped.variants).toHaveLength(2);
    expect(flattenMultivariate(wrapped)).toBe(url);
  });

  test("wraps an empty string", () => {
    const wrapped = wrapAsMultivariate("", RESOLVE_TYPE);
    expect(flattenMultivariate(wrapped)).toBe("");
  });

  test("wraps an object value and flattens back", () => {
    const obj = { desktop: "desk.png", mobile: "mob.png" };
    const wrapped = wrapAsMultivariate(obj, RESOLVE_TYPE);
    expect(wrapped.variants).toHaveLength(2);
    expect(flattenMultivariate(wrapped)).toEqual(obj);
  });
});

describe("multivariate (next-major short name)", () => {
  test("keeps each variant's value in a lazy block", () => {
    const wrapped = wrapAsMultivariate("Sale!", "multivariate");
    expect(wrapped.variants.map((v) => v.value)).toEqual([
      { __resolveType: "lazy", value: "Sale!" },
      { __resolveType: "lazy", value: "Sale!" },
    ]);
    expect(flattenMultivariate(wrapped)).toBe("Sale!");
  });

  test("legacy names keep plain values", () => {
    const wrapped = wrapAsMultivariate("Sale!", RESOLVE_TYPE);
    expect(wrapped.variants[0]?.value).toBe("Sale!");
  });
});

describe("flattenMultivariate", () => {
  test("picks the always variant", () => {
    const wrapper: MultivariateWrapper = {
      __resolveType: RESOLVE_TYPE,
      variants: [
        {
          rule: { __resolveType: "website/matchers/device.ts" },
          value: "mobile.png",
        },
        { rule: { __resolveType: ALWAYS_RT }, value: "default.png" },
      ],
    };
    expect(flattenMultivariate(wrapper)).toBe("default.png");
  });

  test("picks the last variant when no always variant", () => {
    const wrapper: MultivariateWrapper = {
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
    expect(flattenMultivariate(wrapper)).toBe("desktop.png");
  });

  test("returns undefined for empty variants", () => {
    const wrapper: MultivariateWrapper = {
      __resolveType: RESOLVE_TYPE,
      variants: [],
    };
    expect(flattenMultivariate(wrapper)).toBeUndefined();
  });
});

describe("appendVariant", () => {
  test("v7: adds a variant cloned from last, at the end", () => {
    const wrapper = makeWrapper(["a.png"]);
    const result = appendVariant(wrapper);
    expect(result.variants).toHaveLength(2);
    expect(result.variants[0]).toBe(wrapper.variants[0]!);
    expect(result.variants[1]!.value).toBe("a.png");
  });

  test("v7: adds at the end after a trailing always one", () => {
    const wrapper: MultivariateWrapper = {
      __resolveType: RESOLVE_TYPE,
      variants: [
        {
          rule: { __resolveType: "website/matchers/device.ts" },
          value: "mobile.png",
        },
        { rule: { __resolveType: ALWAYS_RT }, value: "default.png" },
      ],
    };
    const result = appendVariant(wrapper, undefined, false);
    expect(result.variants[0]).toBe(wrapper.variants[0]!);
    expect(result.variants[1]).toBe(wrapper.variants[1]!);
    expect(result.variants[2]!.value).toBe("default.png");
  });

  test("v8: adds a variant cloned from last, above the trailing always one", () => {
    const wrapper = makeWrapper(["a.png"]);
    const result = appendVariant(wrapper, undefined, true);
    expect(result.variants).toHaveLength(2);
    expect(result.variants[0]!.value).toBe("a.png");
    expect(result.variants[1]).toBe(wrapper.variants[0]!);
  });

  test("v8: keeps the existing order and adds right above the catch-all", () => {
    const wrapper: MultivariateWrapper = {
      __resolveType: RESOLVE_TYPE,
      variants: [
        {
          rule: { __resolveType: "website/matchers/device.ts" },
          value: "mobile.png",
        },
        { rule: { __resolveType: ALWAYS_RT }, value: "default.png" },
      ],
    };
    const result = appendVariant(wrapper, undefined, true);
    expect(result.variants.map((v) => v.value)).toEqual([
      "mobile.png",
      "default.png",
      "default.png",
    ]);
    expect(result.variants[2]).toBe(wrapper.variants[1]!);
  });

  test("appends at the end when no variant always matches last", () => {
    const wrapper: MultivariateWrapper = {
      __resolveType: RESOLVE_TYPE,
      variants: [
        {
          rule: { __resolveType: "website/matchers/device.ts" },
          value: "mobile.png",
        },
      ],
    };
    for (const v8 of [true, false]) {
      const result = appendVariant(wrapper, undefined, v8);
      expect(result.variants[0]).toBe(wrapper.variants[0]!);
      expect(result.variants[1]!.value).toBe("mobile.png");
    }
  });

  test("deep clones object values", () => {
    const obj = { desktop: "a.png" };
    const wrapper = makeWrapper([obj]);
    const result = appendVariant(wrapper);
    expect(result.variants[1]!.value).toEqual(obj);
    // Must be a clone, not the same reference
    expect(result.variants[1]!.value).not.toBe(obj);
    const v8 = appendVariant(wrapper, undefined, true);
    expect(v8.variants[0]!.value).toEqual(obj);
    expect(v8.variants[0]!.value).not.toBe(obj);
  });
});

describe("deleteVariant", () => {
  test("removes variant at index", () => {
    const wrapper = makeWrapper(["a.png", "b.png", "c.png"]);
    const result = deleteVariant(wrapper, 1);
    expect(result).not.toBeNull();
    expect(result!.variants).toHaveLength(2);
    expect(result!.variants[0]!.value).toBe("a.png");
    expect(result!.variants[1]!.value).toBe("c.png");
  });

  test("returns null when only 1 variant", () => {
    const wrapper = makeWrapper(["a.png"]);
    expect(deleteVariant(wrapper, 0)).toBeNull();
  });
});

describe("selectedIndexAfterDelete", () => {
  test("shifts the selection down when a variant before it is deleted", () => {
    expect(selectedIndexAfterDelete(2, 0, 3)).toBe(1);
  });

  test("keeps the selection when a variant after it is deleted", () => {
    expect(selectedIndexAfterDelete(0, 2, 2)).toBe(0);
  });

  test("clamps to the last remaining variant when the selected one is deleted", () => {
    expect(selectedIndexAfterDelete(2, 2, 2)).toBe(1);
  });
});

describe("duplicateVariant", () => {
  test("clones variant at index", () => {
    const wrapper = makeWrapper(["a.png", "b.png"]);
    const result = duplicateVariant(wrapper, 0);
    expect(result.variants).toHaveLength(3);
    expect(result.variants[0]!.value).toBe("a.png");
    expect(result.variants[1]!.value).toBe("a.png");
    expect(result.variants[2]!.value).toBe("b.png");
  });

  test("v7: a copy of the trailing always variant goes after it", () => {
    const wrapper = makeWrapper(["a.png", "b.png"]);
    const result = duplicateVariant(wrapper, 1);
    expect(result.variants[1]).toBe(wrapper.variants[1]!);
    expect(result.variants[2]!.value).toBe("b.png");
    expect(result.variants[2]).not.toBe(wrapper.variants[1]!);
  });

  test("v8: a copy of the trailing always variant goes above it", () => {
    const wrapper = makeWrapper(["a.png", "b.png"]);
    const result = duplicateVariant(wrapper, 1, true);
    expect(result.variants.map((v) => v.value)).toEqual([
      "a.png",
      "b.png",
      "b.png",
    ]);
    expect(result.variants[2]).toBe(wrapper.variants[1]!);
  });

  test("returns wrapper unchanged for out-of-bounds index", () => {
    const wrapper = makeWrapper(["a.png"]);
    const result = duplicateVariant(wrapper, 5);
    expect(result.variants).toHaveLength(1);
  });
});

describe("reorderVariant", () => {
  test("moves variant from one position to another", () => {
    const wrapper = makeWrapper(["a.png", "b.png", "c.png"]);
    const result = reorderVariant(wrapper, 0, 2);
    expect(result.variants[0]!.value).toBe("b.png");
    expect(result.variants[1]!.value).toBe("c.png");
    expect(result.variants[2]!.value).toBe("a.png");
  });

  test("returns wrapper unchanged for same index", () => {
    const wrapper = makeWrapper(["a.png", "b.png"]);
    const result = reorderVariant(wrapper, 1, 1);
    expect(result.variants[0]!.value).toBe("a.png");
    expect(result.variants[1]!.value).toBe("b.png");
  });

  test("returns wrapper unchanged for out-of-bounds", () => {
    const wrapper = makeWrapper(["a.png"]);
    const result = reorderVariant(wrapper, 0, 5);
    expect(result.variants).toHaveLength(1);
  });
});

describe("updateVariantValue", () => {
  test("updates value at index", () => {
    const wrapper = makeWrapper(["a.png", "b.png"]);
    const result = updateVariantValue(wrapper, 1, "new.png");
    expect(result.variants[0]!.value).toBe("a.png");
    expect(result.variants[1]!.value).toBe("new.png");
  });

  test("updates object value at index", () => {
    const wrapper = makeWrapper([{ a: 1 }, { b: 2 }]);
    const result = updateVariantValue(wrapper, 0, { a: 99 });
    expect(result.variants[0]!.value).toEqual({ a: 99 });
  });

  test("returns wrapper unchanged for out-of-bounds index", () => {
    const wrapper = makeWrapper(["a.png"]);
    const result = updateVariantValue(wrapper, 5, "x.png");
    expect(result.variants[0]!.value).toBe("a.png");
  });
});

describe("updateVariantRule", () => {
  test("updates rule at index", () => {
    const wrapper = makeWrapper(["a.png", "b.png"]);
    const newRule = { __resolveType: "website/matchers/device.ts" };
    const result = updateVariantRule(wrapper, 0, newRule);
    expect(result.variants[0]!.rule).toEqual(newRule);
    expect(result.variants[1]!.rule.__resolveType).toBe(ALWAYS_RT);
  });
});
