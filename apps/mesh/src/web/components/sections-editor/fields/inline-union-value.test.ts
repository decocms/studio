import { describe, expect, test } from "bun:test";
import { inferInlineUnionIndex } from "./inline-union-value";

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
