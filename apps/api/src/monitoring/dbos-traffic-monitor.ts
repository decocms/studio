/**
 * DBOS scheduled sweep over the orgs' site traffic: every 5 minutes, for each
 * org with a site and the `monitoring` plan feature, judge each of its
 * analytics sites' last complete hour (`traffic-rules.ts`) and open an alert
 * when a rule crosses into `alert` in that hour.
 *
 * Keeps no state of its own: the crossing is read from the hour before, and
 * `openOnce` keys the alert on the judged hour, so a replayed tick, the next
 * tick in the same hour, or an ack in between opens it once.
 *
 * Off unless the customer lake is configured.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import {
  SITE_TRAFFIC_ALERT_SOURCE,
  SITE_TRAFFIC_RULES,
} from "@decocms/shared/alerts";
import type { Kysely } from "kysely";
import { orgHasFeatureAsUser } from "@/core/plan-feature-gate";
import { isCustomerLakeConfigured } from "@/customer-lake/client";
import { AlertStorage } from "@/storage/alerts";
import type { Database } from "@/storage/types";
import { emitAlertsUpdated } from "@/tools/alerts/events";
import {
  loadTrafficThresholds,
  siteNames,
  trafficAlertBody,
  trafficAlertTitle,
} from "./traffic-alerts";
import {
  judgedHour,
  listTrafficSites,
  loadOrgTimezone,
  loadTrafficDays,
} from "./traffic-lake";
import { evaluateTraffic } from "./traffic-rules";

// Two minutes off the order monitor's ticks, so the two don't stack.
const TRAFFIC_MONITOR_CRONTAB = "1,6,11,16,21,26,31,36,41,46,51,56 * * * *";

/** Orgs whose sites are read at once. */
const ORGS_PER_BATCH = 10;

interface MonitoredOrg {
  organizationId: string;
  slug: string;
}

let runtime: { db: Kysely<Database> } | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`. */
export function setTrafficMonitorRuntime(rt: { db: Kysely<Database> }): void {
  runtime = rt;
}

function requireDb(): Kysely<Database> {
  if (!runtime) {
    throw new Error(
      "[traffic-monitor] runtime not initialized — setTrafficMonitorRuntime() must run before the workflow fires",
    );
  }
  return runtime.db;
}

/** Orgs with a site, each with an owner to read its plan as. */
async function loadMonitoredOrgs(): Promise<MonitoredOrg[]> {
  if (!isCustomerLakeConfigured()) return [];
  const rows = await requireDb()
    .selectFrom("org_sites as s")
    .innerJoin("organization as o", "o.id", "s.organization_id")
    .innerJoin("member as m", "m.organizationId", "o.id")
    .select(["o.id", "o.slug", "m.userId", "m.role"])
    .distinct()
    .orderBy("o.id")
    .execute();
  const owners = new Map<string, { slug: string; userId: string }>();
  for (const r of rows) {
    if (owners.has(r.id)) continue;
    if (r.role.split(",").some((x) => x === "owner" || x === "admin")) {
      owners.set(r.id, { slug: r.slug, userId: r.userId });
    }
  }
  const orgs = [...owners];
  const allowed = await Promise.all(
    orgs.map(([id, o]) =>
      orgHasFeatureAsUser(o.userId, id, "monitoring").catch(() => false),
    ),
  );
  return orgs
    .filter((_, i) => allowed[i])
    .map(([organizationId, o]) => ({ organizationId, slug: o.slug }));
}

/** One org's sites, folded to a result — the step body must never throw. */
async function evaluateOrg(
  { organizationId, slug }: MonitoredOrg,
  at: Date,
): Promise<{ organizationId: string; opened: number; error?: string }> {
  try {
    const sites = await listTrafficSites(organizationId, at);
    if (sites.length === 0) return { organizationId, opened: 0 };
    const db = requireDb();
    const alerts = new AlertStorage(db);
    const timezone = await loadOrgTimezone(organizationId);
    const { hour, hourStart } = judgedHour(at, timezone);
    const thresholds = await loadTrafficThresholds(alerts, organizationId);
    let names: Map<string, string> | null = null;
    let opened = 0;
    for (const site of sites) {
      const { today, refs } = await loadTrafficDays(
        organizationId,
        site,
        timezone,
        hourStart,
      );
      const now = evaluateTraffic(today, refs, hour, thresholds);
      const before =
        hour > 0 ? evaluateTraffic(today, refs, hour - 1, thresholds) : null;
      for (const rule of SITE_TRAFFIC_RULES) {
        if (now[rule].status !== "alert" || before?.[rule].status === "alert") {
          continue;
        }
        names ??= await siteNames(db, organizationId, sites);
        const alert = await alerts.openOnce({
          organizationId,
          source: SITE_TRAFFIC_ALERT_SOURCE,
          subjectId: site,
          rule,
          title: trafficAlertTitle(rule, names.get(site) ?? site, now[rule]),
          body: trafficAlertBody(rule, now[rule]),
          link: `/${encodeURIComponent(slug)}/monitoring`,
          createdAt: hourStart,
        });
        console.log("[traffic-monitor] alert", {
          organizationId,
          site,
          rule,
          hour: hourStart.toISOString(),
          observed: now[rule].observed,
          expected: now[rule].expected,
          opened: !!alert,
        });
        if (alert) {
          opened++;
          emitAlertsUpdated(organizationId, alert.id);
        }
      }
    }
    return { organizationId, opened };
  } catch (err) {
    return {
      organizationId,
      opened: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function trafficMonitorWorkflowFn(
  scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  const orgs = await DBOS.runStep(loadMonitoredOrgs, {
    name: "loadMonitoredOrgs",
  });
  for (let i = 0; i < orgs.length; i += ORGS_PER_BATCH) {
    const results = await Promise.all(
      orgs.slice(i, i + ORGS_PER_BATCH).map((org) =>
        DBOS.runStep(() => evaluateOrg(org, scheduledTime), {
          name: `evaluateOrgTraffic:${org.organizationId}`,
        }),
      ),
    );
    for (const r of results) {
      if (r.error) {
        console.warn(
          `[traffic-monitor] org ${r.organizationId} failed: ${r.error}`,
        );
      }
    }
  }
}

let registeredWorkflow: typeof trafficMonitorWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerTrafficMonitorWorkflow(): void {
  if (registeredWorkflow) return;
  registeredWorkflow = DBOS.registerWorkflow(trafficMonitorWorkflowFn, {
    name: "trafficMonitorWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "trafficMonitorWorkflow",
    crontab: TRAFFIC_MONITOR_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
