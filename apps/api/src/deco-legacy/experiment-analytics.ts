/**
 * A/B experiment results — the native port of the deco.cx admin's Experiments
 * dashboard math (`decocms/admin-mcp/api/tools/experiments.ts` →
 * `experiment_results`), reading the SAME OneDollarStats (Plausible-compatible)
 * backend Studio's Monitor "Analytics" tab already reads.
 *
 * The traffic split is recorded as an event custom-property whose key is the
 * matcher block id: `event:props:<key>` = "true" (drawn in) | "false"
 * (default). Results are per-goal visitor counts for each variant, a daily
 * timeseries for the selected goal, and the A/B statistics (see ./ab-test.ts).
 *
 * Unconfigured (no ONEDOLLAR_BACKEND_API_KEY, or the site resolves to no host)
 * returns `null` — the caller renders an unavailable/empty state, never a wrong
 * zero. Env + host resolution mirror `api/routes/monitor.ts`.
 */

import { getSettings } from "../settings";
import { analyticsQuery, isAnalyticsConfigured } from "./clickhouse-analytics";
import { toOneDollarHostname } from "./onedollarstats";
import { pBetter, sampleSize as sampleSizeOf, type Variant } from "./ab-test";

const OD_API = "https://deco.lilstts.com/plausible";
const OD_TIMEOUT_MS = 12_000;
/** OneDollarStats hosts queried at once — each is a separate third-party POST. */
const CONCURRENCY = 6;
/** "visitors" is the implicit baseline goal — every stat is relative to it. */
const VISITORS_GOAL = "visitors";

const SITE_SCOPE =
  "site_id IN (SELECT id FROM default.dim_sites WHERE name = {slug:String})";

export interface ExperimentResults {
  visitors: { default: number; variant: number };
  goals: { goal: string; default: number; variant: number }[];
  timeseries: { date: string; default: number; variant: number }[];
  stats: {
    totalParticipants: number;
    sampleSize: number;
    probabilityVariantBest: number;
    probabilityDefaultBest: number;
  };
}

export interface ExperimentResultsInput {
  slug: string;
  /** Experiment key — the `event:props:<key>` the variants are split on. */
  testName: string;
  /** Inclusive window, `YYYY-MM-DD`. */
  since: string;
  until: string;
  /** Goals to aggregate conversions for (the visitors baseline is implicit). */
  goals: string[];
  /** Goal plotted in the timeseries and used for the statistics. */
  goalOnDash: string;
}

interface OdRow {
  dimensions: string[];
  metrics: number[];
}

/**
 * The site's OneDollarStats hosts (busiest first, `www.` variant, deduped).
 * Resolved from the warehouse domain set — no Supabase, same bridge Monitor and
 * Infra Billing use. Empty when the warehouse isn't wired.
 */
async function siteOdHosts(
  slug: string,
  since: string,
  until: string,
): Promise<string[]> {
  const rows = await analyticsQuery<{ host: string }>(
    `SELECT host
       FROM default.fact_usage_daily_view
      WHERE ${SITE_SCOPE}
        AND date >= {since:Date} AND date <= {until:Date}
      GROUP BY host
      ORDER BY sum(requests) DESC
      LIMIT 25`,
    { slug, since, until },
  );
  return [
    ...new Set(rows.map((r) => toOneDollarHostname(r.host)).filter(Boolean)),
  ];
}

type PFilter = [string, string, string[]];

/**
 * Compute experiment results. Sums across every host the site is served on so a
 * www/apex split doesn't halve the counts. Returns `null` when unconfigured or
 * the site resolves to no host.
 */
