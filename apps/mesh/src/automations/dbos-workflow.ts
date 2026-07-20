/**
 * DBOS workflow definitions for automation fires.
 *
 * Single cap — per-org tenant fairness:
 * - One partitioned queue (`AUTOMATIONS_QUEUE`), partitioned by orgId. DBOS
 *   enforces `concurrency` per partition, so the per-org cap is preserved —
 *   one org saturating its slots only blocks its own partition, never
 *   another org's — without paying for one queue (and one dequeue loop) per
 *   org. See `AUTOMATIONS_QUEUE` below for the idle-polling rationale.
 *
 * `fireAutomationWorkflow` runs *directly* on the partitioned queue, so the
 * queue's per-partition concurrency IS the cap — no dedicated gate workflow
 * holds a slot just to enforce it.
 *
 * Two workflows:
 * - `fireAutomationWorkflow` — runs on the partitioned queue, split into
 *   recorded steps (prepare → createRunThread → updateTriggerTiming →
 *   dispatchRunAndWait).
 * - `cronEntryWorkflow` — bound to `DBOS.createSchedule`. The Schedule API
 *   can't target a partition key directly, so this fire-and-forget shim
 *   re-enqueues `fireAutomationWorkflow` on the org's partition and returns
 *   without awaiting so the scheduler tick is never blocked.
 *
 * Exactly-once semantics:
 * Cron is intrinsically exactly-once: `DBOS.createSchedule` assigns each tick
 * a deterministic workflow ID, and `workflow_schedules.last_fired_at` is
 * row-locked across replicas. The event path achieves the same property by
 * having callers pass an idempotency key (CloudEvents id + triggerId) to
 * `fireAutomationNow`, which uses it as the top-level workflow ID — a
 * redelivered event collapses onto the existing workflow handle.
 *
 * Runtime dependencies (storage, dispatch-run, context factory) are looked up
 * via a module-level registry. App boot wires them via `setAutomationRuntime`
 * BEFORE `DBOS.launch()`. The workflows are registered at import time so the
 * recovery executor can replay them after a crash.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Pool } from "pg";
import {
  runDispatchSteps,
  type SerializableDispatchRunInput,
} from "@/dispatch-queue";
import {
  resolveSpecificModel,
  resolveTier,
  tryResolveTier,
} from "@/core/resolve-tier";
import { isPermanentRunError } from "@/core/dispatch-errors";
import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
import type { AnyMessage } from "@/api/routes/decopilot/part-row-builder";
import type { AutomationsStorage } from "@/storage/automations";
import type { Automation } from "@/storage/types";
import type { SimpleModeTier } from "@/tools/organization/schema";
import {
  buildStreamRequest,
  contextMessageId,
  type ResolvedAutomationModel,
} from "./build-stream-request";
import { computeNextRunAt, type StudioContextFactory } from "./fire";

/**
 * Automation fires run on ONE partitioned queue, partitioned by orgId.
 *
 * DBOS enforces `concurrency` PER PARTITION (its dequeue counts running
 * workflows scoped to the partition key), so each org still gets its own
 * fairness cap — a saturated org blocks only its own partition, never
 * another's — exactly like the retired per-org-queue model. The win: one
 * queue means one dequeue-polling loop per replica instead of one loop per
 * org, and DBOS only polls partitions that currently have ENQUEUED work
 * (`getQueuePartitions`), so idle queue-poll cost is flat regardless of how
 * many orgs exist. The per-org model paid one dequeue/sec/org forever — even
 * for orgs that fired once and never again — which scaled linearly with org
 * count.
 *
 * Registered once at boot in `app.initDbos` (like the thread-gate queue),
 * not lazily per fire.
 */
