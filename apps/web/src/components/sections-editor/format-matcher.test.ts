import { describe, expect, test } from "bun:test";
import { formatMatcher, matcherFormatter } from "./format-matcher";

/** formatMatcher on a Blocks v8 site. */
const v8Format = matcherFormatter(true);

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

  test("v8: labels next-major's short matcher names", () => {
    expect(v8Format({ __resolveType: "always" })).toBe("Default");
    expect(v8Format({ __resolveType: "never" })).toBe("Hidden");
    expect(
      v8Format({ __resolveType: "device", mobile: true, desktop: true }),
    ).toBe("Mobile & Desktop");
    expect(v8Format({ __resolveType: "device" })).toBe("Device");
    expect(v8Format({ __resolveType: "date" })).toBe("Date");
    expect(
      v8Format({
        __resolveType: "date",
        start: "2026-01-01T00:00:00",
        end: "2026-01-31T23:59:00",
      }),
    ).not.toBe("Date");
    expect(v8Format({ __resolveType: "campaign" })).toBe("Campaign");
  });
  test("v7: a short name is a saved block's key, labelled as before", () => {
    expect(formatMatcher({ __resolveType: "always" })).toBe("Always");
    expect(formatMatcher({ __resolveType: "never" })).toBe("Never");
    expect(
      formatMatcher({ __resolveType: "device", mobile: true, desktop: true }),
    ).toBe("Device");
    expect(formatMatcher({ __resolveType: "campaign", name: "BF" })).toBe(
      "Campaign",
    );
    expect(formatMatcher({ __resolveType: "experiment", name: "x" })).toBe(
      "Experiment",
    );
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
      expect(result).toStartWith("From ");
      expect(result).toContain(" to ");
    });

    test("formats start-only date", () => {
      const result = formatMatcher({
        __resolveType: "website/matchers/date.ts",
        start: "2024-06-15T10:00:00Z",
      });
      expect(result).toContain("Starts on");
    });

    test("formats end-only date", () => {
      const result = formatMatcher({
        __resolveType: "website/matchers/date.ts",
        end: "2024-12-31T23:59:59Z",
      });
      expect(result).toContain("Ends on");
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
      ).toBe("From Jul 24 to Aug 9, 2026");
    });

    test("a whole-day window spanning years says both", () => {
      expect(
        formatMatcher({
          __resolveType: "website/matchers/date.ts",
          start: "2025-12-20T00:00:00",
          end: "2026-01-05T23:59:00",
        }),
      ).toBe("From Dec 20, 2025 to Jan 5, 2026");
    });

    test("open-ended ranges read through the dictionary", () => {
      // ICU owns the date/time separator ("at" in some data, ", " in other).
      const from = formatMatcher({
        __resolveType: "website/matchers/date.ts",
        start: "2026-06-15T10:00:00",
      });
      expect(from.startsWith("Starts on ")).toBe(true);
      expect(from).toContain("Jun 15, 2026");
      expect(from).toContain("10:00 AM");

      const until = formatMatcher({
        __resolveType: "website/matchers/date.ts",
        end: "2026-06-15T10:00:00",
      });
      expect(until.startsWith("Ends on ")).toBe(true);
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

  describe("A/B tests and campaigns", () => {
    const year = new Date().getFullYear();
    const local = (month: number, day: number, hour = 0, minute = 0) =>
      new Date(year, month, day, hour, minute).toISOString();
    const named = {
      experiments: { "hero-headline": 50, off: 0 },
      campaigns: {
        "Black Friday": { start: local(10, 27), end: local(11, 2) },
        Launch: { start: local(2, 1) },
        Clearance: { end: local(0, 31, 23, 59) },
        Forever: {},
      },
    };

    test("names an A/B test with its share", () => {
      expect(
        v8Format({ __resolveType: "experiment", name: "hero-headline" }, named),
      ).toBe("A/B test: hero-headline (50%)");
      expect(
        v8Format({ __resolveType: "experiment", name: "off" }, named),
      ).toBe("A/B test: off (0%)");
    });

    test("names an A/B test the content doesn't have, or with no values at hand", () => {
      expect(
        v8Format({ __resolveType: "experiment", name: "gone" }, named),
      ).toBe("A/B test: gone");
      expect(
        v8Format({ __resolveType: "experiment", name: "hero-headline" }),
      ).toBe("A/B test: hero-headline");
      expect(v8Format({ __resolveType: "experiment" })).toBe("A/B test");
    });

    test("names a campaign with its dates; the end is exclusive", () => {
      expect(
        v8Format({ __resolveType: "campaign", name: "Black Friday" }, named),
      ).toBe("Campaign: Black Friday (Nov 27 – Dec 1)");
      expect(
        v8Format({ __resolveType: "campaign", name: "Launch" }, named),
      ).toBe("Campaign: Launch (from Mar 1)");
      expect(
        v8Format({ __resolveType: "campaign", name: "Clearance" }, named),
      ).toBe("Campaign: Clearance (until Jan 31)");
    });

    test("names a campaign with no dates, or unknown, by its name", () => {
      expect(
        v8Format({ __resolveType: "campaign", name: "Forever" }, named),
      ).toBe("Campaign: Forever");
      expect(
        v8Format({ __resolveType: "campaign", name: "Black Friday" }),
      ).toBe("Campaign: Black Friday");
      expect(v8Format({ __resolveType: "campaign", name: " " })).toBe(
        "Campaign",
      );
    });

    test("shows the year and times outside the current year or whole days", () => {
      const label = v8Format(
        { __resolveType: "campaign", name: "Old" },
        {
          experiments: {},
          campaigns: {
            Old: {
              start: new Date(2020, 10, 27, 10, 30).toISOString(),
              end: new Date(2020, 11, 1, 18, 0).toISOString(),
            },
          },
        },
      );
      expect(label).toStartWith("Campaign: Old (");
      expect(label).toContain("2020");
      expect(label).toContain(" – ");
    });

    test("keeps showing a date rule written with its own dates", () => {
      const label = v8Format(
        {
          __resolveType: "date",
          start: new Date(2020, 10, 27).toISOString(),
          end: new Date(2020, 11, 1).toISOString(),
        },
        named,
      );
      expect(label).toStartWith("From ");
      expect(label).toContain("2020");
      expect(v8Format({ __resolveType: "date" })).toBe("Date");
    });

    test("labels named rules inside a multi with their values", () => {
      expect(
        v8Format(
          {
            __resolveType: "website/matchers/multi.ts",
            op: "AND",
            matchers: [
              { __resolveType: "campaign", name: "Launch" },
              { __resolveType: "experiment", name: "hero-headline" },
            ],
          },
          named,
        ),
      ).toBe("Campaign: Launch (from Mar 1) AND A/B test: hero-headline (50%)");
    });
  });

  describe("depth guard", () => {
    test("returns '...' for a rule nested past the limit", () => {
      let rule: Record<string, unknown> = {
        __resolveType: "website/matchers/device.ts",
        mobile: true,
      };
      for (let i = 0; i < 6; i++) {
        rule = { __resolveType: "website/matchers/multi.ts", matchers: [rule] };
      }
      expect(formatMatcher(rule)).toBe("...");
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
      expect(result).toStartWith("From ");
      expect(result).toContain(" to ");
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
