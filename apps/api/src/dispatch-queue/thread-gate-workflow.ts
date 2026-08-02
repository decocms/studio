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
  DurableDispatchRunInput,
} from "@/api/routes/decopilot/dispatch-run";
import type { StudioContext } from "@/core/studio-context";
import { posthog } from "@/posthog";
import {
  publishRunStatusStage,
  shouldPublishThreadGateRunStatus,
} from "@/api/routes/decopilot/run-status-stage";
import { mintRunFenceToken } from "@/api/routes/decopilot/dispatch-fence";
import { consumeRunProjection } from "@/api/routes/decopilot/consume-run-projection";

export { THREAD_GATE_QUEUE } from "./queue-names";
import { THREAD_GATE_QUEUE } from "./queue-names";
import { startHostedHarness } from "./hosted-harness-workflow";

/**
 * Per-thread concurrent run cap (partition cap on the gate queue).
 * Holding the slot until `dispatchRunAndWait` returns serializes messages
 * on the same thread.
 */
export const THREAD_GATE_PARTITION_CONCURRENCY = 1;

/**
 * Guard: every harness agent loop runs in the cluster worker.
 *
 * Decopilot always did. CLI harnesses (claude-code, codex) used to run their
 * loop ON the sandbox — but the only sandbox that could host one was the
 * desktop daemon reached over the link tunnel, and that path is gone: local
 * CLI runs now happen entirely inside the Tauri desktop app (`apps/native`,
 * which owns its own Rust `local-api` and never enqueues onto this gate).
 *
 * The `(CLI, agent-sandbox)` cloud-CLI corner was never wired and still isn't,
 * so it keeps throwing rather than falling through to a cluster-hosted loop
 * that would silently ignore the requested sandbox. That behavior is unchanged
 * by the link removal — it already threw for every agent-sandbox target.
 */
export function assertHarnessRunsInCluster(harnessId?: string | null): void {
  if (harnessId === "claude-code" || harnessId === "codex") {
    throw new Error(
      `not implemented: CLI harness "${harnessId}" has no cluster host (cloud-CLI is a planned follow-up; local CLI runs in the Tauri desktop app)`,
    );
  }
}

/**
 * Serializable subset of `DispatchRunInput`. The abort signal is the only
 * non-serializable field, and it is dropped: the gate hands the run to a
 * hosted child workflow that owns its own lifetime (cancellation flows
 * through `cancelHostedHarness`, staleness through the idle timeout).
 */
export type SerializableDispatchRunInput =
  | Omit<DispatchRunInput, "abortSignal">
  | Omit<DurableDispatchRunInput, "abortSignal">;

export interface ThreadGateContext {
  /** Stable thread identifier — also used as the queue partition key. */
  threadId: string;
  /** Dispatch input minus the non-serializable abort signal. */
  request: SerializableDispatchRunInput;
  /**
   * Where the enqueue came from. Drives whether `chat_message_started`
   * fires: only user-initiated POSTs count as messages — automation fires
   * and background-tool reactions use the same gate but shouldn't pollute
   * message-send analytics.
   */
  source: "user-message" | "automation" | "background-tool";
}

export type ThreadGateOutcome = { taskId: string };

export type StudioContextFactory = (
  orgId: string,
  userId: string,
) => Promise<StudioContext | null>;

