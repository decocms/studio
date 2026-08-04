import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { SqlThreadMessagePartStorage } from "@/storage/thread-message-parts";
import type { ProjectChunksResult } from "./project-chunks";
import { projectChunks } from "./project-chunks";
import { createProjectorChunkStream } from "./projector-chunk-stream";
import { StreamGapError, StreamIdleTimeoutError } from "./nats-chunk-source";
import { createRunPersistence } from "./run-persistence";
import { recordPoison } from "./projector-metrics";
import { ProgressBumpThrottle, tapProgressStream } from "./progress-bump";
import { resolveCleanRunStatus } from "./status";
import { synthesizedErrorMessageId } from "./message-ids";
import { foldedToUIMessage } from "./projector-seed";

/**
 * Reason string persisted to `failure_reason` when the run's subject went
 * silent for the idle window — the wording distinguishes a liveness breach
 * (nothing published at all) from an actual projection error in the UI and
 * analytics (`kind: "liveness"` vs `"projection"`). unified-control-plane T4.
 */
export function livenessFailureReason(idleTimeoutMs: number): string {
  const minutes = Math.round(idleTimeoutMs / 60_000);
  return `liveness: no stream events for ${minutes}m`;
}

export function shouldSkipProjection(input: {
  status: string;
  runFenceToken: string | null;
  fenceToken: string;
}): boolean {
  // Terminal status alone is not stale: hosted onFinish can mark the run
  // completed/failed before the projector consumes the same-fence `{done}`.
  // A different live fence still means this projector event belongs to an
  // older run attempt and must not materialize over the newer attempt.
  return (
    input.runFenceToken !== null && input.runFenceToken !== input.fenceToken
  );
}

export interface ProjectorWorkflowInput {
  runId: string;
  fenceToken: string;
  finalSeq?: number;
  /** The turn's request message id — anchors the projected reply's created_at
   *  right after its own user message (queue ordering). */
  messageId?: string;
  /** Idle window enforced on the live subject tail (unified-control-plane T4).
   *  Threaded from `ConsumeRunProjectionOptions.idleTimeoutMs` (defaulted
   *  there to `RUN_IDLE_TIMEOUT_MS`) down to `createProjectorChunkStream`.
   *  Omitted → no idle enforcement (matches the pre-T4 unbounded behavior). */
  idleTimeoutMs?: number;
}

export interface ProjectorRunRow {
  orgId: string;
  createdBy: string | null;
  version: number;
  status: string;
  runFenceToken: string | null;
  /** Thread's current title — gates auto-title persistence (never overwrite a
   *  user-renamed thread; see project-chunks.ts ProjectTitleOptions). */
  title: string | null;
}

export interface ProjectorWorkflowRuntime {
  getJetStream(): JetStreamClient | null;
  getJetStreamManager(): Promise<JetStreamManager | null>;
  resolveRun(runId: string): Promise<ProjectorRunRow | null>;
  messageParts: SqlThreadMessagePartStorage;
  completeRunIfNotCompleted(runId: string, orgId: string): Promise<unknown>;
  /** Flip an in_progress run to requires_action (tool-approval pause). Returns
   *  the flipped row or falsy when the row was not in_progress. */
  markRunRequiresAction(runId: string, orgId: string): Promise<unknown>;
  markRunFailed(
    runId: string,
    orgId: string,
    reason: string,
    kind: "harness" | "transport" | "projection" | "liveness",
  ): Promise<unknown>;
  persistTitle(runId: string, orgId: string, title: string): Promise<unknown>;
  onTitleUpdated(input: {
    runId: string;
    orgId: string;
    title: string;
  }): Promise<void>;
  bumpProgress(input: { runId: string; orgId: string }): Promise<void>;
  recordCompleted(input: {
    runId: string;
    orgId: string;
    distinctId: string;
    usage: ProjectChunksResult["usage"];
  }): Promise<void>;
  recordFailed(input: {
    runId: string;
    orgId: string;
    distinctId: string;
    reason: string;
    kind: "harness" | "projection" | "liveness";
  }): Promise<void>;
  purgeRun(runId: string, fenceToken: string): Promise<void>;
  /**
   * Delete the synthesized error message a PRIOR interrupted projection
   * attempt persisted for this `(runId, fenceToken)` (deterministic id — see
   * `synthesizedErrorMessageId`). Called only on a SUCCESSFUL terminal
   * (completed / requires_action), where a lingering "Error: …" bubble from a
   * retried attempt is stale by definition. On a failed terminal the error
   * part IS the run's content and must stay.
   */
  clearSynthesizedError(runId: string, fenceToken: string): Promise<void>;
}

