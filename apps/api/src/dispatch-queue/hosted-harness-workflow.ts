/**
 * Hosted Harness Workflow.
 *
 * The HOSTED (in-process) agent-loop execution, factored out of the
 * thread-gate's `!useLink` branch into a single callable `runHostedHarness`
 * and wrapped in its own DBOS child workflow (`hostedHarnessWorkflow`).
 *
 * unified-control-plane T3: the thread gate's `runDispatchSteps` now STARTS
 * this child on `HOSTED_HARNESS_QUEUE` (partitioned by threadId, concurrency 1
 * — one active hosted run per thread) and does NOT await its result —
 * `startHostedHarness` below returns as soon as the start itself is durably
 * recorded. The parent gate immediately proceeds to its consume step, which
 * live-tails the run's JetStream subject, projects final parts/title, and
 * writes terminal status — providing unified terminal-status writes for both
 * hosted and desktop topologies, with the SAME timing shape: the consume step
 * is opened before the producer (child workflow / desktop daemon) has
 * necessarily published anything yet. (Before T3, the gate `await`ed the
 * child's `getResult()` in full before starting the consume step — a
 * carried-over interim behavior from before the child published its own
 * terminal; see the "Guarantee" section below.)
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
 * Closed (unified-control-plane T2): a mid-stream harness failure with
 * healthy JetStream used to be swallowed inside `dispatch-run.ts`'s pump
 * (`NatsStreamBuffer.pump` caught the `uiStream` error, logged it, and only
 * published the legacy UNFENCED `{done}` sentinel — which the consume step
 * deliberately ignores — so `dispatchRunAndWait` returned as if the run had
 * finished cleanly). `pump()` now returns a promise that REJECTS with the
 * same error after publishing that sentinel; `dispatchRunAndWait` awaits it
 * (after its own tail-wait loop) so the error propagates out of
 * `rt.dispatchRunFn` here, straight into THIS wrapper's existing catch below
 * — no new call site needed, since `runHostedHarness` is a thin wrapper
 * around `dispatchRunFn` with no try/catch of its own. The degraded
 * fallback branch (`dispatchRunAndWait` with no JetStream tail) already
 * propagated correctly before this change; the fix makes the healthy-
 * JetStream branch behave the SAME way instead of a special-cased swallow.
 *
 * The seq the failure-terminal publishes at is also threaded through now:
 * `ingestRun` stamps the highest contiguous published seq onto the thrown
 * error as `.lastAckSeq` (own-enumerable, survives the DBOS step boundary —
 * see `ingest-run.ts`'s `WithLastAckSeq`) before re-throwing; the catch below
 * reads it via `terminalErrorStartSeq` and passes `lastAckSeq + 1` as
 * `buildTerminalErrorChunks`'s `startSeq`, so a mid-stream failure after
 * content chunks 1..K continues the log at K+1 instead of colliding with it.
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
 * This is the foundation T3 builds on: the gate no longer awaits the child at
 * all (`startHostedHarness` below) — the projector's live-tail is now the
 * SOLE terminal authority, for both a clean finish and every caught failure.
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
import type { WithLastAckSeq } from "@/api/routes/decopilot/ingest-run";
import type { StudioContext } from "@/core/studio-context";

export { HOSTED_HARNESS_QUEUE } from "./queue-names";
import { HOSTED_HARNESS_QUEUE } from "./queue-names";
import { acquireHostedRunSlot } from "./hosted-run-concurrency";
import {
  advanceTaskBoardForRun,
  reopenTasksOnThreadRun,
} from "@/tools/task-board/run-reactions";

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
  studioContextFactory: StudioContextFactory;
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
 *
 * Exported (only) for `hosted-harness-workflow.test.ts`, which calls this
 * directly to reconstruct `hostedHarnessWorkflowFn`'s try/catch without the
 * `DBOS.runStep` wrapping — see that test file's comment for why.
 */
