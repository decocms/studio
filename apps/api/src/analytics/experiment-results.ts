/**
 * EXPERIMENT_RESULTS from Deco Analytics, for a site the OneDollarStats path
 * has nothing for: the read surface's `experimentResults` view, read with the
 * token, tenancy guard (`analyticsAccess`) and `usageScope` check the
 * Analytics tab's `/data` proxy uses. Arms are the experiment's `exp` values
 * and visitors are human visitor-days, never people: the id rotates daily.
 */

import { z } from "zod";
import type { StudioContext } from "../core/studio-context";
import { experimentStats, type Variant } from "../deco-legacy/ab-test";
import type { ExperimentResults } from "../deco-legacy/experiment-analytics";
import { getSettings } from "../settings";
import { analyticsAccess, isTenantScoped } from "./access";
import { readAnalyticsRegistration } from "./registration";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The read surface refuses a longer window. */
const MAX_DAYS = 31;
const DEFAULT_DAYS = 30;
/** `expBehaviour` scans raw events: ~11 s for the largest site over 31 days. */
const TIMEOUT_MS = 30_000;
/** The shapes the read surface accepts (`experimentResultsParams`). */
const EXPERIMENT_KEY = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const EVENT_NAME = /^\$?[a-z][a-z0-9_]{0,39}$/;
const MAX_GOALS = 10;
const PURCHASE = "purchase";
const EXPOSURE = "experience_impression";
const VISITORS_GOAL = "visitors";

/** ClickHouse answers UInt64 as a string. */
const count = z.coerce.number().catch(0);
const Measures = z.object({
  variant: z.string(),
  visitors: count,
  converters: z.record(z.string(), count).catch({}),
  purchases: count,
  revenue: count,
  exposed: count.optional(),
  convertersExposed: z.record(z.string(), count).optional(),
});
const Behaviour = z.object({
  pageviewsPerVisitor: count,
  activeSecondsPerVisitor: count,
  clicksPerVisitor: count,
  medianScrollDepth: count,
  errorPct: count,
});
/** A panel that failed upstream comes back as `[]` (named in `panelErrors`). */
const Payload = z.object({
  expResults: z.array(Measures),
  expDaily: z.array(Measures.extend({ day: z.string() })).catch([]),
  expBehaviour: z.array(Behaviour.extend({ variant: z.string() })).catch([]),
  currency: z.string().nullable().catch(null).optional(),
});
type Payload = z.infer<typeof Payload>;

interface ExperimentArm {
  id: string;
  visitors: number;
  /** Converters on `statsGoal` among every visitor. */
  converters: number;
  /** Null when the experiment has no exposure event among its goals. */
  exposed: number | null;
  /** Converters on `statsGoal` among the exposed. */
  convertersAmongExposed: number | null;
  purchases: number;
  revenue: number;
  behaviour: z.infer<typeof Behaviour> | null;
  /** The arm's `expDaily` rows, oldest first: the same counts per UTC day. */
  daily: ArmDay[];
}

interface ArmDay {
  date: string;
  visitors: number;
  exposed: number | null;
  /** Converters on `statsGoal` among every visitor. */
  converters: number;
  convertersAmongExposed: number | null;
}

type DecoExperimentResults = ExperimentResults & {
  /** The goal the timeseries (unless it plots visitors) and statistics use. */
  statsGoal: string;
  arms: ExperimentArm[];
  /** The currency the read surface scoped revenue to, when it names one. */
  currency: string | null;
};

interface DecoExperimentInput {
  slug: string;
  key: string;
  goals: string[];
  goalOnDash: string;
  variants: { id: string; role?: string | null }[];
  startedAt: string | null;
  since?: string;
  until?: string;
}

/** Event names the read surface can count, at most 10: `purchase`, the
 *  statistics goal and the exposure event first, so the cap never drops them. */
