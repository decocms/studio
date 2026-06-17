import { DBOS } from "@dbos-inc/dbos-sdk";
import type { JetStreamClient, JetStreamManager } from "nats";
import type { SqlThreadMessagePartStorage } from "@/storage/thread-message-parts";
import type { HarnessStreamPersistence } from "./consume-harness-stream";
import { PartEmitter } from "./part-emitter";
import { projectRun } from "./project-run";
import { recordPoison } from "./projector-metrics";
import { readProjectorRunLog } from "./projector-run-log";

/**
 * Single partitioned queue for projector runs, partitioned by orgId — mirrors
 * `AUTOMATIONS_QUEUE`/`THREAD_GATE_QUEUE` (see apps/mesh/src/api/app.ts
 * `initDbos`). Per-partition concurrency gives each org its own fairness cap (a
 * saturated org blocks only its own partition), while a single queue means one
 * dequeue-polling loop per replica instead of one per org — and DBOS only polls
 * partitions with ENQUEUED work, so idle poll cost is flat regardless of org
 * count. Registered once at boot in `initDbos`; do NOT register per-org queues.
 */
export const PROJECTOR_QUEUE = "decopilot-projector";
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
  markRunFailed(runId: string, orgId: string, error: string): Promise<unknown>;
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

function persistenceFor(
  runId: string,
  orgId: string,
  messageParts: SqlThreadMessagePartStorage,
): HarnessStreamPersistence {
  const emitter = new PartEmitter({
    storage: messageParts,
    orgId,
    threadId: runId,
    runId,
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
    persistence: persistenceFor(input.runId, orgId, rt.messageParts),
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
  return { chunkCount: reconstructed.chunkCount, attempts: result.attempts };
}

async function completeRunStep(runId: string, orgId: string) {
  await requireRuntime().completeRunIfNotCompleted(runId, orgId);
}

async function failRunStep(runId: string, orgId: string, error: string) {
  // This step runs only when projection threw after exhausting the workflow's
  // upstream retries (projectRun's onDlq re-throws to here): the durable
  // equivalent of the old accumulator's DLQ/poison path. Increment the
  // poison-runs counter so the `decopilot.projector.poison_runs` alerting
  // signal survives the move from the accumulator to the workflow.
  recordPoison(runId, orgId);
  await requireRuntime().markRunFailed(runId, orgId, error);
}

async function cleanupRunStep(runId: string, fenceToken: string) {
  await requireRuntime().purgeRun(runId, fenceToken);
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
    await DBOS.runStep(
      () => projectFromJetStreamStep(input, orgId, currentThreadTitle),
      { name: "projectRunFromJetStream" },
    );
    await DBOS.runStep(() => completeRunStep(input.runId, orgId), {
      name: "completeProjectedRun",
    });
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