export async function runHostedHarness(
  input: HostedHarnessInput,
  ctx?: StudioContext,
): Promise<void> {
  const rt = requireRuntime();
  const { request } = input;

  const studioCtx =
    ctx ??
    (await rt.studioContextFactory(request.organizationId, request.userId));
  if (!studioCtx) {
    // Throw so DBOS records the step (and the workflow) as failed. Swallowing
    // would mark it SUCCESS and break retry / failure tooling.
    throw new Error("user membership lost mid-dispatch");
  }

  // Carry per-run metadata (from a webhook trigger's run_metadata) onto the run
  // context so every downstream MCP tool call forwards it through Studio's
  // run-metadata headers.
  if (request.runMetadata) {
    studioCtx.metadata.runMetadata = request.runMetadata;
  }

  // A Super Agent task run is starting to execute — move its card to In Progress.
  // Fire-and-forget: the transition is best-effort and must not delay the loop.
  void advanceTaskBoardForRun(studioCtx, "in_progress", input.threadId);

  // If the user re-engaged a task that had moved to In Review, pull it back to
  // In Progress. Link-based (`task_board_item_threads`), so it fires for a
  // re-prompt that carries no run metadata — unlike the forward advance above.
  //
  // Skipped when `runMetadata.taskBoardItemId` is set: that means this
  // execution IS the Super Agent's own task run (dispatched by
  // `enqueueSuperAgentForTask`, or DBOS recovering/retrying it after a pod
  // death) — never a human re-prompt, which never carries that key. Firing
  // unconditionally here would regress an already-reviewed card (PR opened,
  // pod died, DBOS re-runs the workflow) back to In Progress every time the
  // run resumes, with no second PR coming to re-advance it.
  if (!request.runMetadata?.taskBoardItemId) {
    void reopenTasksOnThreadRun(studioCtx, input.threadId);
  }

  // No wall-clock cap: a hosted run lives as long as it makes progress. The
  // RunRegistry idle reaper aborts + fails a run that goes RUN_IDLE_TIMEOUT_MS
  // with no progress (see run-registry.ts). The AbortController is retained for
  // explicit cancellation and the reaper's force-fail.
  const abortController = new AbortController();

  // Cap concurrent agent loops per pod (see hosted-run-concurrency.ts). The
  // slot is held only for the loop itself, not the ctx resolution above; excess
  // runs park here until a slot frees.
  const releaseSlot = await acquireHostedRunSlot();
  try {
    await rt.dispatchRunFn(
      { ...request, abortSignal: abortController.signal },
      studioCtx,
      rt.deps,
    );
  } finally {
    releaseSlot();
  }
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
 * chunk in the common case: a failure before any content chunk published —
 * StudioContext resolution, `HostedHarnessRuntime` not wired — so seq 1 is
 * genuinely free). `publishHostedHarnessFailure` below no longer always
 * defaults it: when the caught error carries `ingestRun`'s `.lastAckSeq` (a
 * mid-stream failure AFTER content chunks 1..K were already confirmed —
 * `terminalErrorStartSeq` reads it), it passes `K + 1` so the error chunk
 * continues the run's contiguous log instead of colliding with it.
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
 * Reads `ingestRun`'s `.lastAckSeq` (see `ingest-run.ts`'s `WithLastAckSeq`)
 * off a caught failure and returns the seq the terminal error chunk must
 * publish at to stay contiguous with it — `lastAckSeq + 1`. `undefined` when
 * the caught value isn't an `Error` or carries no seq info (a setup failure
 * before any chunk was ever published), in which case
 * `buildTerminalErrorChunks` falls back to its own `startSeq = 1` default.
 * Pure (no I/O) so it's unit-testable without a DBOS/NATS harness.
 */
export function terminalErrorStartSeq(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const lastAckSeq = (err as Error & WithLastAckSeq).lastAckSeq;
  return typeof lastAckSeq === "number" ? lastAckSeq + 1 : undefined;
}

/**
 * Publish the caught failure's terminal (error chunk + `{done}`) to the run's
 * subject, via the SAME `StreamBuffer` surface `ingestRun` uses on the clean
 * path (`publishRawChunk` + `publishDone`). Returns without throwing when the
 * error-chunk publish itself reports failure (JetStream unavailable) — there
 * is nothing more this function can durably do; the caller logs and moves on
 * (see `hostedHarnessWorkflowFn`'s catch).
 *
 * Exported (only) for `hosted-harness-workflow.test.ts` — see `runHostedHarness`'s
 * doc comment above for why.
 */
