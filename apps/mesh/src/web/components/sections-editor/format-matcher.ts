import { labelFromResolveType } from "./section-types";

const capitalize = (s: string) =>
  s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

const MAX_FORMAT_DEPTH = 5;

const DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * Render a `start`/`end` ISO-date pair as a compact range — used by deco's
 * built-in date matcher AND by any custom matcher whose rule happens to
 * carry the same field names (e.g. project-defined `Date` / `Birthday`
 * matchers that don't share resolveType with the website package). Returns
 * null when the rule has no readable date fields so callers can fall back.
 */
function formatDateRange(rule: Record<string, unknown>): string | null {
  const { start, end } = rule as { start?: unknown; end?: unknown };
  const startStr = typeof start === "string" ? start : "";
  const endStr = typeof end === "string" ? end : "";
  if (!startStr && !endStr) return null;
  const tryFormat = (iso: string): string | null => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return DATE_FORMATTER.format(d);
  };
  const startFmt = tryFormat(startStr);
  const endFmt = tryFormat(endStr);
  if (startFmt && endFmt) return `${startFmt} → ${endFmt}`;
  if (startFmt) return `From ${startFmt}`;
  if (endFmt) return `Until ${endFmt}`;
  return null;
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
          .map((m) => formatMatcher(m, depth + 1))
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