export { AUTOMATIONS_QUEUE } from "../dispatch-queue/queue-names";
import { AUTOMATIONS_QUEUE } from "../dispatch-queue/queue-names";
/** Per-org (per-partition) concurrency cap. */
export const AUTOMATIONS_PARTITION_CONCURRENCY = 10;
/**
 * Poll interval for the automations dequeue loop. DBOS dispatches queued
 * workflows by polling the system DB (no notify path), and the loop only backs
 * off on DB contention — never when idle — so the default 1s means a steady
 * ~1 dequeue txn/sec/replica even with zero automations. Automation fires are
 * event/cron-triggered background work, not interactive, so trading up to ~5s
 * of dispatch latency for ~5× less idle DB polling is a good deal. The
 * thread-gate queue is left at the 1s default because it gates live agent runs.
 */
export const AUTOMATIONS_POLL_INTERVAL_MS = 5_000;
/** Prefix of the retired per-org queues — kept only for migration cleanup. */
const AUTOMATIONS_ORG_QUEUE_PREFIX = "automations-org-";

/**
 * MIGRATION (remove once no `automations-org-*` rows remain): delete the
 * retired per-org queue rows so DBOS stops launching a dequeue loop for each.
 * Only deletes queues with NO non-terminal (ENQUEUED/PENDING) workflows, so
 * fires enqueued before the cutover drain on their original queue first — a
 * later boot removes the now-empty row. Same Postgres as the app DB
 * (`systemDatabaseUrl` = app `databaseUrl`, schema `dbos`), so the app pool
 * can reach `dbos.queues`. Idempotent and best-effort.
 */
