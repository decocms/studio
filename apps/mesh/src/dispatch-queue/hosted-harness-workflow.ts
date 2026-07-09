/**
 * Hosted Harness Workflow.
 *
 * The HOSTED (in-process) agent-loop execution, factored out of the
 * thread-gate's `!useLink` branch into a single callable `runHostedHarness`
 * and wrapped in its own DBOS child workflow (`hostedHarnessWorkflow`).
 *
 * Task 7b wiring: the thread gate's `dispatchRunAndWaitStep` now enqueues this
 * child fire-and-forget onto `HOSTED_HARNESS_QUEUE` (partitioned by threadId,
 * concurrency 1 — one active hosted run per thread) instead of running inline.
 * The parent gate immediately proceeds to its consume step, which drains the
 * run's JetStream consumer, projects final parts/title, and writes terminal
 * status — providing unified terminal-status writes for both hosted and desktop
 * topologies.
 *
 * The hosted execution body is exactly what `dispatchRunAndWait` does: claim
 * the run, drive the agent loop via the harness kernel, stream chunks to
 * JetStream through `ingestRun`, and publish the `{done}` sentinel. No DB
 * terminal-status writes happen here — the durable projector / consume step
 * owns terminal status.
 *
 * ## Guarantee: the child publishes its own fence-scoped terminal for every
 * CAUGHT failure (and `{done}` on success)
 *
 * NOT yet covered: a mid-stream harness failure with healthy JetStream is
 * swallowed inside `dispatch-run.ts`'s pump (unfenced `{done}` only, which
 * the consume step ignores) and never reaches this wrapper — closing that
 * class is the unified-control-plane T2 (hosted ingest becomes a thin
 * publisher whose throws propagate). Until then that class terminates via
 * the liveness reaper with a generic reason.
 *
 * A started hosted child either publishes `{done}` after a clean completion
 * (already true via `ingestRun`'s `publishDone` inside `runHostedHarness`), or
 * — on ANY caught failure — a synthesized in-band `{type:"error"}` chunk
 * followed by `{done}` (see `buildTerminalErrorChunks` /
 * `hostedHarnessWorkflowFn`'s catch below). The durable projector treats an
 * in-band error chunk with no following `{type:"finish"}` as the run's failed
 * verdict (`project-chunks.ts`'s `failed` flag), so the thread reaches a
 * terminal status purely from what's on the stream — the workflow's own DBOS
 * status is deliberately NOT the signal (see the catch's comment for why).
 * This is the foundation the gate (Task 3) builds on to stop awaiting the
 * child and treat the projector's live-tail as the sole terminal authority.
 *
 * Runtime dependencies (the dispatch fn, the studio-context factory, the
 * dispatch deps) are looked up via a module-level registry, mirroring
 * `thread-gate-workflow.ts`. App boot wires them via `setHostedHarnessRuntime`
 * BEFORE `DBOS.launch()`. The workflow is registered at import time so the
 * recovery executor can replay it after a crash.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { UIMessageChunk } from "ai";
import type {
  DispatchRunDeps,
  DispatchRunRuntimeInput,
  DispatchRunInput,
  DurableDispatchRunInput,
} from "@/api/routes/decopilot/dispatch-run";
import { synthesizedErrorMessageId } from "@/api/routes/decopilot/message-ids";
import type { StudioContext } from "@/core/studio-context";

export { HOSTED_HARNESS_QUEUE } from "./queue-names";
import { HOSTED_HARNESS_QUEUE } from "./queue-names";

// These types mirror the thread-gate runtime's shapes. They're defined locally
// (rather than imported from `./thread-gate-workflow`) to avoid an import cycle
// between the two workflow modules — the gate imports `runHostedHarness` from
// here, so this module must not import back.

/**
 * Serializable subset of `DispatchRunInput`. The abort signal is the only
 * non-serializable field; the run constructs its own from an optional timeout.
 */
export type SerializableDispatchRunInput =
  | Omit<DispatchRunInput, "abortSignal">
  | Omit<DurableDispatchRunInput, "abortSignal">;

export type DispatchRunAndWaitFn = (
  input: DispatchRunRuntimeInput,
  ctx: StudioContext,
  deps: DispatchRunDeps,
) => Promise<{ taskId: string }>;

export type StudioContextFactory = (
  orgId: string,
  userId: string,
) => Promise<StudioContext | null>;

/**
 * Per-thread concurrent hosted-run cap (partition cap on the hosted-harness
 * queue). One active hosted run per threadId, mirroring the thread gate.
 */
export const HOSTED_HARNESS_PARTITION_CONCURRENCY = 1;

