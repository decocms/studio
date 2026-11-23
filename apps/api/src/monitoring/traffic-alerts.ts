/**
 * What a site traffic alert says, the org's thresholds for the traffic rules,
 * and the names of the org's analytics sites for the alert's title.
 */

import {
  SITE_TRAFFIC_ALERT_SOURCE,
  SITE_TRAFFIC_DEFAULT_THRESHOLDS,
  SITE_TRAFFIC_RULES,
  type SiteTrafficRule,
  type SiteTrafficThresholds,
} from "@decocms/shared/alerts";
import type { Kysely } from "kysely";
import { readAnalyticsRegistration } from "@/analytics/registration";
import type { AlertStorage } from "@/storage/alerts";
import { OrgSiteStorage } from "@/storage/org-sites";
import type { Database } from "@/storage/types";
import type { TrafficVerdict } from "./traffic-rules";

const NOUN: Record<SiteTrafficRule, string> = {
  visitors_drop: "Visitors",
  pageviews_drop: "Pageviews",
};

const pad = (n: number) => String(n).padStart(2, "0");
const round = (n: number) => Math.round(n).toLocaleString("en-US");

export function trafficAlertTitle(
  rule: SiteTrafficRule,
  site: string,
  v: TrafficVerdict,
): string {
  const below =
    v.expected > 0 ? Math.round((1 - v.observed / v.expected) * 100) : 100;
  return `${NOUN[rule]} on ${site} are ${below} % below expected since ${pad(v.hour)}:00`;
}

export function trafficAlertBody(
  rule: SiteTrafficRule,
  v: TrafficVerdict,
): string {
  return `${NOUN[rule]}: ${round(v.observed)} between ${pad(v.hour)}:00 and ${pad((v.hour + 1) % 24)}:00 vs ${round(v.expected)} expected.`;
}

/** The org's thresholds for the traffic rules, the defaults for any it never set. */
export async function loadTrafficThresholds(
  alerts: AlertStorage,
  organizationId: string,
): Promise<SiteTrafficThresholds> {
  const own = new Map(
    (
      await alerts.listRuleSettings(organizationId, SITE_TRAFFIC_ALERT_SOURCE)
    ).map((s) => [s.rule, s]),
  );
  return Object.fromEntries(
    SITE_TRAFFIC_RULES.map((rule) => {
      const set = own.get(rule);
      return [
        rule,
        set
          ? { threshold: set.threshold, minVolume: set.minVolume }
          : SITE_TRAFFIC_DEFAULT_THRESHOLDS[rule],
      ];
    }),
  ) as SiteTrafficThresholds;
}

/** Analytics site id → the slug people know it by, for this process's lifetime of a registration. */
const slugOfId = new Map<string, { slug: string; at: number }>();
const NAME_TTL_MS = 60 * 60_000;

/**
 * The slug of each of the org's sites whose registration id is in `ids`,
 * looked up through the control plane and kept for an hour. An id with no
 * slug found keeps its own id as its name.
 */
export async function siteNames(
  db: Kysely<Database>,
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const fresh = (id: string) => {
    const hit = slugOfId.get(id);
    return hit && Date.now() - hit.at < NAME_TTL_MS ? hit.slug : null;
  };
  if (ids.some((id) => !fresh(id))) {
    const sites = await new OrgSiteStorage(db).listByOrg(organizationId);
    await Promise.all(
      sites.map(async (s) => {
        const reg = await readAnalyticsRegistration(s.slug);
        if (reg.status === "registered") {
          slugOfId.set(reg.id, { slug: s.slug, at: Date.now() });
        }
      }),
    );
  }
  return new Map(ids.map((id) => [id, fresh(id) ?? id]));
}
