/**
 * DBOS workflow definitions for automation fires.
 *
 * Three-level queueing (tenant isolation → per-automation isolation → global
 * resource cap):
 * - `automations-org-<orgId>` — one queue per organization, lazily created
 *   on first fire via `ensureOrgQueue`. Per-org `concurrency` is mutable at
 *   runtime through `WorkflowQueue.setConcurrency`, so users/admins can
 *   self-tune the cap from a settings UI without redeploying. The
 *   `dbos.queues` row is the source of truth for the limit — mesh keeps
 *   no copy.
 * - `AUTOMATIONS_GATE_QUEUE` — partitioned by automationId,
 *   concurrency=`AUTOMATIONS_GATE_PARTITION_CONCURRENCY`. Caps per-automation
 *   concurrent fires.
 * - `AUTOMATIONS_GLOBAL_QUEUE` — flat queue,
 *   concurrency=`AUTOMATIONS_GLOBAL_CONCURRENCY`. Caps total in-flight fires
 *   across the whole cluster (protects the pg pool from exhaustion under
 *   burst load).
 *
 * Four workflows:
 * - `fireAutomationWorkflow` — runs on the global queue, split into recorded
 *   steps (prepare → createRunThread → updateTriggerTiming → dispatchRunAndWait).
 * - `gateWorkflow` — enqueued on the per-automation gate queue with
 *   partitionKey=automationId, awaits a fire on the global queue. Holding
 *   the partition slot until the child returns is what enforces the
 *   per-automation cap.
 * - `orgGateWorkflow` — top-level entry for both cron and event paths.
 *   Enqueued on the org gate queue with partitionKey=organizationId, awaits
 *   the per-automation gate. Holding the org slot until the chain returns is
 *   what enforces the per-org cap.
 * - `cronEntryWorkflow` — bound to `DBOS.createSchedule`. The Schedule API
 *   can't carry a partition key, so this wrapper re-enqueues `orgGateWorkflow`
 *   on the org gate with the partition key. Returns without awaiting so the
 *   scheduler tick is never blocked.
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
import { createDecopilotThreadStatusEvent } from "@decocms/mesh-sdk";
import {
  awaitThreadRun,
  type SerializableDispatchRunInput,
} from "@/dispatch-queue";
import { resolveTier } from "@/core/resolve-tier";
import { sseHub } from "@/event-bus";
import type { AutomationsStorage } from "@/storage/automations";
import type { Automation } from "@/storage/types";
import type { SimpleModeTier } from "@/tools/organization/schema";
import {
  buildStreamRequest,
  type ResolvedAutomationModel,
} from "./build-stream-request";
import { computeNextRunAt, type MeshContextFactory } from "./fire";

export const AUTOMATIONS_GATE_QUEUE = "automations-gate";
export const AUTOMATIONS_GLOBAL_QUEUE = "automations-global";

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
const DEFAULT_ORG_CONCURRENCY = 3;
/** Per-automation concurrent fire cap (partition cap on the gate queue). */
export const AUTOMATIONS_GATE_PARTITION_CONCURRENCY = 3;
/**
 * Global concurrent fire cap across the entire cluster. Set conservatively to
 * keep the pg pool from being exhausted by tool fan-out inside each fire's
 * dispatchRunAndWait call. Bump when `databasePoolMax` is bumped.
 */
export const AUTOMATIONS_GLOBAL_CONCURRENCY = 5;
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
  meshContextFactory: MeshContextFactory;
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

