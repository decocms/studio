/**
 * DBOS scheduled sweep that watches each store's order flow in the customer
 * lake: every 5 minutes, per ingest install, read the day (`loadStoreDay`),
 * run the rules (`order-rules.ts`), write each rule's verdict to
 * `order_monitor_state`, and open an alert when a rule crosses into `alert`.
 *
 * Every change into, between or out of warning/alert is logged as
 * `[order-monitor] transition`: that list is what a rule's thresholds get
 * checked against.
 *
 * Once the verdicts are written, every store the sweep read gets the model's
 * forecast for its local hour (`order-forecast.ts`): a child workflow per store and hour on
 * ORDER_FORECAST_QUEUE, which every tick of the hour asks for by the same id,
 * so the model runs once per store and hour and the sweep never waits on it.
 *
 * Same shape as `dbos-archive-sweep.ts`: the store list is read inside a step
 * so a replay iterates the recorded list, and each store is its own step that
 * never throws. Everything is computed from `scheduledTime`, so a replayed
 * tick asks the lake for the same window.
 *
 * Off unless ORDER_MONITOR_INGEST_URL and the customer lake are configured.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import { ORDER_MONITOR_ALERT_SOURCE } from "@decocms/shared/alerts";
import type { OrderMonitorVerdict } from "@decocms/shared/order-monitor";
import { type Kysely, sql } from "kysely";
import { orgHasFeatureAsUser } from "@/core/plan-feature-gate";
import { isCustomerLakeConfigured } from "@/customer-lake/client";
import { ORDER_FORECAST_QUEUE } from "@/dispatch-queue/queue-names";
import { getSettings } from "@/settings";
import { AlertStorage } from "@/storage/alerts";
import {
  type MonitoredStore,
  OrderMonitorStorage,
} from "@/storage/order-monitor";
import type { Database } from "@/storage/types";
import { emitAlertsUpdated } from "@/tools/alerts/events";
import {
  alertBody,
  alertLink,
  alertTitle,
  loadThresholds,
} from "./order-alerts";
import { emitOrderMonitorEvaluated } from "./order-events";
import {
  CALIBRATION_WINDOW_DAYS,
  closeAtTick,
  type ForecastJob,
  forecastJobs,
  forecastStore,
  forecastWorkflowId,
  localDateBefore,
  type SweptDay,
  type SweptStore,
  type TimestralService,
} from "./order-forecast";
import { type HourlyDay, loadHourlyHistory, loadStoreDay } from "./order-lake";
import {
  baselineClose,
  evaluateStore,
  RULES,
  type Rule,
  type Verdict,
} from "./order-rules";

// Off the every-5-minutes sweeps (Jira trigger, board transitions). Listed,
// not `3-59/5`: DBOS's parser keeps only the values divisible by the step.
const ORDER_MONITOR_CRONTAB = "3,8,13,18,23,28,33,38,43,48,53,58 * * * *";

const sum = (xs: readonly number[]) => xs.reduce((s, v) => s + v, 0);

/** Each store costs four lake queries; this many stores are read at once. */
const STORES_PER_BATCH = 20;

/**
 * Forecasts are kept this many local days, at least: calibration reads a
 * store's rows at the same hour up to CALIBRATION_WINDOW_DAYS back. The cutoff
 * is a day further back than this from the UTC date, so it holds in any
 * timezone.
 */
const FORECAST_RETENTION_DAYS = CALIBRATION_WINDOW_DAYS;

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
  error?: string;
  /** What the forecast needs of the day read; absent when it wasn't read. */
  day?: SweptStore["day"];
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
 * the same transitions back from `prev_status`, and the alert it opened
 * stays the one open alert.
 */