export async function cleanupOrphanedOrgQueues(pool: Pool): Promise<void> {
  try {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT q.name FROM dbos.queues q
        WHERE q.name LIKE $1
          AND NOT EXISTS (
            SELECT 1 FROM dbos.workflow_status w
             WHERE w.queue_name = q.name
               AND w.status IN ('ENQUEUED', 'PENDING')
          )`,
      [`${AUTOMATIONS_ORG_QUEUE_PREFIX}%`],
    );
    if (rows.length === 0) return;
    await Promise.allSettled(rows.map((r) => DBOS.deleteQueue(r.name)));
    console.log(
      `[automations] migration: removed ${rows.length} orphaned per-org queue(s)`,
    );
  } catch (err) {
    console.error("[automations] per-org queue cleanup failed:", err);
  }
}

export interface AutomationRuntime {
  storage: AutomationsStorage;
  studioContextFactory: StudioContextFactory;
}

let runtime: AutomationRuntime | null = null;

export function setAutomationRuntime(rt: AutomationRuntime): void {
  runtime = rt;
}

function requireRuntime(): AutomationRuntime {
  if (!runtime) {
    throw new Error(
      "[automations] DBOS runtime not initialized — setAutomationRuntime() must run before workflows fire",
    );
  }
  return runtime;
}

/**
 * A part of a trigger-context message handed to the agent. `text` parts are
 * what the model reads (`convertToModelMessages` keeps them); `data-trigger-event`
 * is a UI-only part the model never sees — it carries the structured event so
 * the chat can render a dedicated card instead of raw JSON.
 */
export type ContextMessagePart =
  | { type: "text"; text: string }
  | {
      type: "data-trigger-event";
      data: { source: string; type: string; data: unknown };
    };

export interface ContextMessage {
  role: "user" | "assistant" | "system";
  parts: ContextMessagePart[];
}

export interface FireAutomationContext {
  automationId: string;
  organizationId: string;
  triggerId: string | null;
  contextMessages?: ContextMessage[];
  /** Trusted per-run metadata (e.g. from a webhook trigger's `run_metadata`),
   *  forwarded to downstream MCP tool calls as `x-mesh-run-metadata`. Distinct
   *  from `contextMessages`, which is untrusted payload shown to the model. */
  runMetadata?: Record<string, string>;
}

export type FireAutomationOutcome =
  | { taskId: string }
  | { taskId: string; error: string }
  | { skipped: "not_found" | "inactive" | "creator_invalid" };

function toThinkingCapabilities(caps: string[] | undefined) {
  if (!caps || caps.length === 0) return undefined;
  return {
    vision: caps.includes("vision") || caps.includes("image") || undefined,
    text: caps.includes("text") || undefined,
    reasoning: caps.includes("reasoning") || undefined,
    file: caps.includes("file") || undefined,
  };
}

type PrepareOutcome =
  | { skip: "not_found" | "inactive" | "creator_invalid" }
  | {
      automation: Automation;
      resolvedModel: ResolvedAutomationModel;
    };

async function prepareFireStep(
  ctx: FireAutomationContext,
): Promise<PrepareOutcome> {
  const rt = requireRuntime();

  const automation = await rt.storage.findById(
    ctx.automationId,
    ctx.organizationId,
  );
  if (!automation) return { skip: "not_found" };
  if (!automation.active) return { skip: "inactive" };

  const studioCtx = await rt.studioContextFactory(
    automation.organization_id,
    automation.created_by,
  );
  if (!studioCtx) {
    console.warn(
      `[fireAutomationWorkflow] deactivating "${automation.name}" — creator ${automation.created_by} no longer in org ${automation.organization_id}`,
    );
    await rt.storage.deactivateAutomation(automation.id);
    return { skip: "creator_invalid" };
  }

  const parsedModels = JSON.parse(automation.models) as {
    tier?: SimpleModeTier;
    modelId?: string;
    credentialId?: string;
  };
  // Specific-model override: when the automation pins a concrete model +
  // credential, resolve it directly (no org tier/default-pick). Otherwise fall
  // back to the org tier preset.
  const pinned =
    parsedModels.modelId && parsedModels.credentialId
      ? {
          modelId: parsedModels.modelId,
          credentialId: parsedModels.credentialId,
        }
      : null;
  if (!pinned && !parsedModels.tier) {
    console.warn(
      `[fireAutomationWorkflow] automation ${automation.id} missing tier, defaulting to "smart"`,
    );
  }
  const tier: SimpleModeTier = parsedModels.tier ?? "smart";
  // Match the chat POST /messages path: resolve the chat model strictly
  // (failure aborts the run), and optimistically resolve `image` and
  // `web_research` so the corresponding built-in tools (generate_image,
  // web_search) light up the same way they do in interactive chat. Without
  // these, the automation agent reports "I don't have a web_search tool"
  // even when the org has Perplexity/Gemini Deep Research configured.
  const [resolved, image, webSearch, deepResearch] = await Promise.all([
    pinned
      ? resolveSpecificModel(studioCtx, pinned.credentialId, pinned.modelId)
      : resolveTier(studioCtx, tier),
    tryResolveTier(studioCtx, "image"),
    tryResolveTier(studioCtx, "web_search"),
    tryResolveTier(studioCtx, "deep_research"),
  ]);
  const toModel = (r: Awaited<ReturnType<typeof resolveTier>>) => ({
    id: r.modelId,
    title: r.modelMeta.title,
    provider: r.modelMeta.providerId ?? null,
    capabilities: toThinkingCapabilities(r.modelMeta.capabilities),
    limits: r.modelMeta.limits
      ? {
          contextWindow: r.modelMeta.limits.contextWindow,
          maxOutputTokens: r.modelMeta.limits.maxOutputTokens ?? undefined,
        }
      : undefined,
  });
  const resolvedModel: ResolvedAutomationModel = {
    credentialId: resolved.credentialId,
    thinking: toModel(resolved),
    ...(image
      ? { image: { ...toModel(image), credentialId: image.credentialId } }
      : {}),
    ...(webSearch
      ? {
          webSearch: {
            ...toModel(webSearch),
            credentialId: webSearch.credentialId,
          },
        }
      : {}),
    ...(deepResearch
      ? {
          deepResearch: {
            ...toModel(deepResearch),
            credentialId: deepResearch.credentialId,
          },
        }
      : {}),
  };

  return { automation, resolvedModel };
}

async function createRunThreadStep(
  automation: Automation,
  triggerId: string | null,
): Promise<string> {
  const rt = requireRuntime();
  return await rt.storage.createAutomationRunThread(automation, triggerId);
}

async function updateTriggerTimingStep(triggerId: string): Promise<void> {
  const rt = requireRuntime();
  try {
    const nowIso = new Date().toISOString();
    await rt.storage.updateTriggerLastRunAt(triggerId, nowIso);
    const trigger = await rt.storage.findTriggerById(triggerId);
    if (trigger?.cron_expression) {
      const next = computeNextRunAt(trigger.cron_expression, new Date());
      await rt.storage.updateNextRunAt(
        triggerId,
        next ? next.toISOString() : null,
      );
    }
  } catch (err) {
    console.warn(
      `[fireAutomationWorkflow] trigger ${triggerId} run-time write failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

type BuildDispatchRequestOutcome =
  | { ok: true; request: SerializableDispatchRunInput }
  | { ok: false; reason: string };

/**
 * Pre-flight for the dispatch: membership pre-check + `buildStreamRequest`.
 *
 * Runs as a step so the request payload — including the taskId-derived
 * message ids — is recorded in the workflow journal and replay returns the
 * same payload. `runDispatchSteps` is invoked from the workflow body (not
 * here) because its inner steps can't be nested inside another step.
 *
 * The membership check is intentionally repeated by the dispatch body; doing
 * it here as well lets us early-exit before running the dispatch.
 */
async function buildDispatchRequestStep(
  automation: Automation,
  resolvedModel: ResolvedAutomationModel,
  ctx: FireAutomationContext,
  taskId: string,
): Promise<BuildDispatchRequestOutcome> {
  const rt = requireRuntime();

  const studioCtx = await rt.studioContextFactory(
    automation.organization_id,
    automation.created_by,
  );
  if (!studioCtx) {
    return { ok: false, reason: "creator membership lost mid-fire" };
  }

  const request = buildStreamRequest(
    automation,
    ctx.triggerId,
    taskId,
    resolvedModel,
    ctx.runMetadata,
  );
  if (ctx.contextMessages && ctx.contextMessages.length > 0) {
    // The dispatch path (`dispatch-run.ts`) persists and forwards only the
    // FIRST non-system message plus all system messages — any extra non-system
    // message is dropped. So the event parts must ride ON the request message,
    // not be appended as a separate one (which would vanish). Prepended so the
    // event card/context precedes the automation's own instruction.
    const extraParts = ctx.contextMessages.flatMap((m) => m.parts);
    const target = request.messages.find((m) => m.role !== "system");
    if (target) {
      target.parts = [...extraParts, ...target.parts] as typeof target.parts;
    } else {
      request.messages = [
        ...request.messages,
        { id: contextMessageId(taskId), role: "user", parts: extraParts },
      ] as typeof request.messages;
    }
  }

  // Persist the trigger/user turn BEFORE dispatch so it lands with an early
  // created_at. The projector anchors the assistant reply at
  // max(existing created_at)+1; without a pre-persisted user turn it can run
  // before the hosted child's own user-message emit, read no user parts, and
  // stamp the reply at Date.now() — inverting their order in the UI (reply
  // first, then the trigger message trailed by "No response was generated").
  // Idempotent: the child's emit reuses this message id and ON CONFLICT keeps
  // these rows. Mirrors the task-board path (enqueue-super-agent.ts).
  const userTurn = request.messages.find((m) => m.role !== "system");
  if (userTurn) {
    await new PartEmitter({
      storage: studioCtx.storage.threads.messageParts(),
      orgId: automation.organization_id,
      threadId: taskId,
      runId: taskId,
    })
      .emitRequestMessage(userTurn as AnyMessage)
      .catch((err) =>
        console.error(
          "[fireAutomationWorkflow] request-message pre-persist failed",
          err,
        ),
      );
  }

  // Strip the (non-serializable, locally-built) abort signal — the
  // thread-gate workflow constructs its own from `timeoutMs`.
  const { abortSignal: _ignored, ...serializableRequest } = request;
  return { ok: true, request: serializableRequest };
}

async function markRunFailedStep(
  taskId: string,
  reason?: string,
  kind?: string,
): Promise<void> {
  const rt = requireRuntime();
  try {
    await rt.storage.markRunFailed(taskId, reason, kind);
  } catch {
    // best-effort
  }
}

async function deactivateAutomationStep(automationId: string): Promise<void> {
  const rt = requireRuntime();
  try {
    await rt.storage.deactivateAutomation(automationId);
  } catch {
    // best-effort
  }
}

// Split into steps so a crash-recovery replay doesn't duplicate the
// `threads` row inserted by `createRunThread`.
async function fireAutomationWorkflowFn(
  ctx: FireAutomationContext,
): Promise<FireAutomationOutcome> {
  const prep = await DBOS.runStep(() => prepareFireStep(ctx), {
    name: "prepareFire",
  });
  if ("skip" in prep) return { skipped: prep.skip };

  const taskId = await DBOS.runStep(
    () => createRunThreadStep(prep.automation, ctx.triggerId),
    { name: "createRunThread" },
  );

  if (ctx.triggerId) {
    const triggerId = ctx.triggerId;
    await DBOS.runStep(() => updateTriggerTimingStep(triggerId), {
      name: "updateTriggerTiming",
    });
  }

  // Two-phase dispatch:
  //   1. `buildDispatchRequest` step — membership pre-check + assemble the
  //      serializable request. Recorded in the journal so replays reuse the
  //      same message ids.
  //   2. `runDispatchSteps` from the workflow body — runs the dispatch (and
  //      its analytics steps) directly. We already hold this org's queue slot,
  //      and each fire is a fresh thread, so there's no per-thread gate to
  //      cross — no second queue hop. Errors are caught here to preserve the
  //      `FireAutomationOutcome` API (callers expect a resolved
  //      `{taskId, error}` outcome, not a thrown promise).
  const built = await DBOS.runStep(
    () =>
      buildDispatchRequestStep(
        prep.automation,
        prep.resolvedModel,
        ctx,
        taskId,
      ),
    { name: "buildDispatchRequest" },
  );
  if (!built.ok) {
    await DBOS.runStep(() => markRunFailedStep(taskId, built.reason, "setup"), {
      name: "markRunFailed",
    });
    return { taskId, error: built.reason };
  }

  try {
    await runDispatchSteps({
      threadId: taskId,
      request: built.request,
      source: "automation",
    });
  } catch (err) {
    const runError = err instanceof Error ? err.message : String(err);
    if (isPermanentRunError(err)) {
      console.warn(
        `[fireAutomationWorkflow] deactivating "${prep.automation.name}" (${prep.automation.id}) — permanent dispatch error, will not fire again: ${runError}`,
      );
      await DBOS.runStep(() => deactivateAutomationStep(prep.automation.id), {
        name: "deactivateAutomation",
      });
      await DBOS.runStep(
        () => markRunFailedStep(taskId, runError, "permanent"),
        { name: "markRunFailed" },
      );
      return { taskId, error: runError };
    }
    console.error(
      `[fireAutomationWorkflow] ERROR "${prep.automation.name}" taskId=${taskId}:`,
      runError,
    );
    await DBOS.runStep(() => markRunFailedStep(taskId, runError, "error"), {
      name: "markRunFailed",
    });
    return { taskId, error: runError };
  }

  return { taskId };
}

// ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
// step, or change a step's recorded I/O) requires bumping DBOS_WORKFLOW_VERSION
// — see apps/mesh/src/dbos/workflow-version.ts.
export const fireAutomationWorkflow = DBOS.registerWorkflow(
  fireAutomationWorkflowFn,
  { name: "fireAutomationWorkflow" },
);

/**
 * Scheduled-fire entry. Bound to DBOS schedules created per cron trigger.
 * Re-enqueues `fireAutomationWorkflow` on the org's partition of the shared
 * automations queue. Returns without awaiting so the scheduler tick stays fast.
 */
async function cronEntryWorkflowFn(
  _scheduledTime: Date,
  ctx: FireAutomationContext,
): Promise<void> {
  await DBOS.startWorkflow(fireAutomationWorkflow, {
    queueName: AUTOMATIONS_QUEUE,
    enqueueOptions: { queuePartitionKey: ctx.organizationId },
  })(ctx);
}

// ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
// step, or change a step's recorded I/O) requires bumping DBOS_WORKFLOW_VERSION
// — see apps/mesh/src/dbos/workflow-version.ts.
export const cronEntryWorkflow = DBOS.registerWorkflow(cronEntryWorkflowFn, {
  name: "cronEntryWorkflow",
});

/**
 * DBOS system-DB pruning. Without this, `workflow_status` /
 * `operation_outputs` / cascaded satellite tables grow monotonically — at
 * 1k fires/hour with no retention you cross 1 GB in days, and
 * recovery/autovacuum scans degrade for all replicas.
 *
 * The scheduled workflow calls `DBOS.listWorkflows` for terminal-state
 * workflows older than the cutoff and feeds them to `DBOS.deleteWorkflows`
 * in batches. Satellite tables (`operation_outputs`, `workflow_inputs`,
 * `workflow_queue`, `notifications`, `workflow_events*`, `streams`) all
 * have `ON DELETE CASCADE` FKs to `workflow_status`, so a single delete
 * sweeps the lot.
 *
 * Registered as a static schedule via `DBOS.registerScheduled` at module
 * load — multi-replica coordination uses `upsertEventDispatchState` so only
 * one replica fires per tick. The step itself is idempotent on replay:
 * another run just computes a fresh cutoff and deletes the next batch.
 */
const AUTOMATIONS_GC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const AUTOMATIONS_GC_BATCH_SIZE = 500;
/** 03:17 UTC daily — off-peak with a minute offset to avoid colliding with hourly tasks. */
const AUTOMATIONS_GC_CRONTAB = "17 3 * * *";

const GC_TERMINAL_STATUSES = ["SUCCESS", "ERROR", "CANCELLED"] as const;

export interface AutomationsGcResult {
  deleted: number;
  batches: number;
  cutoffMs: number;
}

async function automationsGcStep(): Promise<AutomationsGcResult> {
  const cutoffMs = Date.now() - AUTOMATIONS_GC_RETENTION_MS;
  const endTime = new Date(cutoffMs).toISOString();
  let deleted = 0;
  let batches = 0;

  // Loop until a short batch indicates we've drained the eligible set.
  // Bounded by `batches < 200` so a single GC tick can't run forever on a
  // backlog; the next tick picks up where this left off.
  while (batches < 200) {
    const rows = await DBOS.listWorkflows({
      status: [...GC_TERMINAL_STATUSES],
      endTime,
      limit: AUTOMATIONS_GC_BATCH_SIZE,
      loadInput: false,
      loadOutput: false,
    });
    if (rows.length === 0) break;
    await DBOS.deleteWorkflows(rows.map((r) => r.workflowID));
    deleted += rows.length;
    batches++;
    if (rows.length < AUTOMATIONS_GC_BATCH_SIZE) break;
  }

  console.log(
    `[automations-gc] deleted ${deleted} workflow(s) in ${batches} batch(es) (cutoff=${endTime})`,
  );
  return { deleted, batches, cutoffMs };
}

async function automationsGcWorkflowFn(
  _scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  await DBOS.runStep(() => automationsGcStep(), {
    name: "automationsGarbageCollect",
  });
}

// ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
// step, or change a step's recorded I/O) requires bumping DBOS_WORKFLOW_VERSION
// — see apps/mesh/src/dbos/workflow-version.ts.
const automationsGcWorkflow = DBOS.registerWorkflow(automationsGcWorkflowFn, {
  name: "automationsGcWorkflow",
});

DBOS.registerScheduled(automationsGcWorkflow, {
  name: "automationsGcWorkflow",
  crontab: AUTOMATIONS_GC_CRONTAB,
  mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
});
