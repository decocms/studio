import { DBOS } from "@dbos-inc/dbos-sdk";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { SqlThreadMessagePartStorage } from "@/storage/thread-message-parts";
import type { HarnessStreamPersistence } from "./consume-harness-stream";
import type { ProjectChunksResult } from "./project-chunks";
import { PartEmitter } from "./part-emitter";
import { projectRun } from "./project-run";
import { recordPoison } from "./projector-metrics";
import { readProjectorRunLog } from "./projector-run-log";
export { PROJECTOR_QUEUE } from "@/dispatch-queue/queue-names";
import { PROJECTOR_QUEUE } from "@/dispatch-queue/queue-names";

/**
 * Single partitioned queue for projector runs, partitioned by orgId — mirrors
 * `AUTOMATIONS_QUEUE`/`THREAD_GATE_QUEUE` (see apps/mesh/src/api/app.ts
 * `initDbos`). Per-partition concurrency gives each org its own fairness cap (a
 * saturated org blocks only its own partition), while a single queue means one
 * dequeue-polling loop per replica instead of one per org — and DBOS only polls
 * partitions with ENQUEUED work, so idle poll cost is flat regardless of org
 * count. Registered once at boot in `initDbos`; do NOT register per-org queues.
 */
export const PROJECTOR_PARTITION_CONCURRENCY = 10;

export function projectorWorkflowId(runId: string, fenceToken: string): string {
  return `decopilot-project:${runId}:${fenceToken}`;
}

export function shouldSkipProjection(input: {
  status: string;
  runFenceToken: string | null;
  fenceToken: string;
}): boolean {
  if (input.status === "completed" || input.status === "failed") return true;
  return (
    input.runFenceToken !== null && input.runFenceToken !== input.fenceToken
  );
}

export interface ProjectorWorkflowInput {
  runId: string;
  fenceToken: string;
  finalSeq: number;
}

