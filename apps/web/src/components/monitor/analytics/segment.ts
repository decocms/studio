/**
 * The segment every Deco Analytics section reads with: filters, the conversion
 * goal, the currency money is shown in and the property the events section
 * lists. It lives in the URL (`f`, `goal`, `currency`, `prop`) so a segmented
 * screen is a link, and it carries across sections of the same project.
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/layouts/main-panel-tabs/analytics-tab";
import { KEYS } from "@/lib/query-keys";

export const FILTER_OPS = ["is", "not", "has", "starts"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** The read surface's filter dimensions (queries.mjs DIMENSIONS). */
export const FILTER_DIMS = [
  "path",
  "source",
  "channel",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "country",
  "region",
  "city",
  "device",
  "browser",
  "os",
  "name",
  "prop",
  "exp",
  "flag",
] as const;
export type FilterDim = (typeof FILTER_DIMS)[number];

export interface AnalyticsFilter {
  d: FilterDim;
  op: FilterOp;
  v: string;
}

export interface AnalyticsSegment {
  filters: AnalyticsFilter[];
  goal?: string;
  currency?: string;
  prop?: string;
}

export const EMPTY_SEGMENT: AnalyticsSegment = { filters: [] };

export function encodeFilter(f: AnalyticsFilter): string {
  return `${f.d}:${f.op}:${f.v}`;
}

function parseFilter(raw: string): AnalyticsFilter | null {
  const [d, op, ...rest] = raw.split(":");
  const v = rest.join(":");
  const dim = FILTER_DIMS.find((x) => x === d);
  const operator = FILTER_OPS.find((x) => x === op);
  return dim && operator && v ? { d: dim, op: operator, v } : null;
}

function sameFilter(a: AnalyticsFilter, b: AnalyticsFilter): boolean {
  return a.d === b.d && a.op === b.op && a.v === b.v;
}

/** The query string a view is read with, in a stable order for cache keys. */
function segmentParams(segment: AnalyticsSegment): URLSearchParams {
  const params = new URLSearchParams();
  for (const f of segment.filters) params.append("f", encodeFilter(f));
  if (segment.goal) params.set("goal", segment.goal);
  if (segment.currency) params.set("currency", segment.currency);
  if (segment.prop) params.set("prop", segment.prop);
  return params;
}

function readSegment(search: Record<string, unknown>): AnalyticsSegment {
  const raw = search.f;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    filters: list.flatMap((r) => {
      const f = typeof r === "string" ? parseFilter(r) : null;
      return f ? [f] : [];
    }),
    goal: str(search.goal),
    currency: str(search.currency),
    prop: str(search.prop),
  };
}

/** The URL search keys the segment owns, for callers that rebuild the search. */
export const SEGMENT_SEARCH_KEYS = ["f", "goal", "currency", "prop"] as const;

export function useAnalyticsSegment() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const segment = readSegment(search);

  const write = (next: AnalyticsSegment) => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        f: next.filters.length ? next.filters.map(encodeFilter) : undefined,
        goal: next.goal || undefined,
        currency: next.currency || undefined,
        prop: next.prop || undefined,
      }),
    });
  };

  return {
    segment,
    setSegment: (patch: Partial<AnalyticsSegment>) =>
      write({ ...segment, ...patch }),
    /** Clicking a row: add the filter, or remove it when it is already on. */
    toggleFilter: (f: AnalyticsFilter) =>
      write({
        ...segment,
        filters: segment.filters.some((x) => sameFilter(x, f))
          ? segment.filters.filter((x) => !sameFilter(x, f))
          : [...segment.filters, f],
      }),
    hasFilter: (f: AnalyticsFilter) =>
      segment.filters.some((x) => sameFilter(x, f)),
    clearFilters: () => write({ ...segment, filters: [] }),
  };
}

/** The BFF's `/analytics/data` envelope. */
export interface DecoViewResponse {
  registered?: boolean;
  view?: string;
  range?: string;
  data?: Record<string, unknown>;
}

/** One Deco Analytics view for the segment. Realtime polls every 5s. */
export function useDecoView(opts: {
  orgSlug: string;
  site: string;
  view: string;
  range: string;
  segment: AnalyticsSegment;
  enabled?: boolean;
}) {
  const live = opts.view === "live";
  const params = segmentParams(opts.segment);
  params.set("view", opts.view);
  params.set("range", opts.range);
  const qs = params.toString();
  return useQuery({
    queryKey: KEYS.analyticsView(opts.orgSlug, opts.site, qs),
    queryFn: async () =>
      (await fetchJson(
        `/api/${opts.orgSlug}/hosting/${encodeURIComponent(opts.site)}/analytics/data?${qs}`,
      )) as DecoViewResponse,
    enabled: opts.enabled ?? true,
    retry: false,
    staleTime: live ? 0 : 30_000,
    refetchInterval: live ? 5_000 : false,
    placeholderData: (prev) => prev,
  });
}

/** The values a dimension has in the range, for the filter builder. */
export function useFilterValues(opts: {
  orgSlug: string;
  site: string;
  dim: FilterDim | null;
  range: string;
}) {
  return useQuery({
    queryKey: KEYS.analyticsValues(
      opts.orgSlug,
      opts.site,
      opts.dim ?? "",
      opts.range,
    ),
    queryFn: async () =>
      (
        (await fetchJson(
          `/api/${opts.orgSlug}/hosting/${encodeURIComponent(opts.site)}/analytics/values?dim=${opts.dim}&range=${encodeURIComponent(opts.range)}`,
        )) as { values?: Array<{ k: string; n: number }> }
      ).values ?? [],
    enabled: Boolean(opts.dim),
    retry: false,
    staleTime: 60_000,
  });
}