export async function queryExperimentResults(
  input: ExperimentResultsInput,
): Promise<ExperimentResults | null> {
  const apiKey = getSettings().oneDollarStatsApiKey;
  if (!apiKey || !isAnalyticsConfigured()) return null;

  const { slug, testName, since, until, goalOnDash } = input;
  const hosts = await siteOdHosts(slug, since, until);
  if (hosts.length === 0) return null;

  const propKey = `event:props:${testName}`;
  const dateRange: [string, string] = [since, until];

  // Always include the visitors baseline — the statistics depend on it.
  const goals = Array.from(new Set([VISITORS_GOAL, ...input.goals]));

  /** One Plausible query per host, summed. Failures on a host count as 0. */
  const run = async (
    metrics: string[],
    dimensions: string[],
    filters: PFilter[],
  ): Promise<OdRow[]> => {
    const out: OdRow[] = [];
    for (let i = 0; i < hosts.length; i += CONCURRENCY) {
      const batch = await Promise.all(
        hosts.slice(i, i + CONCURRENCY).map(async (host) => {
          const res = await fetch(OD_API, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              Accept: "application/json",
            },
            body: JSON.stringify({
              site_id: host,
              metrics,
              date_range: dateRange,
              ...(dimensions.length ? { dimensions } : {}),
              ...(filters.length ? { filters } : {}),
              pagination: { limit: 10000, offset: 0 },
            }),
            signal: AbortSignal.timeout(OD_TIMEOUT_MS),
          }).catch(() => null);
          if (!res || !res.ok) return [] as OdRow[];
          const payload = (await res.json().catch(() => null)) as {
            results?: OdRow[];
          } | null;
          return payload?.results ?? [];
        }),
      );
      for (const rows of batch) out.push(...rows);
    }
    return out;
  };

  // The variant flag lives in the event prop: "true" = test, "false" = default.
  const aggregate = async (goal: string, variant: string): Promise<number> => {
    const isVisitors = goal === VISITORS_GOAL;
    const rows = await run(
      ["visitors"],
      [propKey, ...(isVisitors ? [] : ["event:goal"])],
      [
        ["is", propKey, [variant]],
        ...(isVisitors ? [] : ([["is", "event:goal", [goal]]] as PFilter[])),
      ],
    );
    return rows.reduce((acc, r) => acc + (r.metrics?.[0] ?? 0), 0);
  };

  const timeseries = async (variant: string): Promise<OdRow[]> => {
    const isVisitors = goalOnDash === VISITORS_GOAL;
    return run(
      ["visitors"],
      ["time:day", propKey, ...(isVisitors ? [] : ["event:goal"])],
      [
        ["is", propKey, [variant]],
        ...(isVisitors
          ? []
          : ([["is", "event:goal", [goalOnDash]]] as PFilter[])),
      ],
    );
  };

  const [goalCounts, tsDefault, tsVariant] = await Promise.all([
    Promise.all(
      goals.map(async (goal) => ({
        goal,
        variant: await aggregate(goal, "true"),
        default: await aggregate(goal, "false"),
      })),
    ),
    timeseries("false"),
    timeseries("true"),
  ]);

  const visitorsRow = goalCounts.find((g) => g.goal === VISITORS_GOAL);
  const visitors = {
    default: visitorsRow?.default ?? 0,
    variant: visitorsRow?.variant ?? 0,
  };

  // Merge the two variant timeseries by day (summed across hosts already).
  const byDate = new Map<string, { default: number; variant: number }>();
  for (const row of tsDefault) {
    const date = row.dimensions?.[0]?.split(" ")[0] ?? "";
    if (!date) continue;
    const entry = byDate.get(date) ?? { default: 0, variant: 0 };
    entry.default += row.metrics?.[0] ?? 0;
    byDate.set(date, entry);
  }
  for (const row of tsVariant) {
    const date = row.dimensions?.[0]?.split(" ")[0] ?? "";
    if (!date) continue;
    const entry = byDate.get(date) ?? { default: 0, variant: 0 };
    entry.variant += row.metrics?.[0] ?? 0;
    byDate.set(date, entry);
  }
  const mergedTimeseries = Array.from(byDate.entries())
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const successDefault = tsDefault.reduce(
    (acc, r) => acc + (r.metrics?.[0] ?? 0),
    0,
  );
  const successVariant = tsVariant.reduce(
    (acc, r) => acc + (r.metrics?.[0] ?? 0),
    0,
  );
  const defaultVariant: Variant = {
    successes: successDefault,
    total: visitors.default,
  };
  const testVariant: Variant = {
    successes: successVariant,
    total: visitors.variant,
  };

  const rawSampleSize = sampleSizeOf(defaultVariant, testVariant);
  const size =
    rawSampleSize == null || Number.isNaN(rawSampleSize) ? 1000 : rawSampleSize;
  const probabilityVariantBest = pBetter(defaultVariant, testVariant);

  return {
    visitors,
    goals: goalCounts,
    timeseries: mergedTimeseries,
    stats: {
      totalParticipants: visitors.default + visitors.variant,
      sampleSize: size,
      probabilityVariantBest,
      probabilityDefaultBest: 1 - probabilityVariantBest,
    },
  };
}
