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
 * Used by user-message POSTs. Automation fires do NOT pass through this
 * queue — each fire is a fresh thread (no per-thread contention), so it runs
 * the shared `runDispatchSteps` body directly on its own per-org queue slot.
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
import type { DispatchTarget } from "@/links/resolve-dispatch-target";
import { posthog } from "@/posthog";
import { sleep } from "@decocms/std";
import type {
  MessagesRef,
  WorkItem,
  WorkItemSandbox,
} from "@/links/link-work-item";
import type { LinkWorkPublisher } from "@/links/tunnel-work-dispatch";
import {
  publishRunStatusStage,
  shouldPublishThreadGateRunStatus,
} from "@/api/routes/decopilot/run-status-stage";

export { THREAD_GATE_QUEUE } from "./queue-names";
import { THREAD_GATE_QUEUE } from "./queue-names";

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
 * Pure decision for the thread-gate's desktop-vs-hosted routing.
 *
 * Desktop dispatch fires when BOTH of:
 *   1. the runtime has a desktop work publisher + prepareLinkWorkFn wired;
 *   2. the dispatch target's `sandboxProviderKind === 'user-desktop'` — i.e.
 *      POST-time `resolveDispatchTarget` found a LIVE desktop link (the gate
 *      trusts the pre-resolved target and never re-probes the link, which
 *      would drift on replay if the link went offline).
 *
 * EVERY user-desktop run goes through the desktop downstream command publisher
 * over tunnel. Decopilot desktop also runs in a sandbox, and the work item
 * carries its sandbox config (see `resolveLinkSandboxConfig`). The v1
 * generation is handled by `consumeRelayedRun`'s v1 whole-message branch
 * (built in Task 10), so a v1 user-desktop thread persists correctly.
 *
 * Hosted agent-sandbox threads and undefined targets (legacy paths) all yield
 * `false` → hosted local dispatch.
 */
export function decideLinkDispatch(input: {
  isLinkCapable: boolean;
  sandboxProviderKind?: DispatchTarget["sandboxProviderKind"];
}): boolean {
  return input.isLinkCapable && input.sandboxProviderKind === "user-desktop";
}

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
   * Desktop downstream dependencies. When present and the dispatch target's
   * `sandboxProviderKind === 'user-desktop'`, the gate uses these instead of
   * dispatchRunFn — for every user-desktop run (all harnesses, both storage
   * generations). In production this is the tunnel work publisher.
   */
  prepareLinkWorkFn?: (
    input: DispatchRunInput,
    ctx: StudioContext,
    deps: DispatchRunDeps,
  ) => Promise<{
    taskId: string;
    runFenceToken: string;
    harnessInput: WireHarnessInput;
    messagesRef: MessagesRef | null;
    sandboxConfig: WorkItemSandbox | null;
    orgSlug: string;
  }>;
  workPublisher?: LinkWorkPublisher;
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
  const taskId = request.taskId ?? ctx.threadId;
  if (
    shouldPublishThreadGateRunStatus({
      harnessId: request.harnessId,
      sandboxProviderKind: request.target?.sandboxProviderKind,
    })
  ) {
    await publishRunStatusStage(rt.deps.streamBuffer, taskId, "starting-run");
  }

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

  // Resolve whether this thread should use a desktop downstream transport.
  //
  // TRANSPORT CONVERGENCE: EVERY user-desktop run goes through the desktop
  // command publisher — all harnesses (decopilot, claude-code, codex) and both
  // storage generations (v1, v2). The target was resolved once at POST time
  // (routes.ts
  // `resolveDispatchTarget`) and forwarded on `request.target`; we key off it
  // here instead of re-probing the resolved target — re-resolving at replay
  // time would drift if the link went offline between enqueue and dispatch.
  // Hosted agent-sandbox threads (no desktop daemon) yield
  // `sandboxProviderKind === "agent-sandbox"` → hosted local dispatch; an
  // undefined target (legacy paths) also falls back.
  const workPublisher = rt.workPublisher;
  const isLinkCapable = rt.prepareLinkWorkFn != null && workPublisher != null;
  const useLink = decideLinkDispatch({
    isLinkCapable,
    sandboxProviderKind: request.target?.sandboxProviderKind,
  });

  if (!useLink) {
    // ── Hosted local-dispatch path (agent-sandbox / legacy) — unchanged ──
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

  // ── Link path ─────────────────────────────────────────────────────────
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
    } = await rt.prepareLinkWorkFn!(
      { ...request, abortSignal: abortController.signal },
      meshCtx,
      rt.deps,
    );

    // 2. Publish the work item idempotently (L1: keyed by the per-attempt
    //    runFenceToken, NOT runId — runId aliases the threadId, so sequential
    //    turns would collide in NATS dedup; see `workItemDedupKey`).
    // `harnessInput` is the complete wire `HarnessStreamInput` that
    // `prepareLinkWorkDispatch` built eagerly (mcp endpoint minted, messages
    // materialized, virtualMcp + fence token already on it) — exactly the
    // shape the daemon validates against `harnessStreamInputSchema`. The
    // prior gap (publishing the raw DispatchRunInput) is now closed.
    // This work item is consumed by the daemon link work handler over the
    // active tunnel and runs the harness remotely.
    //
    // `sandbox` carries the full provisioning config (handle, repo clone URL,
    // workload runtime) so the daemon can spawn the sandbox cold. `orgSlug`
    // lets the daemon construct the ingest URL without a DB lookup.
    // `messagesRef` is present when `prepareLinkWorkDispatch` offloaded
    // messages to object storage because the harnessInput exceeded the inline
    // payload budget; the daemon forwards it verbatim to /_sandbox/dispatch
    // for re-inflation.
    const workItem: WorkItem = {
      runId: taskId,
      threadId: request.taskId ?? ctx.threadId,
      orgId: request.organizationId,
      userId: request.userId,
      runFenceToken,
      harnessInput: harnessInput as Record<string, unknown>,
      ...(sandboxConfig ? { sandbox: sandboxConfig } : {}),
      orgSlug,
      ...(messagesRef ? { messagesRef } : {}),
    };
    try {
      await workPublisher!.publish(request.userId, workItem, {
        signal: abortController.signal,
      });
    } catch (err) {
      // Optimistic dispatch: the desktop link is unreachable (e.g.
      // `tunnel_no_first_frame` — no daemon answering the tunnel). Self-fail the
      // run so it settles into a terminal `failed` state instead of hanging
      // `in_progress` forever: nothing will arrive over the tunnel to release
      // the poll below, and re-throwing would only make DBOS retry the publish
      // against a daemon that isn't there. The frontend already gates the
      // compose box on the live `/api/links/status` probe, so this is the rare
      // race where the link dropped between the probe and the send.
      console.error(
        `[thread-gate] link work publish failed for run=${taskId}; marking failed`,
        err,
      );
      await meshCtx.storage.threads.forceFailIfInProgress(taskId);
      return;
    }

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