let runtime: ProjectorWorkflowRuntime | null = null;

export function setProjectorWorkflowRuntime(
  rt: ProjectorWorkflowRuntime,
): void {
  runtime = rt;
}

function requireRuntime(): ProjectorWorkflowRuntime {
  if (!runtime) {
    throw new Error(
      "[projector-workflow] runtime not initialized — setProjectorWorkflowRuntime() must run before workflows fire",
    );
  }
  return runtime;
}

export function getProjectorWorkflowRuntime(): ProjectorWorkflowRuntime {
  return requireRuntime();
}

/**
 * Process-wide progress-bump throttle for the projector's live chunk
 * consumption (Task 9, A1/A2) — the SOLE liveness heartbeat for both
 * topologies (unified-control-plane). Desktop chunks go daemon → NATS
 * directly (no studio HTTP hop), so this tap on the JetStream-sourced
 * chunkStream is the only place a desktop run's progress gets recorded.
 * Hosted runs are live-tailed the same way post-unification (dispatch-run.ts
 * no longer has its own tap — its wrapped stream never enqueued a chunk, so
 * it never fired; removed). Without this tap the reaper's
 * `RUN_IDLE_TIMEOUT_MS` (run-registry.ts) force-fails any run running longer
 * than ~10 minutes. Module scope (not per-call) so the per-task last-bump
 * map survives across the multiple `projectFromJetStreamStep` invocations a
 * thread's runs may see.
 */
const progressThrottle = new ProgressBumpThrottle();

export async function projectFromJetStreamStep(
  input: ProjectorWorkflowInput,
  orgId: string,
  currentThreadTitle: string | null,
) {
  const rt = requireRuntime();
  const js = rt.getJetStream();
  if (!js) throw new Error("JetStream unavailable");
  const originalMessages = (
    await rt.messageParts.loadWindow(input.runId, { limit: 500 })
  ).messages.map(foldedToUIMessage);
  const result = await projectChunks({
    // BOTH liveness enforcement points feed from this one stream: the tap
    // bumps `last_progress_at` (DB reaper backstop) on every subject event,
    // and the source's idleTimeoutMs (typed StreamIdleTimeoutError) is the
    // in-process terminal — so executor heartbeats (data-liveness chunks)
    // reset both automatically.
    chunkStream: tapProgressStream(
      await createProjectorChunkStream({
        js,
        runId: input.runId,
        fenceToken: input.fenceToken,
        idleTimeoutMs: input.idleTimeoutMs,
      }),
      input.runId,
      progressThrottle,
      () => {
        // Fire-and-forget: never awaited in the chunk path (a slow DB write
        // must not backpressure projection) and never allowed to fail the
        // stream (a missed bump is a missed heartbeat, not a projection
        // error — the reaper simply relies on an older timestamp).
        void rt.bumpProgress({ runId: input.runId, orgId }).catch(() => {});
      },
    ),
    persistence: await createRunPersistence({
      messageParts: rt.messageParts,
      orgId,
      runId: input.runId,
      requestMessageId: input.messageId,
      replaceFinal: true,
    }),
    originalMessages,
    errorMessageId: synthesizedErrorMessageId(input.runId, input.fenceToken),
    title: {
      threadId: input.runId,
      // The thread's REAL current title gates the auto-title persist — a
      // user-renamed thread (non-default title) is never overwritten.
      currentThreadTitle,
      persistTitle: async (_threadId, title) => {
        await rt.persistTitle(input.runId, orgId, title);
        await rt.onTitleUpdated({ runId: input.runId, orgId, title });
      },
    },
  });
  return {
    chunkCount: 0,
    attempts: 1,
    outcome: result,
  };
}

/**
 * True when the run already reached a terminal state for THIS fence — i.e. a
 * prior attempt of the same fence finished it. A silent or gapped subject on a
 * settled run is benign (the subject was legitimately purged after the run
 * ended, not truncated mid-flight), so the caller returns clean instead of
 * re-failing an already-terminal run.
 */
async function runSettledForFence(
  rt: ProjectorWorkflowRuntime,
  runId: string,
  fenceToken: string,
): Promise<boolean> {
  const row = await rt.resolveRun(runId).catch(() => null);
  return (
    row !== null &&
    row.runFenceToken === fenceToken &&
    ["completed", "failed", "requires_action"].includes(row.status)
  );
}