export async function publishHostedHarnessFailure(
  input: HostedHarnessInput,
  err: unknown,
): Promise<void> {
  const rt = requireRuntime();
  const { streamBuffer } = rt.deps;
  const { messageId, errorChunk, seq, finalSeq } = buildTerminalErrorChunks(
    input.runId,
    input.fenceToken,
    err,
    terminalErrorStartSeq(err),
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
    // NATS + publishing {done}. NOT retriable: an application-level throw
    // here is a DELIBERATE terminal (T2's pump-swallow fix means mid-stream
    // `ingestRun` failures now propagate instead of being swallowed), so it
    // should flow straight to the catch below, which publishes the
    // fence-scoped error terminal exactly once — no re-run, no splice, no 3×
    // billing. A DBOS-driven retry-on-throw would instead re-execute the
    // ENTIRE agent loop up to 3 more times (real LLM cost, delayed
    // terminal); worse, the fence stays stable across attempts while
    // `buildAgentSandboxUiStream` restarts its seq counter at 0 each
    // attempt, so a later attempt's low seqs can collide with the first
    // attempt's inside JetStream's dedup window (dropped) while the rest
    // land — splicing two possibly-divergent generations into one projected
    // message. Pod-crash recovery (the process dying mid-step, not the step
    // throwing) is a separate concern already covered by the workflow's own
    // `maxRecoveryAttempts` below — that mechanism doesn't need
    // `retriesAllowed` here; the two were conflated by the previous comment.
    await DBOS.runStep(() => runHostedHarness(input), {
      name: "runHostedHarness",
      retriesAllowed: false,
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
    // T3 update: the gate's `runDispatchSteps` no longer awaits this child at
    // all (`startHostedHarness` below returns right after the start is
    // recorded) — so there is no `getResult()` rejection for a gate-level
    // catch to observe in the first place, for EITHER a clean finish or a
    // caught failure. The `chat_message_failed` signal is NOT lost:
    // `runProjectorWorkflowBody`'s `recordFailed` (unified-control-plane T2)
    // is the sole source, firing once the consume step's live tail folds the
    // in-band error chunk this catch publishes below — correctly categorized
    // (`kind: "harness"`) and consistent with the desktop topology's failure
    // analytics.
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
// — see apps/api/src/dbos/workflow-version.ts. Exception (used by the
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
 * Deterministic hosted-child workflow ID, keyed by `(runId, fenceToken)` — a
 * redelivered start (a DBOS replay of the parent gate workflow) collapses
 * onto the SAME child instead of spawning a second agent loop for the same
 * attempt. Exported: this is the single source of truth for the id — both
 * `startHostedHarness` and `cancelHostedHarness` below derive it from here,
 * and unified-control-plane T7 (stop cancels the live child, not just the
 * in-memory run registry) will too, rather than reconstructing the
 * `decopilot-hosted:<runId>:<fenceToken>` string independently.
 */
export function hostedChildWorkflowId(
  runId: string,
  fenceToken: string,
): string {
  return `decopilot-hosted:${runId}:${fenceToken}`;
}

/**
 * Start (do NOT await) a hosted harness run on the partitioned hosted-harness
 * queue. The partition key is the threadId, so per-thread concurrency=1
 * serializes hosted runs on the same thread (mirroring the thread gate). The
 * workflow ID is `hostedChildWorkflowId(runId, fenceToken)`, so a redelivered
 * start collapses onto the existing workflow handle instead of duplicating
 * the run.
 *
 * unified-control-plane T3: this used to be `enqueueHostedHarness`, which
 * additionally `await`ed `handle.getResult()` — the thread-gate workflow
 * blocked on the ENTIRE child agent loop before proceeding to its consume
 * step (a carried-over interim shape from before T1 gave the child its own
 * terminal-publishing guarantee). That coupling is gone: the caller now
 * starts the child and moves straight to `consumeRunProjection`, which
 * live-tails the run's JetStream subject exactly like the desktop topology
 * already does — the child publishes chunks as it runs; the consume step's
 * `DeliverPolicy.All` consumer, opened BEFORE chunk 1 is necessarily
 * published, simply waits for it (see `projector-chunk-stream.ts` /
 * `nats-chunk-source.ts`'s live-tail pull semantics). The child is a fully
 * detached, pure executor per T1's contract: whatever it does (clean finish
 * or a caught failure), it publishes its own fence-scoped terminal to the
 * stream — the projector's live tail is now the ONLY thing the gate's
 * completion depends on, for BOTH topologies.
 *
 * Only the START call is durably recorded here (DBOS forbids
 * `DBOS.startWorkflow` from within a step/transaction, so this must run from
 * workflow body context — same restriction as before). Dropping the
 * `getResult()` wait removes a whole recorded parent-workflow operation from
 * `threadGateWorkflow`'s journal, which is why this change requires the
 * `DBOS_WORKFLOW_VERSION` bump (see workflow-version.ts) — an in-flight v3
 * gate replayed against v4 code would replay dispatch, hit the missing
 * recorded `getResult`, and diverge.
 */
export async function startHostedHarness(
  input: HostedHarnessInput,
): Promise<{ workflowID: string }> {
  const handle = await DBOS.startWorkflow(hostedHarnessWorkflow, {
    workflowID: hostedChildWorkflowId(input.runId, input.fenceToken),
    queueName: HOSTED_HARNESS_QUEUE,
    enqueueOptions: { queuePartitionKey: input.threadId },
  })(input);
  return { workflowID: handle.workflowID };
}

/**
 * Best-effort cancel of a hosted-harness child workflow. The in-memory
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
  await DBOS.cancelWorkflow(hostedChildWorkflowId(runId, fenceToken));
}
