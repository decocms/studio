import { describe, expect, test } from "bun:test";
import { formatMatcher } from "./format-matcher";

describe("formatMatcher", () => {
  test("returns 'Default' for undefined rule", () => {
    expect(formatMatcher(undefined)).toBe("Default");
  });

  test("returns 'Default' for empty resolveType", () => {
    expect(formatMatcher({ __resolveType: "" })).toBe("Default");
  });

  test("returns 'Default' for always matcher", () => {
    expect(formatMatcher({ __resolveType: "website/matchers/always.ts" })).toBe(
      "Default",
    );
    expect(
      formatMatcher({ __resolveType: "$live/matchers/MatchAlways.ts" }),
    ).toBe("Default");
  });

  test("returns 'Hidden' for never matcher", () => {
    expect(formatMatcher({ __resolveType: "website/matchers/never.ts" })).toBe(
      "Hidden",
    );
  });

  describe("device matcher", () => {
    test("formats boolean device flags", () => {
      expect(
        formatMatcher({
          __resolveType: "website/matchers/device.ts",
          mobile: true,
          desktop: true,
        }),
      ).toBe("Mobile & Desktop");
    });

    test("formats devices array", () => {
      expect(
        formatMatcher({
          __resolveType: "website/matchers/device.ts",
          devices: ["tablet"],
        }),
      ).toBe("Tablet");
    });

    test("falls back to label when no devices", () => {
      const result = formatMatcher({
        __resolveType: "website/matchers/device.ts",
      });
      expect(result).toBeTruthy();
      expect(result).not.toBe("Default");
    });

    test("handles legacy MatchDevice resolveType", () => {
      expect(
        formatMatcher({
          __resolveType: "$live/matchers/MatchDevice.ts",
          mobile: true,
        }),
      ).toBe("Mobile");
    });
  });

  describe("date matcher", () => {
    test("formats date range with start and end", () => {
      const result = formatMatcher({
        __resolveType: "website/matchers/date.ts",
        start: "2024-01-01T00:00:00Z",
        end: "2024-12-31T23:59:59Z",
      });
      expect(result).toContain("→");
    });

    test("formats start-only date", () => {
      const result = formatMatcher({
        __resolveType: "website/matchers/date.ts",
        start: "2024-06-15T10:00:00Z",
      });
      expect(result).toContain("From");
    });

    test("formats end-only date", () => {
      const result = formatMatcher({
        __resolveType: "website/matchers/date.ts",
        end: "2024-12-31T23:59:59Z",
      });
      expect(result).toContain("Until");
    });

    test("falls back to label when no valid dates", () => {
      const result = formatMatcher({
        __resolveType: "website/matchers/date.ts",
      });
      expect(result).toBeTruthy();
      expect(result).not.toBe("Default");
    });
  });

  describe("random matcher", () => {
    test("formats traffic percentage", () => {
      expect(
        formatMatcher({
          __resolveType: "website/matchers/random.ts",
          traffic: 0.5,
        }),
      ).toBe("50% of sessions");
    });

    test("rounds up traffic percentage", () => {
      expect(
        formatMatcher({
          __resolveType: "website/matchers/random.ts",
          traffic: 0.333,
        }),
      ).toBe("34% of sessions");
    });

    test("falls back when no traffic", () => {
      const result = formatMatcher({
        __resolveType: "website/matchers/random.ts",
      });
      expect(result).toBeTruthy();
      expect(result).not.toBe("Default");
    });
  });

  describe("host matcher", () => {
    test("formats includes", () => {
      expect(
        formatMatcher({
          __resolveType: "website/matchers/host.ts",
          includes: "example.com",
        }),
      ).toBe("example.com");
    });

    test("formats includes and match", () => {
      expect(
        formatMatcher({
          __resolveType: "website/matchers/host.ts",
          includes: "example.com",
          match: "*.example.com",
        }),
      ).toBe("example.com - *.example.com");
    });

    test("falls back when no host info", () => {
      const result = formatMatcher({
        __resolveType: "website/matchers/host.ts",
      });
      expect(result).toBeTruthy();
      expect(result).not.toBe("Default");
    });
  });

  describe("pathname matcher", () => {
    test("formats pathname case", () => {
      expect(
        formatMatcher({
          __resolveType: "website/matchers/pathname.ts",
          case: { type: "startsWith", pathname: "/blog" },
        }),
      ).toBe("Pathname startsWith /blog");
    });

    test("falls back when no case", () => {
      const result = formatMatcher({
        __resolveType: "website/matchers/pathname.ts",
      });
      expect(result).toBeTruthy();
      expect(result).not.toBe("Default");
    });
  });

  describe("location matcher", () => {
    test("formats included location", () => {
      expect(
        formatMatcher({
          __resolveType: "website/matchers/location.ts",
          includeLocations: [{ city: "NYC", regionCode: "NY", country: "US" }],
        }),
      ).toBe("NYC - NY - US");
    });

    test("formats multiple included locations with count", () => {
      expect(
        formatMatcher({
          __resolveType: "website/matchers/location.ts",
          includeLocations: [
            { city: "NYC", country: "US" },
            { city: "London", country: "UK" },
          ],
        }),
      ).toBe("NYC - US +1");
    });

    test("formats excluded location", () => {
      expect(
        formatMatcher({
          __resolveType: "website/matchers/location.ts",
          excludeLocations: [{ country: "BR" }],
        }),
      ).toBe("Except BR");
    });

    test("returns 'Any location' when no locations", () => {
      expect(
        formatMatcher({
          __resolveType: "website/matchers/location.ts",
        }),
      ).toBe("Any location");
    });
  });

  describe("multi matcher", () => {
    test("joins with AND", () => {
      const result = formatMatcher({
        __resolveType: "website/matchers/multi.ts",
        matchers: [
          { __resolveType: "website/matchers/device.ts", mobile: true },
          { __resolveType: "website/matchers/never.ts" },
        ],
        op: "AND",
      });
      expect(result).toBe("Mobile AND Hidden");
    });

    test("joins with OR", () => {
      const result = formatMatcher({
        __resolveType: "website/matchers/multi.ts",
        matchers: [
          { __resolveType: "website/matchers/device.ts", desktop: true },
          { __resolveType: "website/matchers/never.ts" },
        ],
        op: "OR",
      });
      expect(result).toBe("Desktop OR Hidden");
    });

    test("defaults to AND for unknown op", () => {
      const result = formatMatcher({
        __resolveType: "website/matchers/multi.ts",
        matchers: [
          { __resolveType: "website/matchers/never.ts" },
          { __resolveType: "website/matchers/never.ts" },
        ],
        op: "XOR",
      });
      expect(result).toBe("Hidden AND Hidden");
    });
  });

  describe("depth guard", () => {
    test("returns '...' when depth exceeds limit", () => {
      expect(
        formatMatcher({ __resolveType: "website/matchers/device.ts" }, 6),
      ).toBe("...");
    });

    test("deeply nested multi matchers stop at depth limit", () => {
      // Build a nested multi matcher 6 levels deep
      let inner: Record<string, unknown> = {
        __resolveType: "website/matchers/device.ts",
        mobile: true,
      };
      for (let i = 0; i < 6; i++) {
        inner = {
          __resolveType: "website/matchers/multi.ts",
          matchers: [inner],
        };
      }
      const result = formatMatcher(inner);
      expect(result).toContain("...");
    });
  });

  describe("default/fallback", () => {
    test("uses date range for unknown resolveType with date fields", () => {
      const result = formatMatcher({
        __resolveType: "site/matchers/custom-date.ts",
        start: "2024-01-01T00:00:00Z",
        end: "2024-06-30T00:00:00Z",
      });
      expect(result).toContain("→");
    });

    test("falls back to label for unknown resolveType", () => {
      const result = formatMatcher({
        __resolveType: "site/matchers/custom.ts",
      });
      expect(result).toBeTruthy();
      expect(result).not.toBe("Default");
    });
  });
});