export interface FireAutomationContext {
  automationId: string;
  organizationId: string;
  triggerId: string | null;
  contextMessages?: Array<{ role: string; content: string }>;
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
      // kind='tool_call' — no model resolution needed.
      automation: Automation;
      resolvedModel: null;
    }
  | {
      // kind='agent' — full tier resolution.
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

  // Tool-call automations skip tier resolution and model lookup entirely —
  // they invoke a fixed MCP tool with fixed args, no LLM involved.
  if (automation.kind === "tool_call") {
    return { automation, resolvedModel: null };
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
  const resolved = await resolveTier(meshCtx, tier);
  const resolvedModel: ResolvedAutomationModel = {
    credentialId: resolved.credentialId,
    thinking: {
      id: resolved.modelId,
      title: resolved.modelMeta.title,
      provider: resolved.modelMeta.providerId ?? null,
      capabilities: toThinkingCapabilities(resolved.modelMeta.capabilities),
      limits: resolved.modelMeta.limits
        ? {
            contextWindow: resolved.modelMeta.limits.contextWindow,
            maxOutputTokens:
              resolved.modelMeta.limits.maxOutputTokens ?? undefined,
          }
        : undefined,
    },
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
  if (ctx.contextMessages) {
    request.messages = [
      ...request.messages,
      ...ctx.contextMessages.map((m) => ({
        id: crypto.randomUUID(),
        role: m.role as "user" | "assistant" | "system",
        parts: [{ type: "text" as const, text: m.content }],
      })),
    ];
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

  // Tool-call automations skip the agent dispatch entirely: spawn a
  // synthetic thread, invoke the configured MCP tool, persist the
  // input/output as a single assistant message, done. No model, no LLM,
  // no streaming. TODO(retry-policy): step-level retries are intentionally
  // not configured — cron re-fires on next tick and the event bus retries
  // its own deliveries, which covers the common transient cases without
  // a tool_call holding a queue slot through long backoffs.
  // TODO(continue-with-agent): expose a UI action to convert a completed
  // tool_call_run thread into a regular agent thread so the user can chat
  // about the result.
  if (prep.automation.kind === "tool_call") {
    return await runToolCallFire(prep.automation, ctx.triggerId);
  }

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
        // The agent branch in prepareFireStep always returns a non-null
        // resolvedModel; the tool_call branch above exits before reaching
        // here. The `!` documents that invariant for the type checker.
        prep.resolvedModel!,
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

// ============================================================================
// Tool-call branch (kind='tool_call')
// ============================================================================

type ToolCallInvocation =
  | { ok: true; output: unknown }
  | { ok: false; error: string };

async function createToolCallRunThreadStep(
  automation: Automation,
  triggerId: string | null,
): Promise<string> {
  const rt = requireRuntime();
  return await rt.storage.createToolCallRunThread(automation, triggerId);
}

async function invokeFixedToolStep(
  automation: Automation,
): Promise<ToolCallInvocation> {
  if (!automation.connection_id || !automation.tool_name) {
    return {
      ok: false,
      error: "tool_call automation missing connection_id or tool_name",
    };
  }

  const rt = requireRuntime();
  const meshCtx = await rt.meshContextFactory(
    automation.organization_id,
    automation.created_by,
  );
  if (!meshCtx) {
    return { ok: false, error: "creator membership lost mid-fire" };
  }

  const connection = await meshCtx.storage.connections.findById(
    automation.connection_id,
  );
  if (!connection) {
    return {
      ok: false,
      error: `connection ${automation.connection_id} not found`,
    };
  }

  const args = automation.tool_input ? JSON.parse(automation.tool_input) : {};
  const { createLazyClient } = await import("@/mcp-clients/lazy-client");
  const client = createLazyClient(connection, meshCtx, false);
  try {
    const result = (await client.callTool({
      name: automation.tool_name,
      arguments: args,
    })) as {
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
    };
    // MCP convention: tools signal application-level failures by
    // returning { isError: true, content: [...] } rather than throwing.
    // Treat these the same as a thrown error — mark the run failed and
    // show the message — otherwise the thread is left in 'completed'
    // with a misleading "output-available" card.
    if (result.isError) {
      const message =
        result.content
          ?.map((c) => (c.type === "text" ? c.text : undefined))
          .filter((t): t is string => typeof t === "string")
          .join("\n")
          .trim() || "Tool returned an error";
      return { ok: false, error: message };
    }
    return { ok: true, output: result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function persistToolCallResultStep(
  automation: Automation,
  taskId: string,
  result: ToolCallInvocation,
): Promise<void> {
  const rt = requireRuntime();
  const meshCtx = await rt.meshContextFactory(
    automation.organization_id,
    automation.created_by,
  );
  // If membership was lost between invocation and persistence we still
  // need to close out the thread, but we can't write the message. Fall
  // back to marking the run failed.
  if (!meshCtx) {
    await rt.storage.markRunFailed(taskId);
    return;
  }

  const input = automation.tool_input ? JSON.parse(automation.tool_input) : {};
  // Stamp the user message 1ms before the assistant so the chat's
  // mergeAndSort (sort by created_at, tiebreak by id) reliably puts the
  // user message first. Without this, identical timestamps fall back to
  // id-ascending and `tool-call` < `trigger` flips the pair order,
  // which makes useMessagePairs drop the assistant as an orphan and
  // the UI shows "No response was generated".
  const userTime = new Date(Date.now() - 1).toISOString();
  const assistantTime = new Date().toISOString();
  // The thread UI pairs user/assistant messages; an orphan assistant
  // message is dropped (apps/mesh/src/web/components/chat/message/pair.tsx
  // useMessagePairs). Write a synthetic user message labelling the
  // trigger so the assistant message renders. IDs are also numbered to
  // make the lex order match the chronological order — belt-and-braces
  // because mergeAndSort uses id as the tiebreaker. Both ids are
  // deterministic so step replay overwrites in place rather than
  // duplicating rows.
  await meshCtx.storage.threads.saveMessages([
    {
      id: `${taskId}-msg-1-trigger`,
      thread_id: taskId,
      role: "user",
      parts: [
        {
          type: "text",
          text: `Tool call: ${automation.tool_name ?? "—"}`,
        },
      ],
      metadata: undefined,
      created_at: userTime,
      updated_at: userTime,
    },
    {
      id: `${taskId}-msg-2-tool-call`,
      thread_id: taskId,
      role: "assistant",
      // AI-SDK-native dynamic-tool part. Using this shape (vs the
      // custom data-tool-call-* parts we had originally) means two
      // things come for free: the existing GenericToolCallPart
      // renderer draws the input/output card, AND when the user
      // sends a follow-up message in the thread the AI SDK
      // serializes this into a proper tool_call + tool_result pair
      // for the LLM — so the agent actually sees the tool was
      // executed, not just a text reference to its name.
      parts: [
        result.ok
          ? {
              type: "dynamic-tool",
              toolCallId: `${taskId}-tool-call`,
              toolName: automation.tool_name ?? "",
              state: "output-available",
              input,
              output: result.output,
            }
          : {
              type: "dynamic-tool",
              toolCallId: `${taskId}-tool-call`,
              toolName: automation.tool_name ?? "",
              state: "output-error",
              input,
              errorText: result.error,
            },
      ],
      // Thread-level metadata.kind='tool_call_run' is the canonical
      // discriminator; the message itself doesn't carry it.
      metadata: undefined,
      created_at: assistantTime,
      updated_at: assistantTime,
    },
  ]);

  if (result.ok) {
    await rt.storage.markRunCompleted(taskId);
  } else {
    await rt.storage.markRunFailed(taskId);
  }

  // Push a thread-status event so the tasks panel materialises this run
  // without waiting for a refresh. The handler in ThreadManagerStore
  // upserts the row on first sighting, so this single event both creates
  // the panel row and marks its final status. We don't bother with an
  // earlier in_progress event because the tool-call leaf is synchronous
  // (millisecond-scale) — emitting two events would race the UI.
  sseHub.emit(
    automation.organization_id,
    createDecopilotThreadStatusEvent(
      taskId,
      result.ok ? "completed" : "failed",
      {
        virtualMcpId: undefined,
        createdBy: automation.created_by,
        triggerId: null,
        title: `Automation: ${automation.name}`,
        branch: null,
        createdAt: assistantTime,
        updatedAt: assistantTime,
        // Without this the panel row appears with a generic agent
        // avatar until a refetch — task-row branches on
        // task.metadata?.kind === 'tool_call_run' to pick the tool
        // icon. The thread row itself was created with this same
        // metadata in createToolCallRunThread.
        metadata: { kind: "tool_call_run" },
      },
    ),
  );
}

async function runToolCallFire(
  automation: Automation,
  triggerId: string | null,
): Promise<FireAutomationOutcome> {
  const taskId = await DBOS.runStep(
    () => createToolCallRunThreadStep(automation, triggerId),
    { name: "createToolCallRunThread" },
  );

  if (triggerId) {
    const tid = triggerId;
    await DBOS.runStep(() => updateTriggerTimingStep(tid), {
      name: "updateTriggerTiming",
    });
  }

  const invocation = await DBOS.runStep(() => invokeFixedToolStep(automation), {
    name: "invokeFixedTool",
  });

  await DBOS.runStep(
    () => persistToolCallResultStep(automation, taskId, invocation),
    { name: "persistToolCallResult" },
  );

  if (!invocation.ok) return { taskId, error: invocation.error };
  return { taskId };
}

const fireAutomationWorkflow = DBOS.registerWorkflow(fireAutomationWorkflowFn, {
  name: "fireAutomationWorkflow",
});

/**
 * Per-automation gate. Runs on the partitioned gate queue; holds its
 * partition slot until the inner fire on the global queue returns. That hold
 * is what enforces per-automation concurrency.
 *
 * Replays are safe: DBOS records the child workflow's ID via OAOO, so on
 * recovery `startWorkflow` returns the same handle and `getResult` waits on
 * the in-flight child rather than spawning a duplicate.
 */
async function gateWorkflowFn(
  ctx: FireAutomationContext,
): Promise<FireAutomationOutcome> {
  const handle = await DBOS.startWorkflow(fireAutomationWorkflow, {
    queueName: AUTOMATIONS_GLOBAL_QUEUE,
  })(ctx);
  return await handle.getResult();
}

const gateWorkflow = DBOS.registerWorkflow(gateWorkflowFn, {
  name: "automationGateWorkflow",
});

/**
 * Per-org gate. Top-level entry for both cron and event-triggered fires.
 * The workflow itself runs on the per-org queue `automations-org-<orgId>`
 * (set at enqueue time, not here); it holds that slot until the nested
 * per-automation gate returns. That hold is what enforces per-org
 * concurrency and prevents a single tenant from monopolising the global
 * queue's slot pool.
 *
 * Replays are safe: DBOS records the child workflow's ID via OAOO, so on
 * recovery `startWorkflow` returns the same handle and `getResult` waits on
 * the in-flight child rather than spawning a duplicate.
 */
async function orgGateWorkflowFn(
  ctx: FireAutomationContext,
): Promise<FireAutomationOutcome> {
  const handle = await DBOS.startWorkflow(gateWorkflow, {
    queueName: AUTOMATIONS_GATE_QUEUE,
    enqueueOptions: { queuePartitionKey: ctx.automationId },
  })(ctx);
  return await handle.getResult();
}

export const orgGateWorkflow = DBOS.registerWorkflow(orgGateWorkflowFn, {
  name: "automationOrgGateWorkflow",
});

/**
 * Scheduled-fire entry. Bound to DBOS schedules created per cron trigger.
 * Ensures the org queue exists, then re-enqueues `orgGateWorkflow` on it.
 * Returns without awaiting so the scheduler tick stays fast.
 */
async function cronEntryWorkflowFn(
  _scheduledTime: Date,
  ctx: FireAutomationContext,
): Promise<void> {
  await ensureOrgQueue(ctx.organizationId);
  await DBOS.startWorkflow(orgGateWorkflow, {
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
