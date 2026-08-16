/**
 * Infra billing for a legacy deco.cx site: the daily CDN + shared-infra usage
 * the platform bills on, the site's plan, and its issued invoices.
 *
 * Ported from the deco.cx admin's billing dashboard, with two differences:
 *  - scoped to ONE site (admin aggregated a whole legacy "team"), because
 *    Studio's tenancy unit is the org's `org_sites` claim, not the legacy team;
 *  - read-only. Plan changes / checkout stay in the legacy admin.
 *
 * Every external read fails soft: an unconfigured or broken warehouse yields an
 * empty dashboard, never a 500. Callers must have already authorized the org's
 * ownership of the slug (see org_sites).
 */

import { analyticsQuery, isAnalyticsConfigured } from "./clickhouse-analytics";
import { dailyPageviews, toOneDollarHostname } from "./onedollarstats";
import { getDecoSupabaseConfig, supabaseGet } from "./supabase";
import { retrieveSubscription } from "../billing/stripe-api";

/** Legacy plan ids, from the deco.cx `plans` table. */
const PLAN_IDS = { PRO: 5, ENTERPRISE: 6, FULL_ACCESS: 420 } as const;

export type PlanType = "free" | "pro" | "enterprise";

export interface DailyUsage {
  date: string;
  requests: number;
  /** Egress only — `bandwidth_bytes` is what both usage views expose. */
  dataTransferBytes: number;
  pageviews: number;
}

export interface LegacyInvoice {
  id: string;
  status: string;
  dueDate: string | null;
  value: number;
  referenceMonth: string | null;
  /** Fiscal-note (nota fiscal) PDF, when issued. */
  nfUrl: string | null;
  bankSlipUrl: string | null;
}

/**
 * Why `billing` is null. The UI must not tell a user to "narrow the selection"
 * when the real cause is a dead warehouse or a team they only partly own.
 */
export type BillingUnavailableReason =
  | "no_team"
  | "multiple_teams"
  | "partial_team"
  | "unavailable";

/**
 * Plan and invoices belong to the legacy TEAM, not the site, so they only make
 * sense when every selected site rolls up to the same team — null otherwise.
 */
export interface LegacyTeamBilling {
  planType: PlanType;
  invoices: LegacyInvoice[];
  /** "YYYY-MM-DD", or null when nothing schedules a next charge. */
  nextBillingDate: string | null;
  /** Whether `INFRA_BILLING_PORTAL` has a Stripe customer to open for. */
  canManageSubscription: boolean;
}

export interface SiteInfraBilling {
  siteSlugs: string[];
  /** First and last day of the reported month, "YYYY-MM-DD". */
  since: string;
  until: string;
  usage: DailyUsage[];
  /** False when no pageview source answered — the UI must render "—", not 0. */
  pageviewsAvailable: boolean;
  billing: LegacyTeamBilling | null;
  /** Set whenever `billing` is null, so the UI can say which cause it was. */
  billingUnavailableReason: BillingUnavailableReason | null;
  /**
   * True when usage could not be read at all — warehouse unconfigured OR the
   * query failed. Either way the zeros in `usage` are absence of data, not
   * absence of traffic, and the UI must not render them as a real bill.
   */
  usageUnavailable: boolean;
}

/** UTC first/last day of the month containing `date`, as "YYYY-MM-DD". */
export function monthInterval(date: Date): { since: string; until: string } {
  const since = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
  );
  const until = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  );
  return {
    since: since.toISOString().slice(0, 10),
    until: until.toISOString().slice(0, 10),
  };
}

interface UsageRow {
  date: string;
  requests: string | number;
  egress_bytes: string | number;
}

/** Hosts fanned out to. Bounds both the `IN` list and the pageview requests. */
const MAX_HOSTNAMES = 25;

/**
 * Busiest distinct hosts across the whole selection. Deduped on purpose: two
 * sites can share an origin host, and counting that host's shared-infra traffic
 * (or its pageviews) twice would inflate the total.
 */
