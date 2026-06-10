/**
 * DBOS workflow definitions for automation fires.
 *
 * Single cap — per-org tenant fairness:
 * - `automations-org-<orgId>` — one queue per organization, lazily created
 *   on first fire via `ensureOrgQueue`. Per-org `concurrency` is mutable at
 *   runtime through `WorkflowQueue.setConcurrency`, so users/admins can
 *   self-tune the cap from a settings UI without redeploying. The
 *   `dbos.queues` row is the source of truth for the limit — mesh keeps
 *   no copy.
 *
 * `fireAutomationWorkflow` runs *directly* on the per-org queue, so the
 * queue's concurrency IS the cap — no dedicated gate workflow holds a slot
 * just to enforce it. A queue caps whatever runs on it; one org saturating
 * its slots only blocks its own fires, never another org's.
 *
 * Two workflows:
 * - `fireAutomationWorkflow` — runs on the per-org queue, split into recorded
 *   steps (prepare → createRunThread → updateTriggerTiming → dispatchRunAndWait).
 * - `cronEntryWorkflow` — bound to `DBOS.createSchedule`. The Schedule API
 *   can't target a dynamic per-org queue name, so this fire-and-forget shim
 *   re-enqueues `fireAutomationWorkflow` on the org queue and returns without
 *   awaiting so the scheduler tick is never blocked.
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
import {
  awaitThreadRun,
  type SerializableDispatchRunInput,
} from "@/dispatch-queue";
import { resolveTier, tryResolveTier } from "@/core/resolve-tier";
import type { AutomationsStorage } from "@/storage/automations";
import type { Automation } from "@/storage/types";
import type { SimpleModeTier } from "@/tools/organization/schema";
import {
  buildStreamRequest,
  type ResolvedAutomationModel,
} from "./build-stream-request";
import { computeNextRunAt, type StudioContextFactory } from "./fire";

/**
 * Per-org queueing uses one DB-backed queue per organization, named
 * `automations-org-<orgId>`. The `dbos.queues` row IS the per-org config:
 * `concurrency` is mutable at runtime via the `WorkflowQueue` setters,
 * and `discoverAndLaunchDbQueues` makes every replica honor changes
 * within one poll cycle. Mesh stores no copy of these limits — DBOS owns
 * them end-to-end.
 *
 * Lazy-created on the first enqueue (`ensureOrgQueue`) with default
 * concurrency.
 */
const AUTOMATIONS_ORG_QUEUE_PREFIX = "automations-org-";
/** Concurrency a new org's queue starts at. Updatable per-org afterwards. */
const DEFAULT_ORG_CONCURRENCY = 10;
const AUTOMATIONS_RUN_TIMEOUT_MS = 5 * 60 * 1000;
export function orgQueueName(orgId: string): string {
  return `${AUTOMATIONS_ORG_QUEUE_PREFIX}${orgId}`;
}

/**
 * Idempotently create the org's queue with default concurrency. Safe to
 * call on every fire — `onConflict: "never_update"` means an existing
 * user-tuned `concurrency` value is never clobbered by this call.
 */
export async function ensureOrgQueue(orgId: string): Promise<void> {
  await DBOS.registerQueue(orgQueueName(orgId), {
    concurrency: DEFAULT_ORG_CONCURRENCY,
    onConflict: "never_update",
  });
}

export interface AutomationRuntime {
  storage: AutomationsStorage;
  meshContextFactory: StudioContextFactory;
  runTimeoutMs?: number;
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

  const meshCtx = await rt.meshContextFactory(
    automation.organization_id,
    automation.created_by,
  );
  if (!meshCtx) {
    console.warn(
      `[fireAutomationWorkflow] deactivating "${automation.name}" — creator ${automation.created_by} no longer in org ${automation.organization_id}`,
    );
    await rt.storage.deactivateAutomation(automation.id);
    return { skip: "creator_invalid" };
  }

