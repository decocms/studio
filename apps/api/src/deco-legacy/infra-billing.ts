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
  /** Egress + ingress; the platform bills them together as "data transfer". */
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
  /** True when the analytics warehouse isn't configured on this deployment. */
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
  ingress_bytes?: string | number;
}

/**
 * Distinct hosts across the whole selection. Deduped on purpose: two sites can
 * share an origin host, and counting that host's shared-infra traffic (or its
 * pageviews) twice would inflate the total.
 */
async function siteHostnames(
  siteSlugs: string[],
  since: string,
  until: string,
): Promise<string[]> {
  const rows = await analyticsQuery<{ host: string }>(
    `SELECT DISTINCT host
       FROM default.fact_usage_daily_view
      WHERE site_id IN (SELECT id FROM default.dim_sites WHERE name IN ({sites:Array(String)}))
        AND date >= {since:Date} AND date <= {until:Date}`,
    { sites: siteSlugs, since, until },
  );
  return rows.map((r) => r.host).filter(Boolean);
}

/**
 * CDN usage is keyed by site; shared-infra usage is keyed by origin hostname,
 * so it can only be attributed to a site through that site's hosts. Both are
 * part of what the platform bills — reporting CDN alone understates the bill.
 */
async function dailyInfraUsage(
  siteSlugs: string[],
  since: string,
  until: string,
  hostnames: string[],
): Promise<Map<string, { requests: number; bytes: number }>> {
  const [cdnRows, sharedRows] = await Promise.all([
    analyticsQuery<UsageRow>(
      `SELECT date,
              sum(requests) AS requests,
              sum(bandwidth_bytes) AS egress_bytes
         FROM default.fact_usage_daily_view
        WHERE site_id IN (SELECT id FROM default.dim_sites WHERE name IN ({sites:Array(String)}))
          AND date >= {since:Date} AND date <= {until:Date}
        GROUP BY date`,
      { sites: siteSlugs, since, until },
    ),
    hostnames.length
      ? analyticsQuery<UsageRow>(
          `SELECT date,
                  sum(requests) AS requests,
                  sum(bandwidth_bytes) AS egress_bytes
             FROM default.fact_shared_infra_usage_daily_view
            WHERE origin_host IN ({hostnames:Array(String)})
              AND date >= {since:Date} AND date <= {until:Date}
            GROUP BY date`,
          { hostnames, since, until },
        )
      : Promise.resolve([]),
  ]);

  const byDate = new Map<string, { requests: number; bytes: number }>();
  for (const row of [...cdnRows, ...sharedRows]) {
    const date = String(row.date);
    const current = byDate.get(date) ?? { requests: 0, bytes: 0 };
    current.requests += Number(row.requests) || 0;
    current.bytes +=
      (Number(row.egress_bytes) || 0) + (Number(row.ingress_bytes) || 0);
    byDate.set(date, current);
  }
  return byDate;
}

/** Every UTC day in [since, until], so a gap in the facts renders as a zero. */
function dateRange(since: string, until: string): string[] {
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

/** The legacy team that owns this site, or null (unclaimed / no credentials). */
export async function resolveTeamId(siteSlug: string): Promise<number | null> {
  const teams = await resolveTeamIds([siteSlug]);
  return teams.length === 1 ? teams[0]! : null;
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

async function loadPlanAndInvoices(
  siteSlugs: string[],
): Promise<LegacyTeamBilling | null> {
  const config = getDecoSupabaseConfig();
  const teams = await resolveTeamIds(siteSlugs);
  const teamId = teams.length === 1 ? teams[0]! : null;
  if (!config || teamId === null) {
    return null;
  }

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
    // Canceled invoices were never owed — the legacy admin hides them too.
    invoices: invoiceRows
      .filter((row) => row.status && row.status.toLowerCase() !== "canceled")
      .map((row) => ({
        id: String(row.id),
        status: row.status ?? "",
        dueDate: row.due_date,
        value: Number(row.value) || 0,
        referenceMonth: row.reference_month,
        nfUrl: row.nf_url,
        // Mirrored from Airtable as a JSON-ish string on some rows.
        bankSlipUrl:
          row.bank_slip_url?.replace(/^\["|"\]$|^"|"$|\[|\]/g, "") || null,
      })),
  };
}

export async function getSiteInfraBilling(params: {
  /** One or more sites the caller has already authorized; totals are summed. */
  siteSlugs: string[];
  /** Any date inside the wanted month; defaults to the current month. */
  period?: string;
}): Promise<SiteInfraBilling> {
  const siteSlugs = [...new Set(params.siteSlugs)].sort();
  const periodDate = params.period ? new Date(params.period) : new Date();
  const { since, until } = monthInterval(
    Number.isNaN(periodDate.getTime()) ? new Date() : periodDate,
  );

  const [usageResult, billing] = await Promise.all([
    (async () => {
      const hostnames = await siteHostnames(siteSlugs, since, until);
      const [infra, pageviews] = await Promise.all([
        dailyInfraUsage(siteSlugs, since, until, hostnames),
        dailyPageviews(hostnames.map(toOneDollarHostname), since, until),
      ]);
      return { infra, pageviews };
    })().catch((err) => {
      console.error("[deco-legacy] infra usage read failed:", err);
      return { infra: new Map(), pageviews: null };
    }),
    loadPlanAndInvoices(siteSlugs).catch((err) => {
      console.error("[deco-legacy] plan/invoices read failed:", err);
      return null;
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
    billing,
    // Not the same as a month with no traffic (a legit all-zeros dashboard).
    usageUnavailable: !isAnalyticsConfigured(),
  };
}