async function siteHostnames(
  siteSlugs: string[],
  since: string,
  until: string,
): Promise<string[]> {
  const rows = await analyticsQuery<{ host: string }>(
    `SELECT host
       FROM default.fact_usage_daily_view
      WHERE site_id IN (SELECT id FROM default.dim_sites WHERE name IN ({sites:Array(String)}))
        AND date >= {since:Date} AND date <= {until:Date}
      GROUP BY host
      ORDER BY sum(requests) DESC
      LIMIT {limit:UInt32}`,
    { sites: siteSlugs, since, until, limit: MAX_HOSTNAMES },
  );
  return rows.map((r) => r.host).filter(Boolean);
}

/**
 * Sum CDN and shared-infra rows into date → totals. Both are part of what the
 * platform bills; reporting CDN alone understates the bill.
 */
export function aggregateUsage(
  rows: UsageRow[],
): Map<string, { requests: number; bytes: number }> {
  const byDate = new Map<string, { requests: number; bytes: number }>();
  for (const row of rows) {
    // ClickHouse returns sums as strings in JSONEachRow; dates may carry a time.
    const date = String(row.date).slice(0, 10);
    const current = byDate.get(date) ?? { requests: 0, bytes: 0 };
    current.requests += Number(row.requests) || 0;
    current.bytes += Number(row.egress_bytes) || 0;
    byDate.set(date, current);
  }
  return byDate;
}

/** CDN usage, keyed by site. */
function cdnUsageRows(
  siteSlugs: string[],
  since: string,
  until: string,
): Promise<UsageRow[]> {
  return analyticsQuery<UsageRow>(
    `SELECT date,
            sum(requests) AS requests,
            sum(bandwidth_bytes) AS egress_bytes
       FROM default.fact_usage_daily_view
      WHERE site_id IN (SELECT id FROM default.dim_sites WHERE name IN ({sites:Array(String)}))
        AND date >= {since:Date} AND date <= {until:Date}
      GROUP BY date`,
    { sites: siteSlugs, since, until },
  );
}

/** Shared-infra usage, attributable to a site only through its origin hosts. */
function sharedInfraUsageRows(
  hostnames: string[],
  since: string,
  until: string,
): Promise<UsageRow[]> {
  if (hostnames.length === 0) return Promise.resolve([]);
  return analyticsQuery<UsageRow>(
    `SELECT date,
            sum(requests) AS requests,
            sum(bandwidth_bytes) AS egress_bytes
       FROM default.fact_shared_infra_usage_daily_view
      WHERE origin_host IN ({hostnames:Array(String)})
        AND date >= {since:Date} AND date <= {until:Date}
      GROUP BY date`,
    { hostnames, since, until },
  );
}