export interface ThreadGateRuntime {
  studioContextFactory: StudioContextFactory;
  deps: Pick<
    DispatchRunDeps,
    "runRegistry" | "cancelBroadcast" | "streamBuffer" | "sseHub"
  >;
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

/**
 * Descriptor returned by `dispatchRunAndWaitStep` when the hosted path is
 * taken. The workflow BODY calls `startHostedHarness` using this descriptor
 * — DBOS forbids `DBOS.startWorkflow` from within a step/transaction, so the
 * start must happen in workflow context. The descriptor is serializable and
 * replay-stable (keyed by runId+fenceToken, both stable across replays).
 */
type HostedEnqueueDescriptor = Parameters<typeof startHostedHarness>[0];

/**
 * Result of `dispatchRunAndWaitStep`.
 * - `{ hostedEnqueue: ... }`: hosted path taken; workflow body must call
 *   `startHostedHarness` with this descriptor (DBOS step restriction).
 * - `null`: desktop path taken (work item published) — no hosted enqueue needed.
 */
type DispatchStepResult = {
  runFenceToken: string;
  hostedEnqueue?: HostedEnqueueDescriptor;
};

export function claimRunFenceForDispatch(
  request: SerializableDispatchRunInput,
  mint: () => string = mintRunFenceToken,
): {
  runFenceToken: string;
  claimedRequest: SerializableDispatchRunInput;
  shouldPersistFence: boolean;
} {
  const submitFenceToken = request.runFenceToken;
  if (submitFenceToken) {
    return {
      runFenceToken: submitFenceToken,
      claimedRequest: request,
      shouldPersistFence: false,
    };
  }
  const runFenceToken = mint();
  return {
    runFenceToken,
    claimedRequest: {
      ...request,
      runFenceToken,
    },
    shouldPersistFence: true,
  };
}

async function dispatchRunAndWaitStep(
  ctx: ThreadGateContext,
): Promise<DispatchStepResult> {
  const rt = requireRuntime();
  const { request } = ctx;
  const taskId = request.taskId ?? ctx.threadId;
  if (
    shouldPublishThreadGateRunStatus({
      harnessId: request.harnessId,
    })
  ) {
    await publishRunStatusStage(rt.deps.streamBuffer, taskId, "starting-run");
  }

  const studioCtx = await rt.studioContextFactory(
    request.organizationId,
    request.userId,
  );
  if (!studioCtx) {
    // Throw so DBOS records the step (and the workflow) as failed.
    // Swallowing into `{error}` would mark the workflow SUCCESS and
    // break retry / failure tooling.
    throw new Error("user membership lost mid-dispatch");
  }

  // Every harness loop runs here in the cluster worker; CLI harnesses have no
  // cluster host and throw (see `assertHarnessRunsInCluster`).
  assertHarnessRunsInCluster(request.harnessId);

  // The run fence is minted and persisted HERE, inside the dispatch step —
  // i.e. only while this gate holds the thread's partition slot. POST-time
  // minting was removed: it let a message QUEUED behind a running turn
  // overwrite the running turn's fence, which made the projector skip that
  // turn's projection (stranding its reply). A request may still carry a
  // fence (redelivery/replay of this step's own recorded output); absent one,
  // mint + persist now.
  const fenceThreadId = request.taskId ?? ctx.threadId;
  const { runFenceToken, claimedRequest, shouldPersistFence } =
    claimRunFenceForDispatch(request);
  if (shouldPersistFence) {
    await studioCtx.storage.threads.setRunFence(fenceThreadId, runFenceToken);
  }

  // Hosted dispatch. Every run takes this path.
  // RETURN a descriptor to the workflow BODY instead of enqueuing here.
  // DBOS forbids `DBOS.startWorkflow` from within a step or transaction —
  // the actual `startHostedHarness` call happens in `runDispatchSteps`
  // (workflow body context) using this descriptor. The descriptor is
  // serializable and replay-stable (keyed by runId+fenceToken, both stable
  // across DBOS replays). The child workflow runs the in-process agent loop
  // (streaming to NATS + publishing {done}); the gate does not await it at
  // all (T3) — completion flows exclusively through the consume step in
  // `runDispatchSteps`, which live-tails the same stream the child writes
  // to. The submit-time fence keys the child workflow ID
  // (`hostedChildWorkflowId(runId, fenceToken)`,
  // `decopilot-hosted:<runId>:<fenceToken>`) so a redelivery collapses onto
  // the existing child rather than spawning a second loop.
  return {
    runFenceToken,
    hostedEnqueue: {
      runId: taskId,
      fenceToken: runFenceToken,
      threadId: ctx.threadId,
      request: claimedRequest,
    },
  };
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
 * thread-ownership check, etc. — see `prepareRun`). In-flight stream errors
 * (once `streamText` is running) are NOT emitted here — the durable projector's
 * `recordFailed` is the sole `chat_message_failed` source for those, fired
 * once the run's fenced terminal is materialized on the stream (both hosted
 * and desktop). This step only covers the pre-stream gap: a `dispatchRunAndWait`
 * throw here means setup failed before any run/stream existed for the
 * projector to fold, so nothing else will ever emit the balancing event.
 *
 * `error_category: "setup"` keeps these distinguishable from the projector's
 * `kind: "harness" | "projection"` categorization of stream-time failures.
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
  let dispatchResult: DispatchStepResult;
  try {
    // Retriable: every run is now hosted in-process, so a DBOS replay on another
    // executor has no external daemon to race against. (The desktop link used to
    // make this conditional — a laptop daemon outlives the pod, so a replay would
    // open a SECOND dispatch against the same workdir. That path is gone.) The
    // thread-gate queue (concurrency=1 per threadId) still guarantees a single
    // in-flight dispatch per thread.
    dispatchResult = await DBOS.runStep(() => dispatchRunAndWaitStep(ctx), {
      name: "dispatchRunAndWait",
      retriesAllowed: true,
    });

    // Hosted: START (do NOT await) the child workflow from the WORKFLOW BODY
    // (DBOS forbids `DBOS.startWorkflow` from within a step) — this call sits
    // directly in workflow-body context, not inside a `DBOS.runStep`, even
    // though it is textually part of this try block. The descriptor is the
    // memoized step return — serializable, replay-stable — and the child
    // workflow ID it produces (`hostedChildWorkflowId(runId, fenceToken)`) is
    // itself replay-stable, so redelivery collapses onto the same child.
    //
    // This is fire-and-forget ONLY with respect to the child's RESULT: it is
    // never awaited to completion — the child is a fully detached,
    // self-terminating executor (T1's contract: it publishes its own
    // fence-scoped terminal for a clean finish AND for every caught failure),
    // and the consume step below remains the sole completion authority for
    // BOTH topologies once the child has actually started.
    //
    // The START itself failing, though, is a setup failure like any other
    // throw in this try block — NOT swallowed. A `DBOS.startWorkflow` fault
    // here (queue/PG unavailable) means the child never came into existence,
    // so there is nothing for the consume step's live tail to ever pick up:
    // swallowing it (as this used to) left the run tailing an empty subject
    // for the full 30-minute idle timeout and dying mislabeled as
    // `failed(kind:"projection")` with no setup analytics — and a merely
    // transient fault could even race into a stuck spurious `failed` (the
    // idle-timeout's `markRunFailed` landing before recovery's successful
    // re-run). Falling into the catch below instead restores the same
    // semantics a `dispatchRunAndWaitStep` throw already has: fire the setup
    // analytics, rethrow, and fail the gate attempt so DBOS recovery
    // (`maxRecoveryAttempts: 1000`) re-runs it — transient enqueue faults
    // self-heal (the deterministic child workflow ID dedupes any child that
    // did actually start, on replay), persistent faults fail fast with
    // correct categorization instead of being swallowed.
    if (dispatchResult.hostedEnqueue) {
      await startHostedHarness(dispatchResult.hostedEnqueue);
    }
  } catch (err) {
    // Setup errors (prepareRun / link-work preparation, or — as of this fix —
    // a hosted child failing to even START just above) propagate out BEFORE
    // any run/child/stream exists — there is nothing for the consume step to
    // fold, so trackMessageFailed + rethrow is complete: it balances the
    // started-analytics event and lets DBOS record the workflow failure. A
    // hosted start-throw happens AFTER `dispatchRunAndWaitStep` already
    // claimed and persisted the fence, but that doesn't change this: for the
    // hosted path the fence only marks intent to run a child, and here the
    // child itself never existed, so no chunks were ever published and
    // nothing downstream assumes a fence-less state. In-flight stream errors
    // (once a run has actually started) are handled inside
    // `streamText.onError` / the hosted child's own catch (T1) and don't
    // reach here. Wrapped in its own DBOS step so replay doesn't double-emit.
    const msg = err instanceof Error ? err.message : String(err);
    await DBOS.runStep(() => trackMessageFailedStep(ctx, msg), {
      name: "trackMessageFailed",
    });
    throw err;
  }

  // Consume step: the sole terminal-status writer for BOTH topologies, and —
  // as of T3 — the sole COMPLETION authority too (the gate no longer awaits
  // the hosted child above). `dispatchRunAndWaitStep` above only STARTS the
  // run (hosted: returns a descriptor, started just above; desktop: publishes
  // the work item to the daemon over the tunnel). The actual completion —
  // live-tailing the run's durable JetStream consumer, projecting the final
  // parts/title, and writing terminal status — happens here, for both
  // topologies via one code path.
  //
  // Live-tail timing is now IDENTICAL for hosted and desktop: this step opens
  // `createProjectorChunkStream`'s `DeliverPolicy.All` consumer immediately
  // after dispatch, with no guarantee the producer (hosted child / desktop
  // daemon) has published chunk 1 yet — desktop has ALWAYS worked this way
  // (`dispatchRunAndWaitStep`'s sandbox branch returns as soon as the work
  // item is durably published, well before the remote daemon streams
  // anything back), so this is a pattern already proven in production, not a
  // new race introduced here. See `nats-chunk-source.ts`'s `natsChunkSource`:
  // a pull with nothing yet retained simply awaits the next published message
  // (or the idle timeout, as a backstop) — there is no "stream must already
  // be complete/retained" assumption anywhere in this path for either
  // topology.
  //
  // Recovery-safe: `consumeRunProjection` has an entry guard that returns early
  // on a terminal status (the run already finished).
  const runId = ctx.request.taskId ?? ctx.threadId;
  // Anchors the projected reply right after its own user message (queue
  // ordering) instead of after later-queued turns. `messageId` lives only on
  // the durable `DurableDispatchRunInput`; the legacy `DispatchRunInput` member
  // carries `messages` instead — the same discriminant `isDurableDispatchRunInput`
  // uses. Narrowing on it (rather than casting) keeps the `messageId` read
  // compile-time-linked: a future rename breaks the build here instead of
  // silently reverting to the run-wide-max ordering (which only CI e2e catches).
  const requestMessageId =
    "messages" in ctx.request ? undefined : ctx.request.messageId;
  await DBOS.runStep(
    () =>
      consumeRunProjection({
        runId,
        fenceToken: dispatchResult.runFenceToken,
        messageId: requestMessageId,
      }),
    { name: "consumeRunProjection" },
  );

  return { taskId: ctx.request.taskId ?? ctx.threadId };
}

async function threadGateWorkflowFn(
  ctx: ThreadGateContext,
): Promise<ThreadGateOutcome> {
  return runDispatchSteps(ctx);
}

// ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
// step, or change a step's recorded I/O) requires bumping DBOS_WORKFLOW_VERSION
// — see apps/api/src/dbos/workflow-version.ts.
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
 * Fire-and-forget: returns the workflowID without awaiting workflow completion.
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