export interface ProjectorRunRow {
  orgId: string;
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
  markRunFailed(
    runId: string,
    orgId: string,
    reason: string,
    kind: "harness" | "transport" | "projection",
  ): Promise<unknown>;
  persistTitle(runId: string, orgId: string, title: string): Promise<unknown>;
  purgeRun(runId: string, fenceToken: string): Promise<void>;
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

async function persistenceFor(
  runId: string,
  orgId: string,
  messageParts: SqlThreadMessagePartStorage,
): Promise<HarnessStreamPersistence> {
  // Base the projected message's `created_at` on what is already persisted so
  // it sorts after its own user message (and prior turns) regardless of how far
  // behind wall-clock this durable projection runs. `+1` keeps the assistant's
  // first part strictly after the newest existing part. In the common case the
  // live path already wrote these rows (ON CONFLICT keeps their earlier
  // created_at); this base only governs the projector-only fallback.
  const maxExistingMs = await messageParts.maxCreatedAtMsForRun(runId);
  const emitter = new PartEmitter({
    storage: messageParts,
    orgId,
    threadId: runId,
    runId,
    baseTimeMs: maxExistingMs !== null ? maxExistingMs + 1 : undefined,
  });
  return {
    emitStepParts: (message) => emitter.emitStepParts(message),
    emitFinal: (message) => emitter.emitFinal(message),
    emitError: (messageId, errorText) =>
      emitter.emitError(messageId, errorText),
  };
}

async function resolveRunStep(input: ProjectorWorkflowInput) {
  const rt = requireRuntime();
  const row = await rt.resolveRun(input.runId);
  if (!row) return { skip: "missing" as const };
  if (
    shouldSkipProjection({
      status: row.status,
      runFenceToken: row.runFenceToken,
      fenceToken: input.fenceToken,
    })
  ) {
    return { skip: "stale-or-terminal" as const, row };
  }
  if (row.version !== 2) return { skip: "legacy-v1" as const, row };
  return { row };
}

async function projectFromJetStreamStep(
  input: ProjectorWorkflowInput,
  orgId: string,
  currentThreadTitle: string | null,
) {
  const rt = requireRuntime();
  const js = rt.getJetStream();
  if (!js) throw new Error("JetStream unavailable");
  const reconstructed = await readProjectorRunLog({
    js,
    runId: input.runId,
    fenceToken: input.fenceToken,
    finalSeq: input.finalSeq,
  });
  if (!reconstructed.ok) {
    throw new Error(`projector log incomplete: ${reconstructed.error}`);
  }
  const result = await projectRun({
    runId: input.runId,
    chunks: reconstructed.chunks,
    persistence: await persistenceFor(input.runId, orgId, rt.messageParts),
    onDlq: async (_runId, error) => {
      throw error instanceof Error ? error : new Error(String(error));
    },
    title: {
      threadId: input.runId,
      // The thread's REAL current title gates the auto-title persist — a
      // user-renamed thread (non-default title) is never overwritten.
      currentThreadTitle,
      persistTitle: async (_threadId, title) => {
        await rt.persistTitle(input.runId, orgId, title);
      },
    },
  });
  if (!result.ok) {
    throw new Error(`projector failed after ${result.attempts} attempts`);
  }
  return {
    chunkCount: reconstructed.chunkCount,
    attempts: result.attempts,
    outcome: result.outcome,
  };
}

async function completeRunStep(runId: string, orgId: string) {
  await requireRuntime().completeRunIfNotCompleted(runId, orgId);
}

async function failRunStep(
  runId: string,
  orgId: string,
  error: string,
  kind: "harness" | "transport" | "projection" = "projection",
) {
  // This step runs only when projection threw after exhausting the workflow's
  // upstream retries (projectRun's onDlq re-throws to here): the durable
  // equivalent of the old accumulator's DLQ/poison path. Increment the
  // poison-runs counter so the `decopilot.projector.poison_runs` alerting
  // signal survives the move from the accumulator to the workflow.
  recordPoison(runId, orgId);
  await requireRuntime().markRunFailed(runId, orgId, error, kind);
}

async function cleanupRunStep(runId: string, fenceToken: string) {
  await requireRuntime().purgeRun(runId, fenceToken);
}

/**
 * Core workflow logic extracted for testability. Accepts an explicit runtime
 * and a `projectFn` (production: `projectFromJetStreamStep`; tests: a stub)
 * so the branching logic can be exercised without DBOS or JetStream.
 *
 * The caller (projectRunWorkflowFn) wraps each sub-call in `DBOS.runStep`.
 * This function calls them directly — safe for tests, correct for production
 * because the DBOS wrapper is applied around the whole function body.
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
  const currentThreadTitle = resolved.row.title;
  try {
    const { outcome } = await projectFn(input, orgId, currentThreadTitle);
    if (outcome?.failed) {
      // The run ended with an in-band harness error chunk: mark it failed
      // (not completed). This is a SUCCESSFUL projection of a FAILED run —
      // do NOT re-throw; the workflow itself succeeded.
      const reason = outcome.finishReason
        ? `harness reported an error: ${outcome.finishReason}`
        : "harness reported an error";
      recordPoison(input.runId, orgId);
      await rt.markRunFailed(input.runId, orgId, reason, "harness");
    } else {
      await rt.completeRunIfNotCompleted(input.runId, orgId);
    }
    // Purge JetStream subject on BOTH terminal outcomes (completed + harness-failed).
    // The run is terminal — no re-projection is expected — so purging is safe.
    await rt.purgeRun(input.runId, input.fenceToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordPoison(input.runId, orgId);
    await rt.markRunFailed(input.runId, orgId, message, "projection");
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
    return { skip: "stale-or-terminal" as const, row };
  }
  if (row.version !== 2) return { skip: "legacy-v1" as const, row };
  return { row };
}

async function projectRunWorkflowFn(
  input: ProjectorWorkflowInput,
): Promise<void> {
  const resolved = await DBOS.runStep(() => resolveRunStep(input), {
    name: "resolveProjectorRun",
  });
  if ("skip" in resolved) return;
  const orgId = resolved.row.orgId;
  const currentThreadTitle = resolved.row.title;
  try {
    const { outcome } = await DBOS.runStep(
      () => projectFromJetStreamStep(input, orgId, currentThreadTitle),
      { name: "projectRunFromJetStream" },
    );
    if (outcome?.failed) {
      const reason = outcome.finishReason
        ? `harness reported an error: ${outcome.finishReason}`
        : "harness reported an error";
      await DBOS.runStep(
        () => failRunStep(input.runId, orgId, reason, "harness"),
        { name: "failProjectedRun" },
      );
    } else {
      await DBOS.runStep(() => completeRunStep(input.runId, orgId), {
        name: "completeProjectedRun",
      });
    }
    await DBOS.runStep(() => cleanupRunStep(input.runId, input.fenceToken), {
      name: "cleanupProjectedRun",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await DBOS.runStep(() => failRunStep(input.runId, orgId, message), {
      name: "failProjectedRun",
    });
    throw error;
  }
}

const projectRunWorkflow = DBOS.registerWorkflow(projectRunWorkflowFn, {
  name: "projectRunWorkflow",
});

export async function enqueueProjectRun(
  input: ProjectorWorkflowInput & { orgId: string },
): Promise<{ workflowID: string }> {
  const handle = await DBOS.startWorkflow(projectRunWorkflow, {
    workflowID: projectorWorkflowId(input.runId, input.fenceToken),
    queueName: PROJECTOR_QUEUE,
    enqueueOptions: { queuePartitionKey: input.orgId },
  })({
    runId: input.runId,
    fenceToken: input.fenceToken,
    finalSeq: input.finalSeq,
  });
  return { workflowID: handle.workflowID };
}
