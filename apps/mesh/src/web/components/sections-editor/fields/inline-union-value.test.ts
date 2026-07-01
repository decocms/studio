import { describe, expect, test } from "bun:test";
import {
  inferInlineUnionIndex,
  preservedOtherBranchFields,
} from "./inline-union-value";

const locationMap = [
  { propertyKeys: ["city", "regionCode", "country"] },
  { propertyKeys: ["coordinates"] },
];

const cacheDirective = [
  { discriminators: { name: "max-age" }, propertyKeys: ["name", "value"] },
  {
    discriminators: { name: "stale-while-revalidate" },
    propertyKeys: ["name", "value"],
  },
];

describe("inferInlineUnionIndex – shape-based (Location | Map)", () => {
  test("picks Location when location fields are set", () => {
    expect(inferInlineUnionIndex({ country: "BR" }, locationMap)).toBe(0);
    expect(
      inferInlineUnionIndex(
        { city: "Sao Paulo", regionCode: "SP" },
        locationMap,
      ),
    ).toBe(0);
  });

  test("picks Map when coordinates are set", () => {
    expect(
      inferInlineUnionIndex({ coordinates: "-23,-46,5000" }, locationMap),
    ).toBe(1);
  });

  test("empty / unknown value falls back to the first branch", () => {
    expect(inferInlineUnionIndex({}, locationMap)).toBe(0);
    expect(inferInlineUnionIndex(null, locationMap)).toBe(0);
    expect(inferInlineUnionIndex({ city: "" }, locationMap)).toBe(0);
  });
});

describe("inferInlineUnionIndex – const discriminator (cache directives)", () => {
  test("matches the branch whose const field equals the value", () => {
    expect(
      inferInlineUnionIndex({ name: "max-age", value: 60 }, cacheDirective),
    ).toBe(0);
    expect(
      inferInlineUnionIndex(
        { name: "stale-while-revalidate", value: 5 },
        cacheDirective,
      ),
    ).toBe(1);
  });

  test("discriminator match wins even though the shapes are identical", () => {
    // Both branches share {name, value}; only the const value disambiguates.
    expect(
      inferInlineUnionIndex({ name: "stale-while-revalidate" }, cacheDirective),
    ).toBe(1);
  });

  test("unknown discriminator value falls back to first branch", () => {
    expect(inferInlineUnionIndex({ name: "immutable" }, cacheDirective)).toBe(
      0,
    );
  });
});

describe("preservedOtherBranchFields – legacy combined entries", () => {
  test("keeps the hidden branch's fields when editing the visible one", () => {
    // Legacy entry combining a Location constraint (regionCode) with a Map one.
    const combined = { regionCode: "SP", coordinates: "-23,-46,2000" };
    // Active branch is Location {city, regionCode, country}; coordinates is preserved.
    expect(
      preservedOtherBranchFields(combined, ["city", "regionCode", "country"]),
    ).toEqual({ coordinates: "-23,-46,2000" });
  });

  test("returns nothing to preserve for a clean single-branch value", () => {
    expect(
      preservedOtherBranchFields({ country: "BR" }, [
        "city",
        "regionCode",
        "country",
      ]),
    ).toEqual({});
  });

  test("handles non-object values", () => {
    expect(preservedOtherBranchFields(null, ["coordinates"])).toEqual({});
  });
});

describe("inferInlineUnionIndex – discriminator matching details", () => {
  test("ALL discriminator fields must match, not just one", () => {
    const branches = [
      {
        discriminators: { name: "max-age", scope: "public" },
        propertyKeys: ["name", "scope", "value"],
      },
      {
        discriminators: { name: "max-age", scope: "private" },
        propertyKeys: ["name", "scope", "value"],
      },
    ];
    expect(
      inferInlineUnionIndex({ name: "max-age", scope: "private" }, branches),
    ).toBe(1);
  });

  test("discriminator fields are excluded from the shape score", () => {
    // Both branches share a non-discriminator `value`; a value with only `value`
    // set (no matching const) must tie → fall back to the first branch, proving
    // the const `name` key isn't counted toward the score.
    const branches = [
      { discriminators: { name: "a" }, propertyKeys: ["name", "value"] },
      { discriminators: { name: "b" }, propertyKeys: ["name", "value"] },
    ];
    expect(inferInlineUnionIndex({ value: 60 }, branches)).toBe(0);
  });
});
