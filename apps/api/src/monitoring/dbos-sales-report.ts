/**
 * DBOS scheduled sweep that emails the sales report: at the top of every
 * hour, for each org someone subscribed to, read its stores' day and mail the
 * report (`sales-report.ts`) to each subscriber whose hours include the
 * stores' local hour.
 *
 * The org list is read inside a step, each org's emails are built in one step
 * that never throws, and each email is its own step, so a replayed tick sends
 * only what it hadn't yet.
 *
 * Off unless ORDER_MONITOR_INGEST_URL and the customer lake are configured.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import { createEmailSender, findEmailProvider } from "@/auth/email-providers";
import { getConfig } from "@/core/config";
import { getBaseUrl } from "@/core/server-constants";
import { isValidEmail } from "@/notifications/dbos-digest";
import { OrderMonitorStorage } from "@/storage/order-monitor";
import type { Database } from "@/storage/types";
import { loadMonitoredStores } from "./dbos-order-monitor";
import { loadStoreDay, loadStoreTimezone, localMinutes } from "./order-lake";
import { buildDayView } from "./order-rules";
import { buildSalesReportEmail } from "./sales-report";

// Past the hour, off the order monitor's and the traffic monitor's ticks.
const SALES_REPORT_CRONTAB = "2 * * * *";

interface ReportOrg {
  organizationId: string;
  name: string;
  slug: string;
  connectionIds: string[];
}

interface ReportEmail {
  to: string;
  subject: string;
  html: string;
}

let runtime: { db: Kysely<Database> } | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`. */
export function setSalesReportRuntime(rt: { db: Kysely<Database> }): void {
  runtime = rt;
}

function requireDb(): Kysely<Database> {
  if (!runtime) {
    throw new Error(
      "[sales-report] runtime not initialized — setSalesReportRuntime() must run before the workflow fires",
    );
  }
  return runtime.db;
}

/** The orgs someone subscribed to, with their monitored stores. */
async function loadReportOrgs(): Promise<ReportOrg[]> {
  const db = requireDb();
  const subscribed = new Set(
    await new OrderMonitorStorage(db).listReportOrgs(),
  );
  if (subscribed.size === 0) return [];
  const stores = (await loadMonitoredStores()).filter((s) =>
    subscribed.has(s.organizationId),
  );
  if (stores.length === 0) return [];
  const names = new Map(
    (
      await db
        .selectFrom("organization")
        .select(["id", "name"])
        .where("id", "in", [...new Set(stores.map((s) => s.organizationId))])
        .execute()
    ).map((o) => [o.id, o.name]),
  );
  const orgs = new Map<string, ReportOrg>();
  for (const s of stores) {
    const org = orgs.get(s.organizationId) ?? {
      organizationId: s.organizationId,
      name: names.get(s.organizationId) ?? s.orgSlug,
      slug: s.orgSlug,
      connectionIds: [],
    };
    org.connectionIds.push(s.connectionId);
    orgs.set(s.organizationId, org);
  }
  return [...orgs.values()];
}

/** The org's emails due at `at`, folded to [] on failure — the step body must never throw. */
async function buildOrgEmails(
  org: ReportOrg,
  at: Date,
): Promise<ReportEmail[]> {
  try {
    // ponytail: the org's first store sets the local hour; stores in other zones ride along.
    const timezone = await loadStoreTimezone(
      org.organizationId,
      org.connectionIds[0]!,
    );
    if (!timezone) return [];
    const hour = Math.floor(localMinutes(at, timezone) / 60);
    const due = (
      await new OrderMonitorStorage(requireDb()).listReportSubscribers(
        org.organizationId,
      )
    ).filter((s) => s.hours.includes(hour) && isValidEmail(s.email));
    if (due.length === 0) return [];
    const days = await Promise.all(
      org.connectionIds.map((id) => loadStoreDay(org.organizationId, id, at)),
    );
    const views = days.flatMap((d) => (d ? [buildDayView(d, at)] : []));
    const link = `${getBaseUrl()}/${encodeURIComponent(org.slug)}/monitoring`;
    return due.flatMap((s) => {
      const email = buildSalesReportEmail(views, {
        orgName: org.name,
        link,
        hours: s.hours,
      });
      return email ? [{ to: s.email, ...email }] : [];
    });
  } catch (err) {
    console.warn(
      `[sales-report] org ${org.organizationId} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/** The invitation provider, as the notification digest uses; null = no email on this deployment. */
function resolveSender() {
  const auth = getConfig().auth;
  const providers = auth.emailProviders ?? [];
  const provider = auth.inviteEmailProviderId
    ? findEmailProvider(providers, auth.inviteEmailProviderId)
    : providers[0];
  return provider ? createEmailSender(provider) : null;
}

async function salesReportWorkflowFn(
  scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  if (!resolveSender()) return;
  const orgs = await DBOS.runStep(loadReportOrgs, { name: "loadReportOrgs" });
  for (const org of orgs) {
    const emails = await DBOS.runStep(
      () => buildOrgEmails(org, scheduledTime),
      { name: `buildSalesReports:${org.organizationId}` },
    );
    for (const [i, email] of emails.entries()) {
      try {
        await DBOS.runStep(
          async () => {
            const send = resolveSender();
            if (!send) throw new Error("no email provider configured");
            await send(email);
          },
          {
            name: `sendSalesReport:${org.organizationId}:${i}`,
            retriesAllowed: true,
            maxAttempts: 3,
          },
        );
      } catch (err) {
        console.warn(
          `[sales-report] org ${org.organizationId} email ${i} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

let registeredWorkflow: typeof salesReportWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerSalesReportWorkflow(): void {
  if (registeredWorkflow) return;
  registeredWorkflow = DBOS.registerWorkflow(salesReportWorkflowFn, {
    name: "salesReportWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "salesReportWorkflow",
    crontab: SALES_REPORT_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