/**
 * Serializable input to a hosted harness run. Everything needed to (re)run the
 * in-process agent loop from a DBOS-replayed workflow journal — the
 * non-serializable `abortSignal` is excluded (the run constructs its own from
 * an optional timeout). `runId`/`fenceToken`/`threadId` key the workflow ID and
 * its queue partition.
 */
export interface HostedHarnessInput {
  /** Run id (aliases threadId today). Part of the workflow ID for dedup. */
  runId: string;
  /** Per-attempt fence token. Part of the workflow ID for dedup. */
  fenceToken: string;
  /** Stable thread identifier — the queue partition key. */
  threadId: string;
  /** Dispatch input minus the non-serializable abort signal. */
  request: SerializableDispatchRunInput;
}

export interface HostedHarnessRuntime {
  /** The hosted in-process agent loop — `dispatchRunAndWait` in production. */
  dispatchRunFn: DispatchRunAndWaitFn;
  /** Resolves a StudioContext for an (org, user) pair (membership-checked). */
  meshContextFactory: StudioContextFactory;
  deps: Pick<
    DispatchRunDeps,
    "runRegistry" | "cancelBroadcast" | "streamBuffer" | "sseHub"
  >;
}

let runtime: HostedHarnessRuntime | null = null;

export function setHostedHarnessRuntime(rt: HostedHarnessRuntime): void {
  runtime = rt;
}

function requireRuntime(): HostedHarnessRuntime {
  if (!runtime) {
    throw new Error(
      "[hostedHarness] runtime not initialized — setHostedHarnessRuntime() must run before workflows fire",
    );
  }
  return runtime;
}

/**
 * Run the hosted (in-process) agent loop to completion.
 *
 * Resolves a StudioContext (unless one is supplied), installs the opt-in abort
 * timer, and drives `dispatchRunFn` (the agent loop). `dispatchRunAndWait`
 * guarantees that on a setup error the run is already force-finished to
 * "failed" in the registry before throwing, so propagating the error keeps
 * application state consistent while letting DBOS record the failure.
 *
 * The `ctx` parameter lets the inline thread-gate caller pass its
 * already-resolved StudioContext (avoiding a second membership round-trip); the
 * child workflow omits it and the run resolves its own ctx via the factory.
 *
 * No DB terminal-status writes here — the consume / projector step owns
 * terminal status. The NATS streaming + `{done}` publish happen inside
 * `dispatchRunAndWait` (via `ingestRun` / the stream buffer pump).
 */
async function runHostedHarness(
  input: HostedHarnessInput,
  ctx?: StudioContext,
): Promise<void> {
  const rt = requireRuntime();
  const { request } = input;

  const meshCtx =
    ctx ??
    (await rt.meshContextFactory(request.organizationId, request.userId));
  if (!meshCtx) {
    // Throw so DBOS records the step (and the workflow) as failed. Swallowing
    // would mark it SUCCESS and break retry / failure tooling.
    throw new Error("user membership lost mid-dispatch");
  }

  // Carry per-run metadata (from a webhook trigger's run_metadata) onto the run
  // context so every downstream MCP tool call forwards it as x-mesh-run-metadata.
  if (request.runMetadata) {
    meshCtx.metadata.runMetadata = request.runMetadata;
  }

  // No wall-clock cap: a hosted run lives as long as it makes progress. The
  // RunRegistry idle reaper aborts + fails a run that goes RUN_IDLE_TIMEOUT_MS
  // with no progress (see run-registry.ts). The AbortController is retained for
  // explicit cancellation and the reaper's force-fail.
  const abortController = new AbortController();

  await rt.dispatchRunFn(
    { ...request, abortSignal: abortController.signal },
    meshCtx,
    rt.deps,
  );
}

