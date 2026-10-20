/**
 * DBOS scheduled sweep that watches each store's order flow in the customer
 * lake: every 5 minutes, per ingest install, read the day (`loadStoreDay`),
 * run the rules (`order-rules.ts`), write each rule's verdict to
 * `order_monitor_state`, and act on the incident card (`incidentAction` in
 * `order-incidents.ts`) for the rules with `NOTIFY` on.
 *
 * Every change into, between or out of warning/alert is logged as
 * `[order-monitor] transition`, also for rules in shadow: that list is what a
 * rule's thresholds get checked against before it notifies.
 *
 * Same shape as `dbos-archive-sweep.ts`: the store list is read inside a step
 * so a replay iterates the recorded list, and each store and each card change
 * is its own step that never throws. Everything is computed from
 * `scheduledTime`, so a replayed tick asks the lake for the same window.
 *
 * Off unless ORDER_MONITOR_INGEST_URL and the customer lake are configured.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { OrderMonitorVerdict } from "@decocms/shared/order-monitor";
import { type Kysely, sql } from "kysely";
import { orgHasFeatureAsUser } from "@/core/plan-feature-gate";
import { isCustomerLakeConfigured } from "@/customer-lake/client";
import { getSettings } from "@/settings";
import {
  type MonitoredStore,
  OrderMonitorStorage,
} from "@/storage/order-monitor";
import type { Database } from "@/storage/types";
import { buildOrgContext } from "@/tools/task-board/org-context";
import { emitOrderMonitorEvaluated } from "./order-events";
import {
  type IncidentInput,
  incidentAction,
  syncIncidentTask,
} from "./order-incidents";
import { loadStoreDay } from "./order-lake";
import {
  evaluateStore,
  NOTIFY,
  RULES,
  type Rule,
  type Verdict,
} from "./order-rules";

// Off the every-5-minutes sweeps (Jira trigger, board transitions). Listed,
// not `3-59/5`: DBOS's parser keeps only the values divisible by the step.
const ORDER_MONITOR_CRONTAB = "3,8,13,18,23,28,33,38,43,48,53,58 * * * *";

/** Each store costs four lake queries; this many stores are read at once. */
const STORES_PER_BATCH = 20;

export interface OrderMonitorRuntime {
  db: Kysely<Database>;
}

