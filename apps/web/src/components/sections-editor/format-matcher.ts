import { readLanguage } from "@/hooks/use-preferences.ts";
import type { Locale } from "@/i18n/locale.ts";
import { translate } from "@/i18n/use-t.ts";
import { labelFromResolveType } from "./section-types";

const capitalize = (s: string) =>
  s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

const MAX_FORMAT_DEPTH = 5;

/** Matcher modules that compose other matchers with AND / OR. */
const MULTI_MATCHER_RESOLVE_TYPES = new Set([
  "website/matchers/multi.ts",
  "$live/matchers/MatchMulti.ts",
]);

/**
 * A nested `multi` is flattened into its parent's join, so the result reads by
 * ordinary boolean precedence — `multi(AND, [multi(OR, [a, b]), c])` would
 * print "a OR b AND c", which means something else. Parenthesise a child whose
 * operator differs from its parent's. A child with fewer than two matchers
 * prints no operator of its own, so it needs no parentheses.
 */
function childNeedsParens(child: unknown, parentOp: string): boolean {
  if (!child || typeof child !== "object" || Array.isArray(child)) return false;
  const obj = child as Record<string, unknown>;
  const rt = typeof obj.__resolveType === "string" ? obj.__resolveType : "";
  if (!MULTI_MATCHER_RESOLVE_TYPES.has(rt)) return false;
  if (!Array.isArray(obj.matchers) || obj.matchers.length < 2) return false;
  return (obj.op === "OR" ? "OR" : "AND") !== parentOp;
}

/** Built per locale on first use: `Intl.DateTimeFormat` is costly enough to be
 *  worth keeping, and a variant label is rendered for every row on the page. */
const FORMATTER_CACHE = new Map<
  Locale,
  {
    dateTime: Intl.DateTimeFormat;
    date: Intl.DateTimeFormat;
    day: Intl.DateTimeFormat;
  }
>();

function dateFormatters(locale: Locale) {
  const cached = FORMATTER_CACHE.get(locale);
  if (cached) return cached;
  const built = {
    dateTime: new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }),
    date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    day: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
  };
  FORMATTER_CACHE.set(locale, built);
  return built;
}

/**
 * Whether a boundary sits on the edge of a day in the reader's own timezone —
 * the two instants a whole-day window is stored as. Printing "12:00 AM" or
 * "11:59 PM" tells them nothing they didn't already know from the date, and it
 * is most of the label's width.
 */
function isDayBoundary(d: Date): boolean {
  const h = d.getHours();
  const m = d.getMinutes();
  return (h === 0 && m === 0) || (h === 23 && m === 59);
}

