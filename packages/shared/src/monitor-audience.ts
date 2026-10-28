/**
 * Wire contract of the Monitor's audience reads
 * (`/api/:org/monitor/:site/audience`). One normalized shape whichever source
 * answered, so the UI never branches on the backend: a site registered in Deco
 * Analytics reads from it; any other site falls back to OneDollarStats until
 * that source is retired.
 */

export const AUDIENCE_VIEWS = [
  "summary",
  "timeline",
  "pages",
  "sources",
  "countries",
  "devices",
] as const;
export type AudienceView = (typeof AUDIENCE_VIEWS)[number];

export const AUDIENCE_RANGES = ["24h", "7d", "30d"] as const;
export type AudienceRange = (typeof AUDIENCE_RANGES)[number];

export type AudienceSource = "deco-analytics" | "onedollar";

/** Metrics a source does not report are null, never zero. */
export interface AudienceSummary {
  visitors: number;
  pageviews: number;
  sessions: number | null;
  /** Percent, 0–100. */
  bounceRate: number | null;
  visitDurationS: number | null;
}

export interface AudiencePoint {
  /** The bucket as the source labels it (`YYYY-MM-DD` or `YYYY-MM-DD HH:00:00`). */
  t: string;
  visitors: number;
  pageviews: number;
}

/** One entry of a ranked breakdown, busiest first. */
export interface AudienceRow {
  key: string;
  count: number;
}

export type AudienceData =
  | {
      view: "summary";
      summary: AudienceSummary;
      /** The window of equal length right before this one, when the source has it. */
      previous: AudienceSummary | null;
    }
  | { view: "timeline"; points: AudiencePoint[] }
  | {
      view: "pages" | "sources" | "countries" | "devices";
      rows: AudienceRow[];
    };

/**
 * How the source read the range. Deco Analytics reads a rolling window ending
 * now; OneDollarStats reads whole UTC days, so its `24h` is today so far.
 */
export type AudienceWindow =
  | { kind: "rolling"; range: AudienceRange }
  | { kind: "calendar"; since: string; until: string };

export type AudienceResponse =
  | { available: false; reason: "no-source" }
  | {
      available: true;
      source: AudienceSource;
      range: AudienceRange;
      window: AudienceWindow;
      data: AudienceData;
    };