/**
 * Deterministic error-terminal payload for a caught hosted-harness failure.
 * Pure (no I/O) so it's unit-testable without a DBOS/NATS harness.
 *
 * Returns an in-band `{type:"error"}` `UIMessageChunk` — NOT a thrown
 * exception — because the harness kernel's AI-SDK reader treats an in-band
 * error chunk with no following `{type:"finish"}` as the run's terminal
 * failure verdict (see `project-chunks.ts`'s `failed` flag); no `start`/
 * `finish` wrapper is needed. `errorText` is the REAL `err.message` — the
 * wire/client may mask it later for display, but the subject must carry the
 * truth (a masked subject is what turned a recent prod incident into an
 * archaeology dig — every layer had already thrown away the real message).
 *
 * `startSeq` (default 1) is the seq to publish the error chunk at; the paired
 * `{done}` sentinel's `finalSeq` is the same value (this is the run's only
 * chunk in the caller's common case). Defaulting to 1 is deliberate: every
 * failure this helper is invoked for today (StudioContext resolution,
 * `HostedHarnessRuntime` not wired) throws BEFORE `dispatchRunFn` publishes
 * any content chunk, so seq 1 is genuinely free. The one known gap:
 * `dispatchRunAndWait` can publish real content chunks (via `ingestRun`'s
 * internal `ackSeq` counter) before rejecting — in the degraded
 * no-JetStream-tail fallback branch, and also in the healthy branch when
 * the tail-subscription read itself errors mid-run (NATS drop) after
 * seqs 1..K published — and that counter isn't threaded back through
 * `DispatchRunAndWaitFn`'s `{ taskId }` result — so in that rare case a caller
 * MUST pass the true next seq once that plumbing exists; until then the
 * projector's contiguity check (`assertContiguousAndDedup`) surfaces a
 * "missing seq" error for that run instead of a clean `failed` status, which
 * is still strictly better than today's silent unfenced-done stall.
 *
 * The message id is `synthesizedErrorMessageId(runId, fenceToken)` — the SAME
 * pure function the durable projector calls when ITS OWN re-projection of
 * this chunk synthesizes the persisted error row (see
 * `projector-workflow.ts`). The AI-SDK `error` chunk shape carries no id
 * field, so it isn't stamped onto the wire chunk itself; returning it here
 * documents (and lets tests assert) the convergence — whichever writer needs
 * a stable row id for this failure computes the exact same one, so retries
 * collapse via `ON CONFLICT DO NOTHING` instead of duplicating.
 */
export interface HostedHarnessTerminalError {
  messageId: string;
  errorChunk: UIMessageChunk;
  seq: number;
  finalSeq: number;
}

export function buildTerminalErrorChunks(
  runId: string,
  fenceToken: string,
  err: unknown,
  startSeq = 1,
): HostedHarnessTerminalError {
  const errorText = err instanceof Error ? err.message : String(err);
  return {
    messageId: synthesizedErrorMessageId(runId, fenceToken),
    errorChunk: { type: "error", errorText },
    seq: startSeq,
    finalSeq: startSeq,
  };
}

/**
 * Publish the caught failure's terminal (error chunk + `{done}`) to the run's
 * subject, via the SAME `StreamBuffer` surface `ingestRun` uses on the clean
 * path (`publishRawChunk` + `publishDone`). Returns without throwing when the
 * error-chunk publish itself reports failure (JetStream unavailable) — there
 * is nothing more this function can durably do; the caller logs and moves on
 * (see `hostedHarnessWorkflowFn`'s catch).
 */
async function publishHostedHarnessFailure(
  input: HostedHarnessInput,
  err: unknown,
): Promise<void> {
  const rt = requireRuntime();
  const { streamBuffer } = rt.deps;
  const { messageId, errorChunk, seq, finalSeq } = buildTerminalErrorChunks(
    input.runId,
    input.fenceToken,
    err,
  );
  if (!streamBuffer) {
    // No JetStream buffer wired (test mode / NATS down) — mirrors
    // `dispatchRunAndWait`'s own degraded fallback: nothing durable to do.
    console.error(
      `[hostedHarness] no streamBuffer configured; dropping terminal error for run=${input.runId} fence=${input.fenceToken} messageId=${messageId}`,
    );
    return;
  }
  const published = await streamBuffer.publishRawChunk(
    input.runId,
    errorChunk,
    {
      fenceToken: input.fenceToken,
      seq,
    },
  );
  if (!published) {
    console.error(
      `[hostedHarness] failed to publish terminal error chunk for run=${input.runId} fence=${input.fenceToken} messageId=${messageId}`,
    );
    return;
  }
  await streamBuffer.publishDone(input.runId, input.fenceToken, finalSeq);
}

