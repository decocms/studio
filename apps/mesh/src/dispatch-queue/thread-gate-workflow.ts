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
 * Runtime dependencies (dispatch fn, studio-context factory, dispatch deps)
 * are looked up via a module-level registry. App boot wires them via
 * `setThreadGateRuntime` BEFORE `DBOS.launch()`. The workflow is registered
 * at import time so the recovery executor can replay it after a crash.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type {
  DispatchRunDeps,
  DispatchRunInput,
  WireHarnessInput,
} from "@/api/routes/decopilot/dispatch-run";
import type { StudioContext } from "@/core/studio-context";
import { posthog } from "@/posthog";
import { sleep } from "@decocms/std";
import type {
  LinkWorkQueue,
  MessagesRef,
  WorkItem,
  WorkItemSandbox,
} from "@/api/routes/decopilot/link-work-queue";

export const THREAD_GATE_QUEUE = "thread-gate";

/** Thread statuses that indicate a run has reached a terminal state. */
export const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "requires_action",
] as const);

export interface PollUntilTerminalOptions {
  intervalMs: number;
  maxAttempts: number;
  signal?: AbortSignal;
}

/**
 * Poll `fetchStatus` until it returns a terminal status or `maxAttempts`
 * is exhausted. Uses `sleep` from `@decocms/std` — never hand-rolled.
 */
export async function pollUntilTerminal(
  fetchStatus: () => Promise<string>,
  opts: PollUntilTerminalOptions,
): Promise<string> {
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason ?? new Error("gate aborted");
    }
    const status = await fetchStatus();
    if (
      TERMINAL_STATUSES.has(
        status as "completed" | "failed" | "requires_action",
      )
    ) {
      return status;
    }
    if (attempt < opts.maxAttempts - 1) {
      await sleep(opts.intervalMs, { signal: opts.signal }).catch(() => {});
    }
  }
  throw new Error(
    `[threadGate] gate timed out polling for terminal status (${opts.maxAttempts} attempts)`,
  );
}

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
   * use the same gate but shouldn't pollute message-send analytics.
   */
  source: "user-message" | "automation";
}

export type ThreadGateOutcome = { taskId: string };

export type DispatchRunAndWaitFn = (
  input: DispatchRunInput,
  ctx: StudioContext,
  deps: DispatchRunDeps,
) => Promise<{ taskId: string }>;

export type StudioContextFactory = (
  orgId: string,
  userId: string,
) => Promise<StudioContext | null>;

export interface ThreadGateRuntime {
  dispatchRunFn: DispatchRunAndWaitFn;
  meshContextFactory: StudioContextFactory;
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
  /**
   * Pull-transport dependencies (Phase F). When present (NATS is available),
   * the gate always takes the pull path. Falls back to dispatchRunFn when
   * absent (no-NATS / test environments).
   */
  pullDispatchFn?: (
    input: DispatchRunInput,
    ctx: StudioContext,
    deps: DispatchRunDeps,
  ) => Promise<{
    taskId: string;
    runFenceToken: string;
    harnessInput: WireHarnessInput;
    messagesRef: MessagesRef | null;
    sandboxConfig: WorkItemSandbox | null;
    orgSlug: string | null;
  }>;
  workQueue?: LinkWorkQueue;
  /**
   * Poll interval for the gate's status-polling loop (ms). Defaults to
   * 3 000 ms in production; tests pass 0.
   */
  gatePollIntervalMs?: number;
  /**
   * Maximum poll attempts before the gate fails the run.
   * Defaults to 1 200 (= 1 h at 3 s intervals).
   */
  gatePollMaxAttempts?: number;
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

  // Phase F: pull is the default when NATS is available (workQueue + pullDispatchFn
  // both wired). The old per-thread link_transport='pull' gate is gone — all
  // user-desktop dispatches take the pull path on NATS-capable deployments.
  // Falls back to dispatchRunFn (in-cluster WS path) when NATS is absent —
  // CI/test environments without NATS still dispatch correctly.
  const isPull = rt.pullDispatchFn != null && rt.workQueue != null;

  if (!isPull) {
    // ── Original ws path — unchanged ────────────────────────────────────
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
    return;
  }

  // ── Pull path (Phase B) ──────────────────────────────────────────────
  // 1. Claim the run and mint the fence token.
  const timeoutMs = ctx.timeoutMs ?? rt.runTimeoutMs;
  const abortController = new AbortController();
  const timeoutHandle =
    timeoutMs != null
      ? setTimeout(() => abortController.abort(), timeoutMs)
      : null;

  try {
    const {
      taskId,
      runFenceToken,
      harnessInput,
      messagesRef,
      sandboxConfig,
      orgSlug,
    } = await rt.pullDispatchFn!(
      { ...request, abortSignal: abortController.signal },
      meshCtx,
      rt.deps,
    );

    // 2. Publish the work item idempotently (L1: keyed by runId).
    // `harnessInput` is the complete wire `HarnessStreamInput` that
    // `pullDispatch` built eagerly (mcp endpoint minted, messages
    // materialized, virtualMcp + fence token already on it) — exactly the
    // shape the daemon validates against `harnessStreamInputSchema`. The
    // prior gap (publishing the raw DispatchRunInput) is now closed.
    // This work item is consumed by the Phase D daemon pull loop, which
    // drains the per-user WorkQueue subject and runs the harness remotely.
    //
    // `sandbox` carries the full provisioning config (handle, repo clone URL,
    // workload runtime) so the daemon can spawn the sandbox cold. `orgSlug`
    // lets the daemon construct the ingest URL without a DB lookup.
    // `messagesRef` is present when `pullDispatch` offloaded messages to
    // object storage because the harnessInput exceeded MAX_PUBLISH_BYTES;
    // the daemon forwards it verbatim to /_sandbox/dispatch for re-inflation.
    const workItem: WorkItem = {
      runId: taskId,
      threadId: request.taskId ?? ctx.threadId,
      orgId: request.organizationId,
      userId: request.userId,
      runFenceToken,
      harnessInput: harnessInput as Record<string, unknown>,
      ...(sandboxConfig ? { sandbox: sandboxConfig } : {}),
      ...(orgSlug ? { orgSlug } : {}),
      ...(messagesRef ? { messagesRef } : {}),
    };
    await rt.workQueue!.publish(request.userId, workItem);

    // 3. Poll threads.status until terminal (L6, L7).
    // The ingest finish handler transitions the run to a terminal status,
    // which releases this polling loop. DBOS.setEvent/getEvent is
    // documented as a future optimization; this polling approach is
    // simpler, dissolves the workflowID-threading problem, and requires
    // no new SDK patterns.
    const pollIntervalMs = rt.gatePollIntervalMs ?? 3_000;
    const pollMaxAttempts = rt.gatePollMaxAttempts ?? 1_200; // ~1 h

    await pollUntilTerminal(
      async () => {
        const t = await meshCtx.storage.threads.get(taskId);
        return t?.status ?? "unknown";
      },
      {
        intervalMs: pollIntervalMs,
        maxAttempts: pollMaxAttempts,
        signal: abortController.signal,
      },
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
