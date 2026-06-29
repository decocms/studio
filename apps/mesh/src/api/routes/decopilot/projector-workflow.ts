import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { SqlThreadMessagePartStorage } from "@/storage/thread-message-parts";
import type { HarnessStreamPersistence } from "./consume-harness-stream";
import type { ProjectChunksResult } from "./project-chunks";
import { projectChunks } from "./project-chunks";
import { projectRun } from "./project-run";
import { createProjectorChunkStream } from "./projector-chunk-stream";
import { createRunPersistence } from "./run-persistence";
import { recordPoison } from "./projector-metrics";
import { readProjectorRunRange } from "./projector-run-log";
import { resolveThreadStatus } from "./status";
import {
  assistantMessageIdGenerator,
  synthesizedErrorMessageId,
} from "./message-ids";
import { foldedToUIMessage } from "./projector-seed";

function continuationAssistantMessageId(seed: {
  role: string;
  id: string;
  parts: Array<{ type?: string; state?: string }>;
}): string | null {
  if (seed.role !== "assistant") return null;
  return seed.parts.some(
    (part) =>
      part.type?.startsWith("tool-") && part.state === "approval-responded",
  )
    ? seed.id
    : null;
}

function projectionMessageIdGenerator(input: {
  runId: string;
  fenceToken: string;
  originalMessages: ReturnType<typeof foldedToUIMessage>[];
}): () => string {
  const fallback = assistantMessageIdGenerator(input.runId, input.fenceToken);
  const continuationId = [...input.originalMessages]
    .reverse()
    .map((message) =>
      continuationAssistantMessageId(
        message as {
          role: string;
          id: string;
          parts: Array<{ type?: string; state?: string }>;
        },
      ),
    )
    .find((id): id is string => id !== null);
  if (!continuationId) return fallback;
  let usedContinuation = false;
  return () => {
    if (!usedContinuation) {
      usedContinuation = true;
      return continuationId;
    }
    return fallback();
  };
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
}

/** Input to a non-terminal incremental checkpoint projection pass. */
export interface ProjectorCheckpointInput {
  runId: string;
  fenceToken: string;
  headSeq: number;
  orgId: string;
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
    kind: "harness" | "transport" | "projection",
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
    kind: "harness" | "projection";
  }): Promise<void>;
  purgeRun(runId: string, fenceToken: string): Promise<void>;
  advanceProjectedSeq(
    runId: string,
    orgId: string,
    fenceToken: string,
    newSeq: number,
  ): Promise<number>;
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
 * Non-terminal persistence for checkpoint passes: writes step parts but
 * intentionally skips the finish anchor and error anchor. The terminal done
 * pass writes the finish anchor, so checkpoint writes are strictly additive.
 * Uses the SAME canonical base as the terminal pass — a checkpoint that inserts
 * a row first must not stamp a wall-clock `created_at` that diverges from the
 * terminal pass and re-orders the message.
 */
function checkpointPersistenceFor(
  runId: string,
  orgId: string,
  messageParts: SqlThreadMessagePartStorage,
): Promise<HarnessStreamPersistence> {
  return createRunPersistence({ messageParts, orgId, runId, terminal: false });
}

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
    chunkStream: await createProjectorChunkStream({
      js,
      runId: input.runId,
      fenceToken: input.fenceToken,
    }),
    persistence: await createRunPersistence({
      messageParts: rt.messageParts,
      orgId,
      runId: input.runId,
      replaceFinal: true,
    }),
    originalMessages,
    errorMessageId: synthesizedErrorMessageId(input.runId, input.fenceToken),
    generateMessageId: projectionMessageIdGenerator({
      runId: input.runId,
      fenceToken: input.fenceToken,
      originalMessages,
    }),
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
    // harness error chunk; otherwise resolveThreadStatus inspects the
    // finish-reason + final parts (requires_action = tool-approval pause).
    //
    // ABSENT finish-reason ⇒ completed. The desktop/relay path (and any stream
    // that ends on a `{done}` marker without an AI-SDK `finish` chunk) carries
    // NO finishReason; `resolveThreadStatus(undefined, …)` returns "failed",
    // which would wrongly fail every clean relay run. The pre-unification
    // projector mapped any non-errored run to `completed` regardless of
    // finishReason, so we preserve that here and only consult resolveThreadStatus
    // when a finishReason is actually present (hosted streams: stop / tool-calls /
    // length / error are all classified by it, including legitimate failures).
    const mapped = outcome?.failed
      ? "failed"
      : outcome?.finishReason == null
        ? "completed"
        : resolveThreadStatus(outcome.finishReason, outcome.finalParts);
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
    }
    // Purge JetStream subject on ALL terminal outcomes (completed + harness-failed
    // + requires_action). The run is terminal — no re-projection is expected — so
    // purging is safe.
    await rt.purgeRun(input.runId, input.fenceToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordPoison(input.runId, orgId);
    const flippedOnError = await rt.markRunFailed(
      input.runId,
      orgId,
      message,
      "projection",
    );
    if (flippedOnError) {
      await rt.recordFailed({
        runId: input.runId,
        orgId,
        distinctId,
        reason: message,
        kind: "projection",
      });
    }
    // Re-throw so DBOS records the workflow failure (poison run — projection
    // itself threw after exhausting retries; NOT a harness-error run).
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

export async function projectCheckpointFromJetStreamStep(
  input: ProjectorCheckpointInput,
  currentThreadTitle: string | null,
): Promise<{ projected: boolean }> {
  const rt = requireRuntime();
  const js = rt.getJetStream();
  if (!js) throw new Error("JetStream unavailable");
  // Full fold from seq 1 to headSeq. fromSeq:0 so reconstructProjectorRunRange
  // starts its loop at s=1 (it iterates fromSeq+1..toSeq).
  const range = await readProjectorRunRange({
    js,
    runId: input.runId,
    fenceToken: input.fenceToken,
    fromSeq: 0,
    toSeq: input.headSeq,
    idleTimeoutMs: 5000,
  });
  if (!range.ok || range.chunks.length === 0) return { projected: false };
  const result = await projectRun({
    runId: input.runId,
    fenceToken: input.fenceToken,
    chunks: range.chunks,
    // Non-terminal persistence: writes step parts but skips the finish anchor.
    persistence: await checkpointPersistenceFor(
      input.runId,
      input.orgId,
      rt.messageParts,
    ),
    onDlq: async (_runId, error) => {
      throw error instanceof Error ? error : new Error(String(error));
    },
    title: {
      threadId: input.runId,
      currentThreadTitle,
      persistTitle: async (_threadId, title) => {
        await rt.persistTitle(input.runId, input.orgId, title);
        await rt.onTitleUpdated({
          runId: input.runId,
          orgId: input.orgId,
          title,
        });
      },
    },
  });
  if (!result.ok) return { projected: false };
  await rt.advanceProjectedSeq(
    input.runId,
    input.orgId,
    input.fenceToken,
    range.lastContiguousSeq,
  );
  return { projected: true };
}
