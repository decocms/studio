/**
 * Thread Gate Workflow.
 *
 * Per-thread serialization for agent runs. Concurrency=1 per thread ensures
 * messages on the same thread execute sequentially: a queued user message
 * waits for the active run to terminate before being dispatched.
 *
 * The workflow body is a single `DBOS.runStep` that calls
 * `dispatchRunAndWait`. Holding the partition slot until that step returns
 * is what gives us "queue behavior" — DBOS won't dequeue the next message
 * on the same thread until this run is finished.
 *
 * Used by user-message POSTs (later: automation fires too). Automations
 * layer their existing per-automation and global gates above this
 * per-thread one; user messages enter here directly.
 *
 * Runtime dependencies (dispatch fn, mesh-context factory, dispatch deps)
 * are looked up via a module-level registry. App boot wires them via
 * `setThreadGateRuntime` BEFORE `DBOS.launch()`. The workflow is registered
 * at import time so the recovery executor can replay it after a crash.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type {
  DispatchRunDeps,
  DispatchRunInput,
} from "@/api/routes/decopilot/dispatch-run";
import type { MeshContext } from "@/core/mesh-context";
import { posthog } from "@/posthog";

export const THREAD_GATE_QUEUE = "thread-gate";

/**
 * Per-thread concurrent run cap (partition cap on the gate queue).
 * Holding the slot until `dispatchRunAndWait` returns serializes messages
 * on the same thread.
 */
export const THREAD_GATE_PARTITION_CONCURRENCY = 1;

/**
 * Serializable subset of `DispatchRunInput`. The abort signal is the only
 * non-serializable field; the workflow step constructs its own from a
 * timeout when one is provided.
 */
export type SerializableDispatchRunInput = Omit<
  DispatchRunInput,
  "abortSignal"
>;

export interface ThreadGateContext {
  /** Stable thread identifier — also used as the queue partition key. */
  threadId: string;
  /** Dispatch input minus the non-serializable abort signal. */
  request: SerializableDispatchRunInput;
  /**
   * Optional per-call timeout (ms). When set, the workflow aborts dispatch
   * after this duration. Automations pass an explicit value; user messages
   * leave this unset because tool-using agent loops (Claude Code, deep
   * research, multi-step assistants) routinely run longer than any fixed
   * cap, and were not bounded by the legacy fire-and-forget HTTP path.
   */
  timeoutMs?: number;
  /**
   * Where the enqueue came from. Drives whether `chat_message_started`
   * fires: only user-initiated POSTs count as messages — automation fires
   * and observation runs use the same gate but shouldn't pollute message-send
   * analytics.
   */
  source: "user-message" | "automation" | "observation";
}

export type ThreadGateOutcome = { taskId: string };

export type DispatchRunAndWaitFn = (
  input: DispatchRunInput,
  ctx: MeshContext,
  deps: DispatchRunDeps,
) => Promise<{ taskId: string }>;

export type MeshContextFactory = (
  orgId: string,
  userId: string,
) => Promise<MeshContext | null>;

export interface ThreadGateRuntime {
  dispatchRunFn: DispatchRunAndWaitFn;
  meshContextFactory: MeshContextFactory;
  deps: Pick<
    DispatchRunDeps,
    "runRegistry" | "cancelBroadcast" | "streamBuffer" | "sseHub"
  >;
  /**
   * Default per-run timeout (ms). Overridable per-enqueue via
   * `ThreadGateContext.timeoutMs`. When neither is set, no abort timer is
   * installed.
   */
  runTimeoutMs?: number;
}

let runtime: ThreadGateRuntime | null = null;

export function setThreadGateRuntime(rt: ThreadGateRuntime): void {
  runtime = rt;
}

function requireRuntime(): ThreadGateRuntime {
  if (!runtime) {
    throw new Error(
      "[threadGate] runtime not initialized — setThreadGateRuntime() must run before workflows fire",
    );
  }
  return runtime;
}

async function dispatchRunAndWaitStep(ctx: ThreadGateContext): Promise<void> {
  const rt = requireRuntime();
  const { request } = ctx;

  const meshCtx = await rt.meshContextFactory(
    request.organizationId,
    request.userId,
  );
  if (!meshCtx) {
    // Throw so DBOS records the step (and the workflow) as failed.
    // Swallowing into `{error}` would mark the workflow SUCCESS and
    // break retry / failure tooling.
    throw new Error("user membership lost mid-dispatch");
  }

  // Abort timer is opt-in. Automations supply a 5-min cap so a runaway
  // cron can't pin a thread slot forever; user messages leave it unset
  // because tool-using agent loops (Claude Code, deep research,
  // multi-step assistants) routinely outlast any fixed cap, and were not
  // bounded by the legacy fire-and-forget HTTP path.
  const timeoutMs = ctx.timeoutMs ?? rt.runTimeoutMs;
  const abortController = new AbortController();
  const timeoutHandle =
    timeoutMs != null
      ? setTimeout(() => abortController.abort(), timeoutMs)
      : null;

  try {
    // Dispatch errors propagate. `dispatchRunAndWait` guarantees the run
    // is already force-finished to "failed" in the registry before
    // throwing (see `prepareRun`), so application state stays consistent
    // — DBOS just gets to see the failure too.
    await rt.dispatchRunFn(
      { ...request, abortSignal: abortController.signal },
      meshCtx,
      rt.deps,
    );
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }
}

