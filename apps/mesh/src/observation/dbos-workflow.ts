/**
 * Observational Agent sweep — a cluster-safe DBOS scheduled workflow.
 *
 * Every tick it: (1) lists orgs with an observational agent configured, (2) for
 * each, finds threads that have gone idle past the org's inactiveMinutes, and
 * (3) fires one observer run per idle thread, then records a watermark so a
 * thread is re-observed only after fresh activity.
 *
 * Observer runs go through a global-concurrency-capped queue
 * (`OBSERVATION_GLOBAL_QUEUE`) layered above the per-thread gate — mirroring how
 * automations cap fan-out — so a single tick can't launch hundreds of LLM runs
 * at once and exhaust the pg pool. Multi-pod safety is automatic:
 * `registerScheduled` with ExactlyOncePerIntervalWhenActive row-locks the tick.
 *
 * Reuses the automation machinery: the same `meshContextFactory` (background
 * MeshContext), `resolveTier` (model resolution without an HTTP request), and
 * `awaitThreadRun` (durable dispatch). Runtime deps are stashed via
 * `setObservationalRuntime` at app boot BEFORE `DBOS.launch()`.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import {
  awaitThreadRun,
  type SerializableDispatchRunInput,
} from "@/dispatch-queue";
import {
  resolveExplicitModel,
  type ResolvedTier,
  resolveTier,
  TierUnavailableError,
} from "@/core/resolve-tier";
import type { MeshContext } from "@/core/mesh-context";
import type {
  Database,
  ObservationalConfig,
  SimpleModeModelSlot,
  ThreadMessage,
} from "@/storage/types";
import type { ObservableThread, SqlThreadStorage } from "@/storage/threads";
import { isObservable } from "./is-observable";
import {
  buildObserverDispatchRequest,
  buildObserverSeed,
  toModelInfo,
} from "./build-observer-run";

/** How often the sweep runs. The deployment idle threshold decides eligibility. */
const OBSERVATION_SWEEP_CRONTAB = "*/15 * * * *";
/** Cap a single observer run so a runaway can't pin a thread-gate slot. */
const OBSERVATION_RUN_TIMEOUT_MS = 5 * 60 * 1000;
/** Max idle threads observed per org per tick (extra ones wait for next tick). */
const MAX_THREADS_PER_ORG = 50;
/** Per-tick ceiling on observer fires queued cluster-wide. */
const MAX_THREADS_PER_TICK = 200;

/**
 * Global cap on concurrently-executing observer runs across the cluster.
 * Mirrors AUTOMATIONS_GLOBAL_CONCURRENCY — protects the pg pool / model
 * provider from a burst when many threads go idle at once.
 */
export const OBSERVATION_GLOBAL_QUEUE = "observation-global";
export const OBSERVATION_GLOBAL_CONCURRENCY = 5;

type MeshContextFactory = (
  orgId: string,
  userId: string,
) => Promise<MeshContext | null>;

export interface ObservationalRuntime {
  db: Kysely<Database>;
  threadStorage: SqlThreadStorage;
  meshContextFactory: MeshContextFactory;
  /**
   * Minutes a thread must be idle before it is observed. Deployment-level
   * (OBSERVATION_INACTIVE_MINUTES) — it governs how much of the thread table the
   * sweep scans and how many runs it fires, so it's an infra knob, not per-org.
   */
  inactiveMinutes: number;
}

let runtime: ObservationalRuntime | null = null;

export function setObservationalRuntime(rt: ObservationalRuntime): void {
  runtime = rt;
}

function requireRuntime(): ObservationalRuntime {
  if (!runtime) {
    throw new Error(
      "[observation] runtime not initialized — setObservationalRuntime() must run before the sweep fires",
    );
  }
  return runtime;
}

interface ObservedOrg {
  organizationId: string;
  agentId: string;
  skipAgentIds: string[];
  /** Specific model to run the observer with; null → fall back to the fast tier. */
  model: SimpleModeModelSlot | null;
  /** Lower bound for observable activity — forward-only from when configured. */
  configuredAt: string;
  /** Owner of the observer agent — the identity the observer run executes as. */
  observerCreatedBy: string;
}

interface BuiltObserverRun {
  observerThreadId: string;
  request: SerializableDispatchRunInput;
}