  const parsedModels = JSON.parse(automation.models) as {
    tier?: SimpleModeTier;
  };
  if (!parsedModels.tier) {
    console.warn(
      `[fireAutomationWorkflow] automation ${automation.id} missing tier, defaulting to "smart"`,
    );
  }
  const tier: SimpleModeTier = parsedModels.tier ?? "smart";
  // Match the chat POST /messages path: resolve the chat tier strictly
  // (failure aborts the run), and optimistically resolve `image` and
  // `web_research` so the corresponding built-in tools (generate_image,
  // web_search) light up the same way they do in interactive chat. Without
  // these, the automation agent reports "I don't have a web_search tool"
  // even when the org has Perplexity/Gemini Deep Research configured.
  const [resolved, image, webResearch] = await Promise.all([
    resolveTier(meshCtx, tier),
    tryResolveTier(meshCtx, "image"),
    tryResolveTier(meshCtx, "web_research"),
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
    ...(webResearch
      ? {
          deepResearch: {
            ...toModel(webResearch),
            credentialId: webResearch.credentialId,
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
 * Runs as a step so the request payload — including `crypto.randomUUID()`
 * message ids — is recorded in the workflow journal and replay returns the
 * same payload. `awaitThreadRun` is invoked from the workflow body (not
 * here) because DBOS forbids workflow-to-workflow calls from inside a
 * step.
 *
 * The membership check is intentionally repeated by the thread-gate
 * workflow on dispatch; doing it here as well lets us early-exit before
 * the thread-gate queue takes a slot.
 */
async function buildDispatchRequestStep(
  automation: Automation,
  resolvedModel: ResolvedAutomationModel,
  ctx: FireAutomationContext,
  taskId: string,
): Promise<BuildDispatchRequestOutcome> {
  const rt = requireRuntime();

  const meshCtx = await rt.meshContextFactory(
    automation.organization_id,
    automation.created_by,
  );
  if (!meshCtx) {
    return { ok: false, reason: "creator membership lost mid-fire" };
  }

  const request = buildStreamRequest(
    automation,
    ctx.triggerId,
    taskId,
    resolvedModel,
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
        { id: crypto.randomUUID(), role: "user", parts: extraParts },
      ] as typeof request.messages;
    }
  }

  // Strip the (non-serializable, locally-built) abort signal — the
  // thread-gate workflow constructs its own from `timeoutMs`.
  const { abortSignal: _ignored, ...serializableRequest } = request;
  return { ok: true, request: serializableRequest };
}

async function markRunFailedStep(taskId: string): Promise<void> {
  const rt = requireRuntime();
  try {
    await rt.storage.markRunFailed(taskId);
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
  //   2. `awaitThreadRun` from the workflow body — calls
  //      `DBOS.startWorkflow(threadGateWorkflow, ...)`, which is illegal
  //      from inside a step. Errors are caught here to preserve the
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
    await DBOS.runStep(() => markRunFailedStep(taskId), {
      name: "markRunFailed",
    });
    return { taskId, error: built.reason };
  }

  const rt = requireRuntime();
  try {
    await awaitThreadRun({
      threadId: taskId,
      request: built.request,
      timeoutMs: rt.runTimeoutMs ?? AUTOMATIONS_RUN_TIMEOUT_MS,
      source: "automation",
    });
  } catch (err) {
    const runError = err instanceof Error ? err.message : String(err);
    console.error(
      `[fireAutomationWorkflow] ERROR "${prep.automation.name}" taskId=${taskId}:`,
      runError,
    );
    await DBOS.runStep(() => markRunFailedStep(taskId), {
      name: "markRunFailed",
    });
    return { taskId, error: runError };
  }

  return { taskId };
}

export const fireAutomationWorkflow = DBOS.registerWorkflow(
  fireAutomationWorkflowFn,
  { name: "fireAutomationWorkflow" },
);

/**
 * Scheduled-fire entry. Bound to DBOS schedules created per cron trigger.
 * Ensures the org queue exists, then re-enqueues `fireAutomationWorkflow` on
 * it. Returns without awaiting so the scheduler tick stays fast.
 */
async function cronEntryWorkflowFn(
  _scheduledTime: Date,
  ctx: FireAutomationContext,
): Promise<void> {
  await ensureOrgQueue(ctx.organizationId);
  await DBOS.startWorkflow(fireAutomationWorkflow, {
    queueName: orgQueueName(ctx.organizationId),
  })(ctx);
}

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

const automationsGcWorkflow = DBOS.registerWorkflow(automationsGcWorkflowFn, {
  name: "automationsGcWorkflow",
});

DBOS.registerScheduled(automationsGcWorkflow, {
  name: "automationsGcWorkflow",
  crontab: AUTOMATIONS_GC_CRONTAB,
  mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
});