export function decoGoals(goals: string[], goalOnDash: string): string[] {
  const valid = goals.filter((g) => g !== VISITORS_GOAL && EVENT_NAME.test(g));
  const pinned = [goalOnDash, EXPOSURE].filter((g) => valid.includes(g));
  return [...new Set([PURCHASE, ...pinned, ...valid])].slice(0, MAX_GOALS);
}

/** A closed window on the hour, at most 31 days, ending now: from the asked
 *  day, else the experiment's start, else the last 30 days. */
export function decoWindow(
  input: Pick<DecoExperimentInput, "startedAt" | "since" | "until">,
  now: Date,
): { from: string; to: string } {
  const hour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;
  const nowHour = hour(now.getTime());
  const to = input.until
    ? Math.min(Date.parse(`${input.until}T00:00:00Z`) + DAY_MS, nowHour)
    : nowHour;
  const start = Date.parse(
    input.since ? `${input.since}T00:00:00Z` : (input.startedAt ?? ""),
  );
  const from = Math.max(
    Number.isFinite(start) ? hour(start) : to - DEFAULT_DAYS * DAY_MS,
    to - MAX_DAYS * DAY_MS,
  );
  const iso = (ms: number) => new Date(ms).toISOString();
  return { from: iso(Math.min(from, to - HOUR_MS)), to: iso(to) };
}

/** The read surface's answer in EXPERIMENT_RESULTS' shape: `default` is the
 *  control arm (role `control`, else the first configured), `variant` the
 *  treatment. */
function toExperimentResults(
  payload: Payload,
  input: Pick<DecoExperimentInput, "goalOnDash" | "variants"> & {
    goals: string[];
  },
): DecoExperimentResults {
  const ids = input.variants.map((v) => v.id);
  const control =
    input.variants.find((v) => v.role === "control")?.id ?? ids[0];
  const treatment =
    input.variants.find((v) => v.role === "treatment")?.id ??
    ids.find((id) => id !== control);
  const statsGoal = input.goals.includes(input.goalOnDash)
    ? input.goalOnDash
    : PURCHASE;

  const byId = new Map(payload.expResults.map((r) => [r.variant, r]));
  const zero: z.infer<typeof Measures> = {
    variant: "",
    visitors: 0,
    converters: {},
    purchases: 0,
    revenue: 0,
  };
  const row = (id: string | undefined) => (id && byId.get(id)) || zero;
  const pair = (value: (r: z.infer<typeof Measures>) => number) => ({
    default: value(row(control)),
    variant: value(row(treatment)),
  });

  const hasExposure = payload.expResults.some((r) => r.exposed !== undefined);
  const behaviour = new Map(
    payload.expBehaviour.map(({ variant, ...b }) => [variant, b]),
  );
  const days = [...payload.expDaily].sort((a, b) => a.day.localeCompare(b.day));
  const arms = ids.map((id): ExperimentArm => {
    const r = row(id);
    return {
      id,
      visitors: r.visitors,
      converters: r.converters[statsGoal] ?? 0,
      exposed: hasExposure ? (r.exposed ?? 0) : null,
      convertersAmongExposed: hasExposure
        ? (r.convertersExposed?.[statsGoal] ?? 0)
        : null,
      purchases: r.purchases,
      revenue: r.revenue,
      behaviour: behaviour.get(id) ?? null,
      daily: days
        .filter((d) => d.variant === id)
        .map((d) => ({
          date: d.day,
          visitors: d.visitors,
          exposed: hasExposure ? (d.exposed ?? 0) : null,
          converters: d.converters[statsGoal] ?? 0,
          convertersAmongExposed: hasExposure
            ? (d.convertersExposed?.[statsGoal] ?? 0)
            : null,
        })),
    };
  });

  const plotted = (r: z.infer<typeof Measures>) =>
    input.goalOnDash === VISITORS_GOAL
      ? r.visitors
      : (r.converters[statsGoal] ?? 0);
  const byDate = new Map<string, { default: number; variant: number }>();
  for (const r of payload.expDaily) {
    const side =
      r.variant === control
        ? "default"
        : r.variant === treatment
          ? "variant"
          : null;
    if (!side) continue;
    const entry = byDate.get(r.day) ?? { default: 0, variant: 0 };
    entry[side] += plotted(r);
    byDate.set(r.day, entry);
  }

  // Among the exposed once the exposure event fired: it is the population the
  // treatment could change. Before that, among every visitor.
  const visitors = pair((r) => r.visitors);
  const exposed = pair((r) => r.exposed ?? 0);
  const onExposed = hasExposure && exposed.default + exposed.variant > 0;
  const arm = (side: "default" | "variant"): Variant => {
    const r = row(side === "default" ? control : treatment);
    return onExposed
      ? {
          successes: r.convertersExposed?.[statsGoal] ?? 0,
          total: exposed[side],
        }
      : { successes: r.converters[statsGoal] ?? 0, total: visitors[side] };
  };

  return {
    visitors,
    goals: [
      { goal: VISITORS_GOAL, ...visitors },
      ...input.goals.map((goal) => ({
        goal,
        ...pair((r) => r.converters[goal] ?? 0),
      })),
    ],
    timeseries: [...byDate.entries()]
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    stats: experimentStats(
      arm("default"),
      arm("variant"),
      visitors.default + visitors.variant,
    ),
    statsGoal,
    arms,
    currency: payload.currency ?? null,
  };
}