let runtime: OrderMonitorRuntime | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`. */
export function setOrderMonitorRuntime(rt: OrderMonitorRuntime): void {
  runtime = rt;
}

function requireDb(): Kysely<Database> {
  if (!runtime) {
    throw new Error(
      "[order-monitor] runtime not initialized — setOrderMonitorRuntime() must run before the workflow fires",
    );
  }
  return runtime.db;
}

const storage = () => new OrderMonitorStorage(requireDb());

async function loadMonitoredStores(): Promise<MonitoredStore[]> {
  const ingestUrl = getSettings().orderMonitorIngestUrl;
  if (!ingestUrl || !isCustomerLakeConfigured()) return [];
  const installs = await storage().listIngestInstalls(ingestUrl);
  const allowed = await Promise.all(
    installs.map((s) =>
      orgHasFeatureAsUser(s.createdBy, s.organizationId, "monitoring"),
    ),
  );
  return installs.filter((_, i) => allowed[i]);
}

const isIncident = (status: string | undefined) =>
  status === "warning" || status === "alert";

interface StoreResult {
  connectionId: string;
  incidents: IncidentInput[];
  error?: string;
}

const storeLock = (trx: Kysely<Database>, connectionId: string) =>
  sql`select pg_advisory_xact_lock(hashtext(${`order-monitor:${connectionId}`})::bigint)`.execute(
    trx,
  );

/**
 * Writes one tick's verdicts and returns them with the ones they replaced.
 * Overlapping ticks (one ran past 5 min) take turns per store, and an older
 * tick that lost the race writes nothing over newer verdicts (null). A tick
 * re-run after its write committed (crash before DBOS recorded the step) gets
 * the same transitions back from `prev_status`.
 */
export async function writeStates(
  db: Kysely<Database>,
  { organizationId, connectionId }: MonitoredStore,
  at: Date,
  verdicts: Record<Rule, Verdict>,
  timezone: string,
) {
  return db.transaction().execute(async (trx) => {
    await storeLock(trx, connectionId);
    const storage = new OrderMonitorStorage(trx);
    const rows = await storage.listStates(organizationId, connectionId);
    if (rows.some((s) => s.evaluatedAt > at)) return null;
    const prev = new Map(
      rows.map((s) => {
        const rerun = s.evaluatedAt.getTime() === at.getTime();
        return [
          s.rule,
          {
            status: rerun ? (s.prevStatus ?? undefined) : s.status,
            // `since` belongs to the row's own status: on a re-run, this tick's.
            sinceStatus: s.status,
            since: s.since,
            verdict: s.verdict,
            task: s.task,
          },
        ];
      }),
    );
    const states = RULES.map((rule) => {
      const before = prev.get(rule);
      const incident = isIncident(verdicts[rule].status);
      const carried = (flag: "ingestIncident" | "crossCheckPending") =>
        incident && before?.verdict[flag] === true;
      const verdict: OrderMonitorVerdict = {
        ...verdicts[rule],
        timezone,
        // An incident judged ours stays ours until it ends; an open waiting
        // on VTEX keeps waiting, from when it started.
        ...(carried("ingestIncident") ? { ingestIncident: true } : {}),
        ...(carried("crossCheckPending")
          ? {
              crossCheckPending: true,
              ...(typeof before?.verdict.crossCheckSince === "string"
                ? { crossCheckSince: before.verdict.crossCheckSince }
                : {}),
            }
          : {}),
      };
      return {
        rule,
        status: verdict.status,
        since: before?.sinceStatus === verdict.status ? before.since : at,
        evaluatedAt: at,
        verdict: { ...verdict },
        prevStatus: before?.status ?? null,
      };
    });
    await storage.upsertStates(organizationId, connectionId, states);
    return { prev, states };
  });
}

/** One store, folded to a result — the step body must never throw. */
async function evaluateOneStore(
  store: MonitoredStore,
  at: Date,
): Promise<StoreResult> {
  const { organizationId, connectionId } = store;
  try {
    const day = await loadStoreDay(organizationId, connectionId, at);
    if (!day) {
      console.warn(
        `[order-monitor] connection ${connectionId} has no timezone in the lake; the ingest worker's zone map needs an entry`,
      );
      return { connectionId, incidents: [] };
    }
    const verdicts = evaluateStore(day);

    const written = await writeStates(
      requireDb(),
      store,
      at,
      verdicts,
      day.timezone,
    );
    if (!written) return { connectionId, incidents: [] };
    const { prev, states } = written;

    const incidents: IncidentInput[] = [];
    for (const s of states) {
      const before = prev.get(s.rule);
      const changed = before?.status !== s.status;
      if (changed && (isIncident(before?.status) || isIncident(s.status))) {
        console.log("[order-monitor] transition", {
          organizationId,
          connectionId,
          rule: s.rule,
          from: before?.status ?? null,
          to: s.status,
          at: at.toISOString(),
          observed: s.verdict.observed,
          expected: s.verdict.expected,
          notify: NOTIFY[s.rule],
        });
      }
      // Not only on a change: a card closes once ok has held long enough,
      // and an open waiting on VTEX is retried.
      const action = incidentAction(before?.status, s.status, {
        hasCard: !!before?.task,
        heldMs: at.getTime() - s.since.getTime(),
        retryOpen: s.verdict.crossCheckPending === true,
      });
      if (NOTIFY[s.rule] && action !== "none") {
        incidents.push({
          organizationId,
          connectionId,
          rule: s.rule,
          action,
          verdict: s.verdict as OrderMonitorVerdict,
          at,
          since: s.since,
        });
      }
    }
    if (states.some((s) => prev.get(s.rule)?.status !== s.status)) {
      emitOrderMonitorEvaluated(organizationId, connectionId);
    }
    return { connectionId, incidents };
  } catch (err) {
    return {
      connectionId,
      incidents: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** One card change, folded to a result — the step body must never throw. */
async function syncOneIncident(
  input: IncidentInput,
): Promise<{ error?: string }> {
  try {
    const db = requireDb();
    const ctx = await buildOrgContext(db, input.organizationId);
    if (!ctx) return {};
    // The store's lock, as `writeStates` takes it: overlapping ticks can't
    // both open a card, and a tick's write can't drop the flags set here.
    await db.transaction().execute(async (trx) => {
      await storeLock(trx, input.connectionId);
      // Dates come back as strings from a recorded step.
      await syncIncidentTask(ctx, db, new OrderMonitorStorage(trx), {
        ...input,
        at: new Date(input.at),
        since: new Date(input.since),
      });
    });
    emitOrderMonitorEvaluated(input.organizationId, input.connectionId);
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function orderMonitorWorkflowFn(
  scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  const stores = await DBOS.runStep(loadMonitoredStores, {
    name: "loadMonitoredStores",
  });
  if (stores.length === 0) return;

  const results: StoreResult[] = [];
  for (let i = 0; i < stores.length; i += STORES_PER_BATCH) {
    results.push(
      ...(await Promise.all(
        stores.slice(i, i + STORES_PER_BATCH).map((store) =>
          DBOS.runStep(() => evaluateOneStore(store, scheduledTime), {
            name: `evaluateStore:${store.connectionId}`,
          }),
        ),
      )),
    );
  }
  const synced = await Promise.all(
    results.flatMap((r) =>
      r.incidents.map((incident) =>
        DBOS.runStep(() => syncOneIncident(incident), {
          name: `syncIncidentTask:${incident.connectionId}:${incident.rule}`,
        }).then((s) => ({ ...s, connectionId: incident.connectionId })),
      ),
    ),
  );
  for (const result of [...results, ...synced]) {
    if (result.error) {
      console.warn(
        `[order-monitor] connection ${result.connectionId} failed: ${result.error}`,
      );
    }
  }
}

let registeredWorkflow: typeof orderMonitorWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerOrderMonitorWorkflow(): void {
  if (registeredWorkflow) return;
  registeredWorkflow = DBOS.registerWorkflow(orderMonitorWorkflowFn, {
    name: "orderMonitorWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "orderMonitorWorkflow",
    crontab: ORDER_MONITOR_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