export async function writeStates(
  db: Kysely<Database>,
  { organizationId, connectionId, orgSlug, title }: MonitoredStore,
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
          },
        ];
      }),
    );
    const states = RULES.map((rule) => {
      const before = prev.get(rule);
      const verdict: OrderMonitorVerdict = { ...verdicts[rule], timezone };
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
    const alerts = new AlertStorage(trx);
    const opened: string[] = [];
    for (const s of states) {
      if (s.status !== "alert" || prev.get(s.rule)?.status === "alert") {
        continue;
      }
      const alert = await alerts.open({
        organizationId,
        source: ORDER_MONITOR_ALERT_SOURCE,
        subjectId: connectionId,
        rule: s.rule,
        title: alertTitle(s.rule, title, s.verdict),
        body: alertBody(s.rule, s.verdict),
        link: alertLink(orgSlug, connectionId, at, s.verdict),
        createdAt: at,
      });
      if (alert) opened.push(alert.id);
    }
    return { prev, states, opened };
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
      return { connectionId };
    }
    const verdicts = evaluateStore(
      day,
      await loadThresholds(new AlertStorage(requireDb()), organizationId),
    );
    const today = day.days[0];
    const inHour = Math.floor(day.done / 4) * 4;
    const read: SweptDay = {
      timezone: day.timezone,
      done: day.done,
      backfill: day.backfill?.days ?? [],
      soFar: {
        orders: sum(today.placed.slice(0, day.done)),
        revenue: sum(today.revenue.slice(0, day.done)),
      },
      inHour: {
        orders: sum(today.placed.slice(inHour, day.done)),
        revenue: sum(today.revenue.slice(inHour, day.done)),
      },
      baselineClose: baselineClose(day, verdicts),
    };

    const written = await writeStates(
      requireDb(),
      store,
      at,
      verdicts,
      day.timezone,
    );
    if (!written) return { connectionId, day: read };
    const { prev, states, opened } = written;

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
        });
      }
    }
    if (states.some((s) => prev.get(s.rule)?.status !== s.status)) {
      emitOrderMonitorEvaluated(organizationId, connectionId);
    }
    for (const id of opened) emitAlertsUpdated(organizationId, id);
    return { connectionId, day: read };
  } catch (err) {
    return {
      connectionId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Deletes the orgs' forecasts past their use and lists the ones due at `at`,
 * none without the forecasting service.
 * Never throws: it runs after the verdicts are written and the forecast is
 * best-effort.
 */
export async function planForecasts(
  db: Kysely<Database>,
  stores: SweptStore[],
  at: Date,
): Promise<ForecastJob[]> {
  try {
    const orgs = [...new Set(stores.map((s) => s.organizationId))];
    await new OrderMonitorStorage(db).deleteForecastsBefore(
      orgs,
      localDateBefore(
        at.toISOString().slice(0, 10),
        FORECAST_RETENTION_DAYS + 1,
      ),
    );
    if (!getSettings().timestralUrl) return [];
    return forecastJobs(stores, at);
  } catch (err) {
    console.warn("[order-monitor] forecast planning failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Runs the model for one job and records the run, answered or not, with the
 * past days it backfilled; then sets the close of the store's finished days
 * from the history it read. Never throws.
 */
export async function forecastOneStore(
  db: Kysely<Database>,
  service: TimestralService,
  job: ForecastJob,
  loadHistory: () => Promise<HourlyDay[]>,
): Promise<void> {
  const storage = new OrderMonitorStorage(db);
  const { organizationId, connectionId, hour } = job;
  const run = await forecastStore(service, job, loadHistory, (dates) =>
    storage.predictedRests(organizationId, connectionId, hour, dates),
  );
  const computedAt = new Date();
  const model = run.model;
  try {
    await storage.recordForecast(organizationId, connectionId, job.date, {
      hour,
      source: "live",
      status: run.status,
      error: run.error,
      latencyMs: run.latencyMs,
      seriesSent: run.seriesSent,
      backfilledDays: model?.backfill.length ?? 0,
      forecast: model && {
        orders: model.orders,
        revenue: model.revenue,
        rest: model.rest,
        ratios: model.ratios,
      },
      soFar: job.soFar,
      ...(model ? closeAtTick(job, model) : {}),
      baselineClose: job.baselineClose,
      computedAt,
    });
    await storage.insertMissingForecasts(
      organizationId,
      connectionId,
      (model?.backfill ?? []).map((b) => ({
        localDate: localDateBefore(job.date, b.daysAgo),
        record: {
          hour,
          source: "backfill",
          status: "ok",
          forecast: {
            orders: b.orders,
            revenue: b.revenue,
            rest: b.rest,
            ratios: [],
          },
          computedAt,
        },
      })),
    );
    if (run.days) {
      for (const date of await storage.datesWithoutActuals(
        organizationId,
        connectionId,
        job.date,
      )) {
        const day =
          run.days[(Date.parse(job.date) - Date.parse(date)) / 86_400_000];
        if (day)
          await storage.setActuals(organizationId, connectionId, date, day);
      }
    }
  } catch (err) {
    console.warn("[order-monitor] forecast write failed", {
      connectionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function orderForecastWorkflowFn(job: ForecastJob): Promise<void> {
  await DBOS.runStep(
    async () => {
      const { timestralUrl, timestralToken } = getSettings();
      if (!timestralUrl) return;
      await forecastOneStore(
        requireDb(),
        { url: timestralUrl, token: timestralToken },
        job,
        () =>
          loadHourlyHistory(
            job.organizationId,
            job.connectionId,
            new Date(job.at),
            job.timezone,
          ),
      );
    },
    { name: "forecastStore" },
  );
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
  for (const result of results) {
    if (result.error) {
      console.warn(
        `[order-monitor] connection ${result.connectionId} failed: ${result.error}`,
      );
    }
  }

  const read = new Map(results.map((r) => [r.connectionId, r.day]));
  const jobs = await DBOS.runStep(
    () =>
      planForecasts(
        requireDb(),
        stores.map((s) => ({
          organizationId: s.organizationId,
          connectionId: s.connectionId,
          day: read.get(s.connectionId),
        })),
        scheduledTime,
      ),
    { name: "planForecasts" },
  );
  if (!registeredForecastWorkflow) return;
  for (const job of jobs) {
    try {
      await DBOS.startWorkflow(registeredForecastWorkflow, {
        workflowID: forecastWorkflowId(job),
        queueName: ORDER_FORECAST_QUEUE,
      })(job);
    } catch (err) {
      console.warn("[order-monitor] forecast enqueue failed", {
        connectionId: job.connectionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

let registeredWorkflow: typeof orderMonitorWorkflowFn | null = null;
let registeredForecastWorkflow: typeof orderForecastWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerOrderMonitorWorkflow(): void {
  if (registeredWorkflow) return;
  registeredForecastWorkflow = DBOS.registerWorkflow(orderForecastWorkflowFn, {
    name: "orderForecastWorkflow",
  });
  registeredWorkflow = DBOS.registerWorkflow(orderMonitorWorkflowFn, {
    name: "orderMonitorWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "orderMonitorWorkflow",
    crontab: ORDER_MONITOR_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