async function hostedHarnessWorkflowFn(
  input: HostedHarnessInput,
): Promise<void> {
  try {
    // ONE step (happy path): run the agent loop to completion, streaming to
    // NATS + publishing {done}. Retriable — hosted/in-process runs have no
    // external daemon to race, so DBOS can recover them (the queue's
    // concurrency=1 per threadId still guarantees a single in-flight hosted
    // run per thread).
    await DBOS.runStep(() => runHostedHarness(input), {
      name: "runHostedHarness",
      retriesAllowed: true,
    });
  } catch (err) {
    // Second step, only reached on failure: publish the fence-scoped error +
    // {done} terminal, then RETURN NORMALLY — do not rethrow. The child's
    // DBOS status becoming SUCCESS here is intentional: run OUTCOME lives on
    // the thread via the projector's fold of what's on the stream (an in-band
    // error chunk with no following finish → failed), not on this workflow's
    // DBOS status. Appending a step only on this (previously-terminal, never
    // replayed) failure branch doesn't retroactively change any ALREADY
    // recorded step for an in-flight workflow being recovered, so this is
    // recovery-compatible — no DBOS_WORKFLOW_VERSION bump needed (only a
    // workflow-source-guard snapshot re-baseline).
    //
    // Interim note (until Task 3 lands): the gate's `runDispatchSteps` still
    // awaits this child via `enqueueHostedHarness`'s `getResult()`. Before
    // this change, a caught failure rejected the child workflow, so the
    // gate's `trackMessageFailed` catch (thread-gate-workflow.ts ~544-555)
    // fired for it. After this change, `getResult()` resolves instead, so
    // that catch no longer fires for hosted-child failures — `chat_message_
    // failed` posthog analytics undercounts them until T3 rewires the gate to
    // read status from the projector fold instead of the child's outcome.
    await DBOS.runStep(() => publishHostedHarnessFailure(input, err), {
      name: "publishHostedHarnessFailure",
      retriesAllowed: true,
    }).catch((publishErr) => {
      // Best-effort: if we can't even publish the failure terminal (e.g.
      // JetStream itself is down), there's nothing more this workflow can
      // durably do — swallow so it still returns normally per the guarantee
      // above. A thread stuck with NO fence-scoped terminal at all needs a
      // different safety net (idle reaper / manual unbrick), out of scope
      // here.
      console.error(
        `[hostedHarness] could not publish terminal error for run=${input.runId} fence=${input.fenceToken}`,
        publishErr,
      );
    });
  }
}

// ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
// step, or change a step's recorded I/O) requires bumping DBOS_WORKFLOW_VERSION
// — see apps/mesh/src/dbos/workflow-version.ts. Exception (used by the
// failure-terminal step below): appending a step on a branch where the OLD
// code recorded nothing further (a previously-rethrowing failure path) is
// recovery-compatible — old in-flight instances never reach the new step's
// function id, so no replay mismatch. Re-baseline the source-guard snapshot
// only.
const hostedHarnessWorkflow = DBOS.registerWorkflow(hostedHarnessWorkflowFn, {
  name: "hostedHarnessWorkflow",
  // A hosted run now spans a whole agent loop with no fixed cap, so a
  // multi-hour run can survive many rolling deploys; each pod recycle the run
  // lives through costs one recovery attempt. 1000 gives generous headroom.
  maxRecoveryAttempts: 1000,
});

/**
 * Enqueue a hosted harness run on the partitioned hosted-harness queue. The
 * partition key is the threadId, so per-thread concurrency=1 serializes hosted
 * runs on the same thread (mirroring the thread gate). The workflow ID is keyed
 * by `(runId, fenceToken)` so a redelivered enqueue collapses onto the existing
 * workflow handle instead of duplicating the run.
 *
 * Returns after the hosted harness child workflow completes. The thread-gate
 * workflow calls this before its projector step; projecting before the hosted
 * child has produced any retained JetStream messages can race an empty consumer
 * and leave the thread stuck in_progress.
 */
function hostedHarnessWorkflowId(runId: string, fenceToken: string): string {
  return `decopilot-hosted:${runId}:${fenceToken}`;
}

export async function enqueueHostedHarness(
  input: HostedHarnessInput,
): Promise<{ workflowID: string }> {
  const handle = await DBOS.startWorkflow(hostedHarnessWorkflow, {
    workflowID: hostedHarnessWorkflowId(input.runId, input.fenceToken),
    queueName: HOSTED_HARNESS_QUEUE,
    enqueueOptions: { queuePartitionKey: input.threadId },
  })(input);
  await handle.getResult();
  return { workflowID: handle.workflowID };
}

/**
 * Best-effort cancel of a hosted-harness child workflow (Task 7b). The in-memory
 * cancel path (`cancelBroadcast` + run-registry CANCEL → AbortController) already
 * stops the running harness loop; this additionally tells DBOS to stop
 * recovering / retrying the child workflow on pod recycles. Cancelling an
 * already-finished or unknown workflow is a no-op (caller wraps in try/catch as a
 * safety net regardless).
 */
export async function cancelHostedHarness(
  runId: string,
  fenceToken: string,
): Promise<void> {
  await DBOS.cancelWorkflow(hostedHarnessWorkflowId(runId, fenceToken));
}