/**
 * The experiment's results from Deco Analytics, or null when the site has no
 * registration the org can read, the read surface isn't configured, has no
 * rows for the experiment's configured arms, or fails. Never throws: the
 * caller then answers as before.
 */
export async function readDecoExperimentResults(
  ctx: StudioContext,
  organizationId: string,
  input: DecoExperimentInput,
  now = new Date(),
): Promise<DecoExperimentResults | null> {
  const { analyticsDataUrl, analyticsMasterToken } = getSettings();
  if (!analyticsDataUrl || !analyticsMasterToken) return null;
  if (!EXPERIMENT_KEY.test(input.key)) return null;
  try {
    const access = await analyticsAccess(ctx, organizationId, input.slug);
    if (!access || access.kind === "error") return null;
    let siteId = access.kind === "external" ? access.siteId : null;
    if (!siteId) {
      const registration = await readAnalyticsRegistration(input.slug);
      if (registration.status !== "registered") return null;
      siteId = registration.id;
    }

    const goals = decoGoals(input.goals, input.goalOnDash);
    const window = decoWindow(input, now);
    const url = new URL(`${analyticsDataUrl}/data`);
    url.search = new URLSearchParams({
      view: "experimentResults",
      site: siteId,
      experiment: input.key,
      from: window.from,
      to: window.to,
      goals: goals.join(","),
      ...(goals.includes(EXPOSURE) ? { exposure: EXPOSURE } : {}),
      behaviour: "true",
    }).toString();
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${analyticsMasterToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(
        `[experiments] Deco Analytics HTTP ${res.status} for site="${input.slug}"`,
      );
      return null;
    }
    if (!isTenantScoped(body, siteId)) {
      console.error(
        `[experiments] refusing unscoped Deco Analytics payload for site="${input.slug}" (${siteId})`,
      );
      return null;
    }
    const parsed = Payload.safeParse(body);
    if (!parsed.success) {
      console.error(
        `[experiments] invalid Deco Analytics payload for site="${input.slug}":`,
        parsed.error.issues,
      );
      return null;
    }
    // Rows for arms the experiment doesn't configure (stale or unknown) would
    // map to an all-zero answer that hides the legacy outcome.
    const ids = new Set(input.variants.map((v) => v.id));
    if (!parsed.data.expResults.some((r) => ids.has(r.variant))) return null;
    return toExperimentResults(parsed.data, { ...input, goals });
  } catch (err) {
    console.error(
      `[experiments] Deco Analytics read failed for site="${input.slug}":`,
      err,
    );
    return null;
  }
}