/**
 * PostHog "chat_message_started" emission, wrapped in a DBOS step so it
 * runs at most once per workflow. A retried POST that collapses onto an
 * existing workflowID re-enters the workflow via DBOS replay; the step
 * output is recorded in the workflow journal and the body doesn't
 * re-execute. Without this, retries would double-count in PostHog.
 *
 * Suppressed for automation fires — they reuse this gate but don't
 * represent a user-initiated message.
 */
async function trackMessageStartedStep(ctx: ThreadGateContext): Promise<void> {
  if (ctx.source !== "user-message") return;
  const { request } = ctx;
  posthog.capture({
    distinctId: request.userId,
    event: "chat_message_started",
    groups: { organization: request.organizationId },
    properties: {
      organization_id: request.organizationId,
      agent_id: request.agent,
      mode: request.mode,
      thread_id: request.taskId ?? ctx.threadId,
      credential_id: request.models.credentialId,
    },
  });
}

/**
 * Balances `chat_message_started` when the dispatch step throws *before*
 * `streamText` is set up (model-permission failure, agent not found,
 * thread-ownership check, etc. — see `prepareRun`). In-flight stream
 * errors are already emitted by `streamText.onError` inside `dispatchRunAndWait`,
 * so this only covers the pre-stream gap.
 *
 * `error_category: "setup"` keeps these distinguishable from stream-time
 * failures (which use `classifyStreamError`).
 */
async function trackMessageFailedStep(
  ctx: ThreadGateContext,
  errorMessage: string,
): Promise<void> {
  if (ctx.source !== "user-message") return;
  const { request } = ctx;
  posthog.capture({
    distinctId: request.userId,
    event: "chat_message_failed",
    groups: { organization: request.organizationId },
    properties: {
      organization_id: request.organizationId,
      thread_id: request.taskId ?? ctx.threadId,
      agent_id: request.agent,
      model_id: request.models.thinking.id,
      mode: request.mode,
      error_category: "setup",
      error_message: errorMessage,
    },
  });
}

async function threadGateWorkflowFn(
  ctx: ThreadGateContext,
): Promise<ThreadGateOutcome> {
  await DBOS.runStep(() => trackMessageStartedStep(ctx), {
    name: "trackMessageStarted",
  });
  try {
    // The dispatch step is non-retriable for v1. If a pod dies mid-stream,
    // the desktop daemon (if remote-cli) keeps running, and a DBOS replay
    // would open a second concurrent dispatch against the same workdir —
    // racing on git state and tool output. Marking the step non-retriable
    // converts pod death into a clean "run failed" rather than a corruption
    // hazard. Re-attach semantics (stable runId, daemon-side dedupe) are v2.
    await DBOS.runStep(() => dispatchRunAndWaitStep(ctx), {
      name: "dispatchRunAndWait",
      retriesAllowed: false,
    });
  } catch (err) {
    // Setup errors (prepareRun) propagate out of `dispatchRunAndWait`; in-flight
    // stream errors are handled inside `streamText.onError` and don't
    // reach here. So a thrown step at this point means setup failed —
    // emit the balancing failed event for analytics integrity. Wrapped
    // in its own DBOS step so replay doesn't double-emit.
    const msg = err instanceof Error ? err.message : String(err);
    await DBOS.runStep(() => trackMessageFailedStep(ctx, msg), {
      name: "trackMessageFailed",
    });
    throw err;
  }
  return { taskId: ctx.request.taskId ?? ctx.threadId };
}

const threadGateWorkflow = DBOS.registerWorkflow(threadGateWorkflowFn, {
  name: "threadGateWorkflow",
});

/**
 * Enqueue a thread run on the partitioned thread-gate queue. The partition
 * key is the threadId, so per-thread concurrency=1 serializes runs on the
 * same thread while different threads progress in parallel.
 *
 * Callers can pass `workflowID` for idempotency (e.g. a client-supplied
 * ULID on POST /messages) — a redelivered request collapses onto the
 * existing workflow handle instead of duplicating the run.
 *
 * Fire-and-forget: returns the workflowID without awaiting completion.
 * Use `awaitThreadRun` when the caller needs to block on the dispatch
 * outcome (e.g. parent workflows that hold their own queue slot).
 */
export async function enqueueThreadRun(
  ctx: ThreadGateContext,
  opts?: { workflowID?: string },
): Promise<{ workflowID: string }> {
  const handle = await DBOS.startWorkflow(threadGateWorkflow, {
    queueName: THREAD_GATE_QUEUE,
    enqueueOptions: { queuePartitionKey: ctx.threadId },
    workflowID: opts?.workflowID,
  })(ctx);
  return { workflowID: handle.workflowID };
}

/**
 * Enqueue and await completion. Used by callers that hold an outer
 * workflow slot and need the dispatch outcome to advance — chiefly the
 * automation fire path, which layers its own per-automation and global
 * gates above this per-thread one. Failures from the inner workflow
 * propagate so the caller's step is recorded as failed by DBOS.
 */
export async function awaitThreadRun(
  ctx: ThreadGateContext,
  opts?: { workflowID?: string },
): Promise<ThreadGateOutcome> {
  const handle = await DBOS.startWorkflow(threadGateWorkflow, {
    queueName: THREAD_GATE_QUEUE,
    enqueueOptions: { queuePartitionKey: ctx.threadId },
    workflowID: opts?.workflowID,
  })(ctx);
  return await handle.getResult();
}