/**
 * The dispatch execution body: track-started → dispatch → track-failed,
 * as recorded DBOS steps. Shared by two callers so the executor lives in one
 * place:
 *
 *  - `threadGateWorkflow` (user messages) runs it behind the per-thread queue
 *    slot, which is what serializes messages on the same thread.
 *  - `fireAutomationWorkflow` calls it directly on its own per-org queue slot.
 *    Automation fires each create a fresh thread, so they need no per-thread
 *    gate — routing them through the thread-gate queue was only ever a way to
 *    reuse this body, at the cost of a second queue hop.
 *
 * MUST be called from within a DBOS workflow context (it issues `runStep`s).
 * The analytics steps no-op for non-`user-message` sources.
 */
export async function runDispatchSteps(
  ctx: ThreadGateContext,
): Promise<ThreadGateOutcome> {
  await DBOS.runStep(() => trackMessageStartedStep(ctx), {
    name: "trackMessageStarted",
  });
  try {
    // Retriable EXCEPT for `user-desktop` runs. A user-desktop run dispatches to
    // a daemon on the user's laptop that keeps running after the pod dies; a DBOS
    // replay on another executor would open a SECOND concurrent dispatch against
    // the same workdir, racing on git state and tool output. We can't reliably
    // stop that daemon on a hard crash (the graceful abort doesn't run), so these
    // stay non-retriable: pod death = clean "run failed", not a corruption hazard.
    // Hosted/in-process runs (agent-sandbox, undefined target) have no external
    // daemon to race, so they're retriable and DBOS recovers them. The thread-gate
    // queue (concurrency=1 per threadId) still guarantees a single in-flight
    // dispatch per thread.
    const retriable =
      ctx.request.target?.sandboxProviderKind !== "user-desktop";
    await DBOS.runStep(() => dispatchRunAndWaitStep(ctx), {
      name: "dispatchRunAndWait",
      retriesAllowed: retriable,
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

async function threadGateWorkflowFn(
  ctx: ThreadGateContext,
): Promise<ThreadGateOutcome> {
  return runDispatchSteps(ctx);
}

const threadGateWorkflow = DBOS.registerWorkflow(threadGateWorkflowFn, {
  name: "threadGateWorkflow",
  // A gate now spans the whole run (no 1 h cap), so a multi-hour run can
  // survive many rolling deploys; each pod recycle the gate lives through costs
  // one recovery attempt. The default (100) could dead-letter a legitimately
  // long run mid-flight, which would free the slot while the daemon still runs
  // (a second-dispatch hazard). 1000 gives generous headroom.
  maxRecoveryAttempts: 1000,
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