/**
 * Core workflow logic extracted for testability. Accepts an explicit runtime
 * and a `projectFn` (production: `projectFromJetStreamStep`; tests: a stub)
 * so the branching logic can be exercised without DBOS or JetStream.
 *
 * Called by the consume step (consume-run-projection.ts) which wraps the
 * entire workflow body in `DBOS.runStep`. This function calls `rt.*` methods
 * directly — safe for tests, correct for production because the DBOS wrapper
 * is applied around the whole function body.
 */
export async function runProjectorWorkflowBody(
  input: ProjectorWorkflowInput,
  rt: ProjectorWorkflowRuntime,
  projectFn: (
    input: ProjectorWorkflowInput,
    orgId: string,
    currentThreadTitle: string | null,
  ) => Promise<{
    chunkCount: number;
    attempts: number;
    outcome?: ProjectChunksResult;
  }>,
): Promise<void> {
  const resolved = await resolveRunStepWithRuntime(input, rt);
  if ("skip" in resolved) return;
  const orgId = resolved.row.orgId;
  const distinctId = resolved.row.createdBy ?? input.runId;
  const currentThreadTitle = resolved.row.title;
  try {
    const { outcome } = await projectFn(input, orgId, currentThreadTitle);
    // Map the harness finish-reason → terminal status. `failed` = in-band
    // harness error chunk; otherwise `resolveCleanRunStatus` inspects the
    // finish-reason + final parts (requires_action = tool-approval pause,
    // absent finish-reason = completed). Shared with the live reactor's finish
    // hook on purpose — see its doc.
    const mapped = outcome?.failed
      ? "failed"
      : resolveCleanRunStatus(outcome?.finishReason, outcome?.finalParts);
    if (mapped === "failed") {
      // The run ended with an in-band harness error chunk: mark it failed
      // (not completed). This is a SUCCESSFUL projection of a FAILED run —
      // do NOT re-throw; the workflow itself succeeded.
      const reason = outcome?.finishReason
        ? `harness reported an error: ${outcome.finishReason}`
        : "harness reported an error";
      recordPoison(input.runId, orgId);
      const flipped = await rt.markRunFailed(
        input.runId,
        orgId,
        reason,
        "harness",
      );
      if (flipped) {
        await rt.recordFailed({
          runId: input.runId,
          orgId,
          distinctId,
          reason,
          kind: "harness",
        });
      }
    } else if (mapped === "requires_action") {
      // Tool-approval pause: flip to requires_action so the client can
      // re-engage. No completion analytics for a pause.
      await rt.markRunRequiresAction(input.runId, orgId);
      await rt.clearSynthesizedError(input.runId, input.fenceToken);
    } else {
      // completed
      const flipped = await rt.completeRunIfNotCompleted(input.runId, orgId);
      if (flipped) {
        await rt.recordCompleted({
          runId: input.runId,
          orgId,
          distinctId,
          usage: outcome?.usage ?? {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          },
        });
      }
      // A PRIOR attempt of this same fence may have thrown mid-fold and
      // persisted the synthesized error message before DBOS retried into
      // this successful pass — that stale "Error: …" bubble would otherwise
      // sit above the successful reply forever (redelivery repro,
      // projector-redelivery.test.ts).
      await rt.clearSynthesizedError(input.runId, input.fenceToken);
    }
    // Purge JetStream subject on ALL terminal outcomes (completed + harness-failed
    // + requires_action). The run is terminal — no re-projection is expected — so
    // purging is safe.
    await rt.purgeRun(input.runId, input.fenceToken);
  } catch (error) {
    // A gapped subject (StreamGapError — retention discarded chunks under a
    // late redelivery, or a purge raced it) can NEVER be reconstructed by
    // retrying: the data is gone from the stream. Mark the run failed with an
    // honest reason and let the step SUCCEED — a successful projection of a
    // failed run, the same shape as the in-band harness-error branch above.
    // Rethrowing (the pre-fix behavior) burned DBOS step retries/recovery on
    // a hopeless replay and recorded the misleading generic reason
    // "missing seq N" (stg incident 2026-07-14 follow-up; repro in
    // projector-redelivery.test.ts).
    if (error instanceof StreamGapError) {
      // A purge racing an in-flight or redelivered projection on the shared
      // per-thread subject (purge is subject-scoped, one subject per thread
      // across all turns) can behead chunks THIS attempt still needs — surfacing
      // a hole even though nothing was truly lost. When the run already reached a
      // terminal for this fence, the gap is BENIGN: the subject was legitimately
      // purged after the run finished. Drop the spurious "missing seq" bubble the
      // fold just persisted (deterministic id, same as the settled-completion
      // path) and return clean instead of stamping a failure over a settled run.
      if (await runSettledForFence(rt, input.runId, input.fenceToken)) {
        await rt.clearSynthesizedError(input.runId, input.fenceToken);
        await rt.purgeRun(input.runId, input.fenceToken);
        return;
      }
      const reason = `stream truncated before projection could replay it: ${error.message}`;
      recordPoison(input.runId, orgId);
      const flipped = await rt.markRunFailed(
        input.runId,
        orgId,
        reason,
        "projection",
      );
      if (flipped) {
        await rt.recordFailed({
          runId: input.runId,
          orgId,
          distinctId,
          reason,
          kind: "projection",
        });
      }
      // Terminal — no re-projection is expected (and the subject is already
      // partially discarded), so purging matches the try-path's policy.
      await rt.purgeRun(input.runId, input.fenceToken);
      return;
    }
    // A silent subject (StreamIdleTimeoutError, thrown by natsChunkSource —
    // see nats-chunk-source.ts) is a LIVENESS breach, not a projection bug:
    // the executor died (or never started) before publishing anything, so
    // there was nothing to project. Distinguishing it here (unified-control-
    // plane T4) gives the thread a legible `failure_reason` instead of the
    // generic (and misleading) "projection" catch-all every other thrown
    // error still gets.
    //
    // One idle case is NOT a breach: the run already reached a terminal for
    // THIS fence (a prior attempt crashed between its terminal write and the
    // DBOS step journal, or `purgeRun` raced the redelivery) — the subject is
    // silent because the run is finished, not because the producer died.
    // Return cleanly instead of re-failing a settled run and rethrowing into
    // retries that would idle-wait the full window again each time.
    const isLivenessBreach = error instanceof StreamIdleTimeoutError;
    if (
      isLivenessBreach &&
      (await runSettledForFence(rt, input.runId, input.fenceToken))
    ) {
      await rt.purgeRun(input.runId, input.fenceToken);
      return;
    }
    const reason = isLivenessBreach
      ? livenessFailureReason((error as StreamIdleTimeoutError).idleTimeoutMs)
      : error instanceof Error
        ? error.message
        : String(error);
    const kind = isLivenessBreach ? "liveness" : "projection";
    recordPoison(input.runId, orgId);
    const flippedOnError = await rt.markRunFailed(
      input.runId,
      orgId,
      reason,
      kind,
    );
    if (flippedOnError) {
      await rt.recordFailed({
        runId: input.runId,
        orgId,
        distinctId,
        reason,
        kind,
      });
    }
    // On a liveness breach the fold's error part came from OUR OWN stream
    // error, so the thread rendered the assistant saying "Error: producer
    // produced no output before timeout" — a projector implementation detail,
    // not a reply. The `failed` terminal (+ the liveness `failure_reason`) is
    // the user-visible signal, so drop the bubble. Scoped to the synthesized
    // message id: whatever step parts the producer did publish before going
    // silent live under the harness message id and are untouched.
    if (isLivenessBreach) {
      await rt.clearSynthesizedError(input.runId, input.fenceToken);
    }
    // Re-throw so DBOS records the workflow failure (poison run — projection
    // itself threw after exhausting retries; NOT a harness-error run). This
    // holds for the liveness case too: the consume step genuinely failed to
    // produce a projection, so DBOS's retry/redelivery bookkeeping still
    // applies — the ONLY thing T4 changes is the recorded reason/kind, not
    // the step's success/failure verdict.
    // Do NOT purge here: the DBOS workflow has failed so a potential
    // re-delivery or operator inspection of the JetStream subject is still
    // meaningful.
    throw error;
  }
}

async function resolveRunStepWithRuntime(
  input: ProjectorWorkflowInput,
  rt: ProjectorWorkflowRuntime,
) {
  const row = await rt.resolveRun(input.runId);
  if (!row) return { skip: "missing" as const };
  if (
    shouldSkipProjection({
      status: row.status,
      runFenceToken: row.runFenceToken,
      fenceToken: input.fenceToken,
    })
  ) {
    return { skip: "stale" as const, row };
  }
  if (row.version !== 2) return { skip: "legacy-v1" as const, row };
  return { row };
}