// ---------------------------------------------------------------------------
// Plain logic (no DBOS) — shared by the scheduled sweep and the manual runner.
// ---------------------------------------------------------------------------

/**
 * Lists orgs with an active observational agent (optionally a single org). A
 * cross-org read with no per-org ctx, so it queries tables directly. Skips orgs
 * whose observer agent is missing or inactive to avoid futile per-thread fan-out.
 */
async function listObservedOrgs(
  organizationId?: string,
): Promise<ObservedOrg[]> {
  const rt = requireRuntime();
  let query = rt.db
    .selectFrom("organization_settings")
    .select(["organizationId", "observational_config"])
    .where("observational_config", "is not", null);
  if (organizationId) {
    query = query.where("organizationId", "=", organizationId);
  }
  const rows = await query.execute();

  const result: ObservedOrg[] = [];
  for (const row of rows) {
    const raw = row.observational_config;
    if (!raw) continue;
    let config: ObservationalConfig | null = null;
    try {
      config = (
        typeof raw === "string" ? JSON.parse(raw) : raw
      ) as ObservationalConfig;
    } catch {
      console.warn(
        `[observation] org ${row.organizationId}: unparseable observational_config — skipping`,
      );
      continue;
    }
    const agentId = config?.agentId ?? "";
    if (!agentId) continue; // empty agentId = feature disabled

    const agent = await rt.db
      .selectFrom("connections")
      .select(["created_by", "status"])
      .where("id", "=", agentId)
      .where("organization_id", "=", row.organizationId)
      .where("connection_type", "=", "VIRTUAL")
      .executeTakeFirst();
    if (!agent || agent.status !== "active") {
      console.warn(
        `[observation] org ${row.organizationId}: observer agent ${agentId} missing/inactive — skipping`,
      );
      continue;
    }

    result.push({
      organizationId: row.organizationId,
      agentId,
      skipAgentIds: config.skipAgentIds ?? [],
      model: config.model ?? null,
      // Defensive: an enabled config always has configuredAt (stamped on enable).
      // If somehow missing, default to "now" so we never backfill history.
      configuredAt: config.configuredAt ?? new Date().toISOString(),
      observerCreatedBy: agent.created_by,
    });
  }
  return result;
}

async function listObservableThreadsFor(
  org: ObservedOrg,
): Promise<ObservableThread[]> {
  const rt = requireRuntime();
  const inactiveBeforeIso = new Date(
    Date.now() - rt.inactiveMinutes * 60_000,
  ).toISOString();
  return rt.threadStorage.listObservableThreads({
    organizationId: org.organizationId,
    observerAgentId: org.agentId,
    skipAgentIds: org.skipAgentIds,
    inactiveBeforeIso,
    observeFromIso: org.configuredAt,
    limit: MAX_THREADS_PER_ORG,
  });
}

/**
 * Deterministic per (source thread, activity watermark). Combined with the
 * idempotent insert in createObservationRunThread, a DBOS step retry/replay
 * re-derives the same id and re-inserts as a no-op instead of orphaning a
 * duplicate observer thread.
 */
function observationThreadId(
  sourceThreadId: string,
  watermarkIso: string,
): string {
  const ms = Date.parse(watermarkIso);
  const stamp = Number.isFinite(ms) ? ms : 0;
  const base = sourceThreadId.replace(/^thrd_/, "");
  return `thrd_obs_${base}_${stamp}`;
}

