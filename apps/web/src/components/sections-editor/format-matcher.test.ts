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

    /** These use local-time literals (no trailing Z) so the day-boundary check
     *  reads the same instants a reader's timezone would, whatever CI runs in. */
    test("a whole-day window drops the midnight boundaries", () => {
      expect(
        formatMatcher({
          __resolveType: "website/matchers/date.ts",
          start: "2026-07-24T00:00:00",
          end: "2026-08-09T23:59:00",
        }),
      ).toBe("Jul 24 → Aug 9, 2026");
    });

    test("a whole-day window spanning years says both", () => {
      expect(
        formatMatcher({
          __resolveType: "website/matchers/date.ts",
          start: "2025-12-20T00:00:00",
          end: "2026-01-05T23:59:00",
        }),
      ).toBe("Dec 20, 2025 → Jan 5, 2026");
    });

    test("open-ended ranges read through the dictionary", () => {
      // ICU owns the date/time separator ("at" in some data, ", " in other).
      const from = formatMatcher({
        __resolveType: "website/matchers/date.ts",
        start: "2026-06-15T10:00:00",
      });
      expect(from.startsWith("From ")).toBe(true);
      expect(from).toContain("Jun 15, 2026");
      expect(from).toContain("10:00 AM");

      const until = formatMatcher({
        __resolveType: "website/matchers/date.ts",
        end: "2026-06-15T10:00:00",
      });
      expect(until.startsWith("Until ")).toBe(true);
      expect(until).toContain("Jun 15, 2026");
      expect(until).toContain("10:00 AM");
    });

    test("a window with a real time of day keeps it", () => {
      const result = formatMatcher({
        __resolveType: "website/matchers/date.ts",
        start: "2026-07-24T15:30:00",
        end: "2026-07-24T18:00:00",
      });
      expect(result).toContain("3:30 PM");
      expect(result).toContain("6:00 PM");
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

    test("parenthesises a nested multi whose operator differs", () => {
      // Without the parentheses this flattens to "Mobile OR Desktop AND 50% of
      // sessions", which ordinary precedence reads as a different rule.
      const result = formatMatcher({
        __resolveType: "website/matchers/multi.ts",
        op: "AND",
        matchers: [
          {
            __resolveType: "website/matchers/multi.ts",
            op: "OR",
            matchers: [
              { __resolveType: "website/matchers/device.ts", mobile: true },
              { __resolveType: "website/matchers/device.ts", desktop: true },
            ],
          },
          { __resolveType: "website/matchers/random.ts", traffic: 0.5 },
        ],
      });
      expect(result).toBe("(Mobile OR Desktop) AND 50% of sessions");
    });

    test("leaves a nested multi with the same operator unparenthesised", () => {
      const result = formatMatcher({
        __resolveType: "website/matchers/multi.ts",
        op: "AND",
        matchers: [
          {
            __resolveType: "website/matchers/multi.ts",
            op: "AND",
            matchers: [
              { __resolveType: "website/matchers/device.ts", mobile: true },
              { __resolveType: "website/matchers/never.ts" },
            ],
          },
          { __resolveType: "website/matchers/device.ts", desktop: true },
        ],
      });
      expect(result).toBe("Mobile AND Hidden AND Desktop");
    });

    test("leaves a single-child nested multi unparenthesised", () => {
      // One child prints no operator of its own, so there is nothing to group.
      const result = formatMatcher({
        __resolveType: "website/matchers/multi.ts",
        op: "AND",
        matchers: [
          {
            __resolveType: "$live/matchers/MatchMulti.ts",
            op: "OR",
            matchers: [
              { __resolveType: "website/matchers/device.ts", mobile: true },
            ],
          },
          { __resolveType: "website/matchers/device.ts", desktop: true },
        ],
      });
      expect(result).toBe("Mobile AND Desktop");
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