/** Every UTC day in [since, until], so a gap in the facts renders as a zero. */
export function dateRange(since: string, until: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${since}T00:00:00Z`);
  const last = new Date(`${until}T00:00:00Z`);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

interface LegacySubscriptionRow {
  plan: number | null;
  status: string | null;
}

interface LegacyInvoiceRow {
  id: string | number;
  status: string | null;
  due_date: string | null;
  value: number | null;
  reference_month: string | null;
  nf_url: string | null;
  bank_slip_url: string | null;
}

export function planTypeOf(
  subscription: LegacySubscriptionRow | undefined,
): PlanType {
  if (!subscription?.plan) return "free";
  const live = subscription.status === "Live";
  if (subscription.plan === PLAN_IDS.FULL_ACCESS) return "enterprise";
  if (!live) return "free";
  if (subscription.plan === PLAN_IDS.ENTERPRISE) return "enterprise";
  if (subscription.plan === PLAN_IDS.PRO) return "pro";
  return "free";
}

/** Distinct legacy teams behind a set of sites, in one round trip. */
async function resolveTeamIds(siteSlugs: string[]): Promise<number[]> {
  const config = getDecoSupabaseConfig();
  if (!config || siteSlugs.length === 0) return [];
  const list = siteSlugs.map((s) => `"${encodeURIComponent(s)}"`).join(",");
  const rows = await supabaseGet<{ team: number | null }>(
    config.supabaseUrl,
    config.serviceKey,
    `sites?name=in.(${list})&select=team`,
  );
  return [...new Set(rows.map((r) => r.team).filter((t): t is number => !!t))];
}

/** Every site name belonging to a legacy team. */
async function teamSiteNames(teamId: number): Promise<string[]> {
  const config = getDecoSupabaseConfig();
  if (!config) return [];
  const rows = await supabaseGet<{ name: string | null }>(
    config.supabaseUrl,
    config.serviceKey,
    `sites?team=eq.${teamId}&select=name`,
  );
  return rows.map((r) => r.name).filter((n): n is string => !!n);
}

export type TeamScope =
  | { ok: true; teamId: number }
  | { ok: false; reason: BillingUnavailableReason };

/**
 * The legacy team behind `siteSlugs`, but ONLY if the org owns every site that
 * team has.
 *
 * Plan, invoices and the Stripe portal are team-scoped, while `org_sites` is a
 * per-slug claim — so owning one site of a shared team must not hand over the
 * team's invoices (which carry the paying entity's legal name and tax id) or a
 * portal session that can cancel a subscription paying for someone else's site.
 */
export async function resolveOwnedTeam(
  siteSlugs: string[],
  ownedSlugs: string[],
): Promise<TeamScope> {
  if (!getDecoSupabaseConfig()) return { ok: false, reason: "unavailable" };

  const teams = await resolveTeamIds(siteSlugs);
  if (teams.length === 0) return { ok: false, reason: "no_team" };
  if (teams.length > 1) return { ok: false, reason: "multiple_teams" };

  const teamId = teams[0]!;
  const owned = new Set(ownedSlugs);
  const teamSites = await teamSiteNames(teamId);
  if (teamSites.length === 0 || !teamSites.every((name) => owned.has(name))) {
    return { ok: false, reason: "partial_team" };
  }
  return { ok: true, teamId };
}

/**
 * The Stripe subscription the legacy team pays with. Same Stripe account as
 * Studio's own billing, so `stripeSecretKey` can read it. Null for teams
 * billed outside Stripe (enterprise invoicing) — no portal, no period end.
 */
export async function teamStripeSubscriptionId(
  teamId: number,
): Promise<string | null> {
  const config = getDecoSupabaseConfig();
  if (!config) return null;
  const rows = await supabaseGet<{ stripe_subscription_id: string | null }>(
    config.supabaseUrl,
    config.serviceKey,
    `teams?id=eq.${teamId}&select=stripe_subscription_id&limit=1`,
  );
  return rows[0]?.stripe_subscription_id ?? null;
}

/** Enterprise bills on the 1st; everyone else on the Stripe period end. */
export function nextBillingDate(
  planType: PlanType,
  periodEndSeconds: number | undefined,
  now: Date,
): string | null {
  if (planType === "enterprise") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
      .toISOString()
      .slice(0, 10);
  }
  if (!periodEndSeconds) return null;
  return new Date(periodEndSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Only `https:` links are rendered. These strings come from an Airtable mirror,
 * not from Studio, and end up as an `<a href>`.
 */
function safeDocumentUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/** Some rows mirror this column from Airtable as a JSON array literal. */
function unwrapBankSlipUrl(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith('"')) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed) && typeof parsed[0] === "string") {
      return parsed[0];
    }
    return null;
  } catch {
    return null;
  }
}

/** Both spellings appear in the Airtable-mirrored status column. */
const CANCELED_STATUSES = new Set(["canceled", "cancelled"]);

/** Canceled invoices were never owed — the legacy admin hides them too. */
export function toInvoices(rows: LegacyInvoiceRow[]): LegacyInvoice[] {
  return rows
    .filter(
      (row) => !CANCELED_STATUSES.has((row.status ?? "").trim().toLowerCase()),
    )
    .map((row) => ({
      id: String(row.id),
      status: row.status ?? "",
      dueDate: row.due_date,
      value: Number(row.value) || 0,
      referenceMonth: row.reference_month,
      nfUrl: safeDocumentUrl(row.nf_url),
      bankSlipUrl: safeDocumentUrl(unwrapBankSlipUrl(row.bank_slip_url)),
    }));
}

async function loadPlanAndInvoices(
  teamId: number,
): Promise<LegacyTeamBilling | null> {
  const config = getDecoSupabaseConfig();
  if (!config) return null;

  const [subscriptions, invoiceRows, stripeSubscriptionId] = await Promise.all([
    supabaseGet<LegacySubscriptionRow>(
      config.supabaseUrl,
      config.serviceKey,
      `subscriptions?team=eq.${teamId}&select=plan,status&limit=1`,
    ),
    supabaseGet<LegacyInvoiceRow>(
      config.supabaseUrl,
      config.serviceKey,
      `invoices?team=eq.${teamId}&select=id,status,due_date,value,reference_month,nf_url,bank_slip_url&order=reference_month.desc&limit=60`,
    ),
    teamStripeSubscriptionId(teamId),
  ]);

  const planType = planTypeOf(subscriptions[0]);
  const stripeSubscription = stripeSubscriptionId
    ? await retrieveSubscription(stripeSubscriptionId).catch((err) => {
        console.error("[deco-legacy] stripe subscription read failed:", err);
        return null;
      })
    : null;

  return {
    planType,
    nextBillingDate: nextBillingDate(
      planType,
      stripeSubscription?.current_period_end ??
        stripeSubscription?.items?.data?.[0]?.current_period_end,
      new Date(),
    ),
    canManageSubscription: planType !== "enterprise" && !!stripeSubscription,
    invoices: toInvoices(invoiceRows),
  };
}

/** Never report days that haven't happened yet — they'd plot as a crash to 0. */
export function clampUntil(until: string, now: Date): string {
  const today = now.toISOString().slice(0, 10);
  return until > today ? today : until;
}

export async function getSiteInfraBilling(params: {
  /** One or more sites the caller has already authorized; totals are summed. */
  siteSlugs: string[];
  /** Every slug the org owns — gates team-scoped plan/invoice/portal access. */
  ownedSlugs: string[];
  /** Any date inside the wanted month; defaults to the current month. */
  period?: string;
}): Promise<SiteInfraBilling> {
  const siteSlugs = [...new Set(params.siteSlugs)].sort();
  const periodDate = params.period ? new Date(params.period) : new Date();
  const now = new Date();
  const { since, until: monthEnd } = monthInterval(
    Number.isNaN(periodDate.getTime()) ? now : periodDate,
  );
  const until = clampUntil(monthEnd, now);

  const [usageResult, billingResult] = await Promise.all([
    (async () => {
      // The CDN query keys on site_id, so it needn't wait for the host lookup.
      const [cdnRows, hostnames] = await Promise.all([
        cdnUsageRows(siteSlugs, since, until),
        siteHostnames(siteSlugs, since, until),
      ]);
      const [sharedRows, pageviews] = await Promise.all([
        sharedInfraUsageRows(hostnames, since, until),
        dailyPageviews(hostnames.map(toOneDollarHostname), since, until),
      ]);
      return {
        infra: aggregateUsage([...cdnRows, ...sharedRows]),
        pageviews,
        failed: false,
      };
    })().catch((err) => {
      console.error("[deco-legacy] infra usage read failed:", err);
      return {
        infra: new Map<string, { requests: number; bytes: number }>(),
        pageviews: null,
        failed: true,
      };
    }),
    (async (): Promise<{
      billing: LegacyTeamBilling | null;
      reason: BillingUnavailableReason | null;
    }> => {
      const scope = await resolveOwnedTeam(siteSlugs, params.ownedSlugs);
      if (!scope.ok) return { billing: null, reason: scope.reason };
      const billing = await loadPlanAndInvoices(scope.teamId);
      return billing
        ? { billing, reason: null }
        : { billing: null, reason: "unavailable" };
    })().catch((err) => {
      console.error("[deco-legacy] plan/invoices read failed:", err);
      return { billing: null, reason: "unavailable" as const };
    }),
  ]);

  const usage: DailyUsage[] = dateRange(since, until).map((date) => {
    const infra = usageResult.infra.get(date);
    return {
      date,
      requests: infra?.requests ?? 0,
      dataTransferBytes: infra?.bytes ?? 0,
      pageviews: usageResult.pageviews?.get(date) ?? 0,
    };
  });

  return {
    siteSlugs,
    since,
    until,
    usage,
    pageviewsAvailable: usageResult.pageviews !== null,
    billing: billingResult.billing,
    billingUnavailableReason: billingResult.reason,
    // Not the same as a month with no traffic (a legit all-zeros dashboard).
    usageUnavailable: !isAnalyticsConfigured() || usageResult.failed,
  };
}