function extractOpeningText(message: ThreadMessage | undefined): string | null {
  if (!message) return null;
  const parts = (message.parts ?? []) as Array<{
    type?: string;
    text?: string;
  }>;
  const text = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * Builds (but does NOT dispatch) an observer run for one idle thread: resolves
 * the model, assembles the neutral seed, and idempotently creates the observer
 * thread row. Returns null to skip without watermarking (config drift, lost
 * membership, or no model yet) so the thread is retried on a later tick.
 */
async function buildObserverRun(
  org: ObservedOrg,
  thread: ObservableThread,
): Promise<BuiltObserverRun | null> {
  const rt = requireRuntime();

  // Belt-and-suspenders mirror of the SQL identity guard (in case the two ever
  // drift). Uses the tick-start config; a mid-tick skip-list/agent change is
  // picked up on the next tick.
  if (
    !isObservable(thread, {
      observerAgentId: org.agentId,
      skipAgentIds: org.skipAgentIds,
    })
  ) {
    return null;
  }

  const meshCtx = await rt.meshContextFactory(
    org.organizationId,
    org.observerCreatedBy,
  );
  if (!meshCtx) {
    console.warn(
      `[observation] org ${org.organizationId}: observer owner ${org.observerCreatedBy} lost membership — skipping`,
    );
    return null;
  }

  // Re-fetch the observer agent at fire time (it may have been deleted or
  // deactivated since listObservedOrgs ran this tick). Bail WITHOUT watermarking
  // so the thread is retried next tick — mirrors automations' prepareFireStep,
  // and avoids creating an observer thread whose deferred dispatch would throw
  // "Agent not found" after the source was already watermarked.
  const observerAgent = await meshCtx.storage.virtualMcps.findById(
    org.agentId,
    org.organizationId,
  );
  if (!observerAgent || observerAgent.status !== "active") {
    console.warn(
      `[observation] org ${org.organizationId}: observer agent ${org.agentId} missing/inactive at fire time — skipping`,
    );
    return null;
  }

  // Resolve the observer's model: the explicitly-configured model if set (and
  // its credential still exists), else the org's fast tier. No model at all →
  // skip WITHOUT watermarking so it self-heals once a provider is connected.
  let resolved: ResolvedTier | null = null;
  if (org.model) {
    resolved = await resolveExplicitModel(
      meshCtx,
      org.model.keyId,
      org.model.modelId,
      org.model.title,
    );
  }
  if (!resolved) {
    try {
      resolved = await resolveTier(meshCtx, "fast");
    } catch (err) {
      if (err instanceof TierUnavailableError) {
        console.warn(
          `[observation] org ${org.organizationId}: no model available for observer — skipping (will retry)`,
        );
        return null;
      }
      throw err;
    }
  }
  const models = {
    credentialId: resolved.credentialId,
    thinking: toModelInfo(resolved),
  };

  // Searchable-context overview: observed agent summary + opening snippet.
  const observedAgent = await meshCtx.storage.virtualMcps.findById(
    thread.virtual_mcp_id,
    org.organizationId,
  );
  const { messages, total } = await rt.threadStorage.listMessages(
    thread.id,
    org.organizationId,
    { limit: 1, sort: "asc" },
  );

  const seedText = buildObserverSeed({
    observedAgent: {
      id: thread.virtual_mcp_id,
      title: observedAgent?.title ?? thread.virtual_mcp_id,
      description: observedAgent?.description ?? null,
      instructions: observedAgent?.metadata?.instructions ?? null,
    },
    sourceThread: { id: thread.id, title: thread.title },
    openingSnippet: extractOpeningText(messages[0]),
    messageCount: total,
  });

  const observerThreadId = observationThreadId(thread.id, thread.updated_at);
  await rt.threadStorage.createObservationRunThread({
    taskId: observerThreadId,
    organizationId: org.organizationId,
    observerAgentId: org.agentId,
    observerCreatedBy: org.observerCreatedBy,
    sourceThreadId: thread.id,
    sourceTitle: thread.title,
  });

  const request = buildObserverDispatchRequest({
    observerThreadId,
    observerAgentId: org.agentId,
    observerCreatedBy: org.observerCreatedBy,
    organizationId: org.organizationId,
    models,
    seedText,
  });

  return { observerThreadId, request };
}

// ---------------------------------------------------------------------------
// Global-capped fire wrapper. Holding a global-queue slot until awaitThreadRun
// returns caps concurrent observer runs at OBSERVATION_GLOBAL_CONCURRENCY.
// ---------------------------------------------------------------------------

interface ObservationFireContext {
  threadId: string;
  request: SerializableDispatchRunInput;
}

async function observationFireWorkflowFn(
  ctx: ObservationFireContext,
): Promise<void> {
  await awaitThreadRun({
    threadId: ctx.threadId,
    request: ctx.request,
    source: "observation",
    timeoutMs: OBSERVATION_RUN_TIMEOUT_MS,
  });
}

const observationFireWorkflow = DBOS.registerWorkflow(
  observationFireWorkflowFn,
  { name: "observationFireWorkflow" },
);

/**
 * Enqueue an observer run onto the global-capped queue. Fire-and-forget: the
 * sweep tick never blocks on a run. Idempotent via the observer-thread-scoped
 * workflow id (deterministic), so replay collapses onto the existing handle.
 */
async function fireObserver(built: BuiltObserverRun): Promise<void> {
  await DBOS.startWorkflow(observationFireWorkflow, {
    queueName: OBSERVATION_GLOBAL_QUEUE,
    workflowID: `observe-${built.observerThreadId}`,
  })({ threadId: built.observerThreadId, request: built.request });
}

async function markObserved(
  threadId: string,
  organizationId: string,
  observedAtIso: string,
): Promise<void> {
  // Watermark with the activity timestamp captured at SELECT time (not now())
  // so activity arriving mid-sweep re-qualifies the thread on the next tick.
  await requireRuntime().threadStorage.markObserved(
    threadId,
    organizationId,
    observedAtIso,
  );
}

// ---------------------------------------------------------------------------
// Scheduled sweep (all orgs) — each unit wrapped in DBOS.runStep for replay.
// ---------------------------------------------------------------------------

const observationSweepWorkflow = DBOS.registerWorkflow(
  observationSweepWorkflowFn,
  { name: "observationSweepWorkflow" },
);

async function observationSweepWorkflowFn(
  _scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  const orgs = await DBOS.runStep(() => listObservedOrgs(), {
    name: "listObservedOrgs",
  });

  let observedThisTick = 0;
  for (const org of orgs) {
    if (observedThisTick >= MAX_THREADS_PER_TICK) {
      console.warn(
        `[observation] per-tick cap ${MAX_THREADS_PER_TICK} reached — remaining orgs deferred to next tick`,
      );
      break;
    }

    let threads: ObservableThread[];
    try {
      threads = await DBOS.runStep(() => listObservableThreadsFor(org), {
        name: "listObservableThreads",
      });
    } catch (err) {
      console.error(
        `[observation] org ${org.organizationId}: listing idle threads failed:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    if (threads.length === MAX_THREADS_PER_ORG) {
      console.warn(
        `[observation] org ${org.organizationId}: hit per-org cap ${MAX_THREADS_PER_ORG}; extra idle threads deferred to next tick`,
      );
    }

    for (const thread of threads) {
      if (observedThisTick >= MAX_THREADS_PER_TICK) break;
      try {
        const built = await DBOS.runStep(() => buildObserverRun(org, thread), {
          name: "buildObserverRun",
        });
        if (!built) continue;
        // Enqueue from the workflow body — DBOS forbids DBOS.startWorkflow
        // from inside a step.
        await fireObserver(built);
        await DBOS.runStep(
          () => markObserved(thread.id, org.organizationId, thread.updated_at),
          { name: "markObserved" },
        );
        observedThisTick++;
      } catch (err) {
        console.error(
          `[observation] org ${org.organizationId} thread ${thread.id}: observe failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

/**
 * Manual, org-scoped sweep — used by the OBSERVATION_SWEEP_RUN tool and e2e to
 * trigger observation on demand instead of waiting for the 15-min cron. Plain
 * async (no DBOS.runStep journaling): a manual run doesn't need crash recovery,
 * and the per-fire wrapper is still durable + globally capped.
 */
export async function runObservationSweepForOrg(
  organizationId: string,
): Promise<{ observed: number; skipped: number }> {
  const orgs = await listObservedOrgs(organizationId);
  const org = orgs[0];
  if (!org) return { observed: 0, skipped: 0 };

  const threads = await listObservableThreadsFor(org);
  let observed = 0;
  let skipped = 0;
  for (const thread of threads) {
    try {
      const built = await buildObserverRun(org, thread);
      if (!built) {
        skipped++;
        continue;
      }
      await fireObserver(built);
      await markObserved(thread.id, org.organizationId, thread.updated_at);
      observed++;
    } catch (err) {
      console.error(
        `[observation] org ${org.organizationId} thread ${thread.id}: manual observe failed:`,
        err instanceof Error ? err.message : err,
      );
      skipped++;
    }
  }
  return { observed, skipped };
}

let scheduleRegistered = false;

// Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
export function registerObservationSweepWorkflow(): void {
  if (scheduleRegistered) return;
  scheduleRegistered = true;
  DBOS.registerScheduled(observationSweepWorkflow, {
    name: "observationSweepWorkflow",
    crontab: OBSERVATION_SWEEP_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