const parseDate = (iso: string): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Render a `start`/`end` ISO-date pair as a compact range — used by deco's
 * built-in date matcher AND by any custom matcher whose rule happens to
 * carry the same field names (e.g. project-defined `Date` / `Birthday`
 * matchers that don't share resolveType with the website package). Returns
 * null when the rule has no readable date fields so callers can fall back.
 */
function formatDateRange(rule: Record<string, unknown>): string | null {
  const { start, end } = rule as { start?: unknown; end?: unknown };
  const startDate = parseDate(typeof start === "string" ? start : "");
  const endDate = parseDate(typeof end === "string" ? end : "");
  if (!startDate && !endDate) return null;

  const present = [startDate, endDate].filter((d): d is Date => d !== null);
  const wholeDay = present.every(isDayBoundary);
  const sameYear =
    startDate !== null &&
    endDate !== null &&
    startDate.getFullYear() === endDate.getFullYear();

  const formatters = dateFormatters(readLanguage());
  const fmt = (d: Date, dropYear: boolean) =>
    wholeDay
      ? (dropYear ? formatters.day : formatters.date).format(d)
      : formatters.dateTime.format(d);

  if (startDate && endDate) {
    return `${fmt(startDate, wholeDay && sameYear)} → ${fmt(endDate, false)}`;
  }
  if (startDate) {
    return translate("sectionsEditor.formatMatcher.fromDate", {
      date: fmt(startDate, false),
    });
  }
  return translate("sectionsEditor.formatMatcher.untilDate", {
    date: fmt(endDate!, false),
  });
}

export function formatMatcher(
  rule: Record<string, unknown> | undefined,
  depth = 0,
): string {
  if (!rule) return "Default";
  if (depth > MAX_FORMAT_DEPTH) return "...";
  const rt = (rule.__resolveType as string) ?? "";

  const alwaysTypes = [
    "website/matchers/always.ts",
    "$live/matchers/MatchAlways.ts",
  ];
  if (alwaysTypes.includes(rt) || rt === "") return "Default";

  switch (rt) {
    case "website/matchers/never.ts":
      return "Hidden";

    case "website/matchers/device.ts":
    case "$live/matchers/MatchDevice.ts": {
      const {
        mobile,
        tablet,
        desktop,
        devices: devList = [],
      } = rule as {
        mobile?: boolean;
        tablet?: boolean;
        desktop?: boolean;
        devices?: string[];
      };
      const devices = [...(devList as string[])];
      if (mobile) devices.push("Mobile");
      if (tablet) devices.push("Tablet");
      if (desktop) devices.push("Desktop");
      return devices.length > 0
        ? devices.map(capitalize).join(" & ")
        : labelFromResolveType(rt);
    }

    case "website/matchers/date.ts":
    case "$live/matchers/MatchDate.ts":
      return formatDateRange(rule) ?? labelFromResolveType(rt);

    case "website/matchers/random.ts":
    case "$live/matchers/MatchRandom.ts": {
      const { traffic } = rule as { traffic?: number };
      if (typeof traffic === "number") {
        return `${Math.ceil(traffic * 100)}% of sessions`;
      }
      return labelFromResolveType(rt);
    }

    case "website/matchers/host.ts":
    case "$live/matchers/MatchHost.ts": {
      const { includes, match } = rule as {
        includes?: string;
        match?: string;
      };
      const parts: string[] = [];
      if (includes) parts.push(includes);
      if (match) parts.push(match);
      return parts.length > 0 ? parts.join(" - ") : labelFromResolveType(rt);
    }

    case "website/matchers/pathname.ts": {
      const caseObj = rule.case as
        | { type?: string; pathname?: string }
        | undefined;
      const { type, pathname } = caseObj ?? {};
      if (type && pathname) return `Pathname ${type} ${pathname}`;
      return labelFromResolveType(rt);
    }

    case "website/matchers/location.ts":
    case "$live/matchers/MatchLocation.ts": {
      const { includeLocations, excludeLocations } = rule as {
        includeLocations?: Array<{
          city?: string;
          regionCode?: string;
          country?: string;
        }>;
        excludeLocations?: Array<{
          city?: string;
          regionCode?: string;
          country?: string;
        }>;
      };
      const fmtLoc = (loc: {
        city?: string;
        regionCode?: string;
        country?: string;
      }) => [loc.city, loc.regionCode, loc.country].filter(Boolean).join(" - ");
      const first = includeLocations?.[0];
      if (first) {
        const rest = (includeLocations?.length ?? 0) - 1;
        return `${fmtLoc(first)}${rest > 0 ? ` +${rest}` : ""}`;
      }
      const firstEx = excludeLocations?.[0];
      if (firstEx) {
        const rest = (excludeLocations?.length ?? 0) - 1;
        return `Except ${fmtLoc(firstEx)}${rest > 0 ? ` +${rest}` : ""}`;
      }
      return "Any location";
    }

    case "website/matchers/multi.ts":
    case "$live/matchers/MatchMulti.ts": {
      const { matchers, op = "AND" } = rule as {
        matchers?: Array<Record<string, unknown>>;
        op?: string;
      };
      if (matchers && matchers.length > 0) {
        const safeOp = op === "OR" ? "OR" : "AND";
        return matchers
          .map((m) => {
            const text = formatMatcher(m, depth + 1);
            return childNeedsParens(m, safeOp) ? `(${text})` : text;
          })
          .join(` ${safeOp} `);
      }
      return labelFromResolveType(rt);
    }

    default: {
      // Project-defined matchers (e.g. "Date", "Birthday") don't share
      // resolveType with the website package, so generic field inspection
      // is the only way to surface their actual configuration on the tab.
      const range = formatDateRange(rule);
      if (range) return range;
      return labelFromResolveType(rt) || "Default";
    }
  }
}
