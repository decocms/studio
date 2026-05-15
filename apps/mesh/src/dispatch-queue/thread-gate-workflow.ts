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

export const THREAD_GATE_QUEUE = "thread-gate";

/**
 * Per-thread concurrent run cap (partition cap on the gate queue).
 * Holding the slot until `dispatchRunAndWait` returns serializes messages
 * on the same thread.
 */
export const THREAD_GATE_PARTITION_CONCURRENCY = 1;

const DEFAULT_RUN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Serializable subset of `DispatchRunInput`. The abort signal is the only
 * non-serializable field; the workflow step constructs its own from a
 * timeout.
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
  /** Optional per-call timeout override (otherwise uses runtime default). */
  timeoutMs?: number;
}

export type ThreadGateOutcome =
  | { taskId: string }
  | { taskId: string; error: string };

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
    "runRegistry" | "cancelBroadcast" | "streamBuffer"
  >;
  /** Default per-run timeout; overridable per-enqueue via `ThreadGateContext.timeoutMs`. */
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

async function dispatchRunAndWaitStep(
  ctx: ThreadGateContext,
): Promise<{ error?: string }> {
  const rt = requireRuntime();
  const { request } = ctx;

  const meshCtx = await rt.meshContextFactory(
    request.organizationId,
    request.userId,
  );
  if (!meshCtx) {
    return { error: "user membership lost mid-dispatch" };
  }

  const timeoutMs = ctx.timeoutMs ?? rt.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    await rt.dispatchRunFn(
      { ...request, abortSignal: abortController.signal },
      meshCtx,
      rt.deps,
    );
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

async function threadGateWorkflowFn(
  ctx: ThreadGateContext,
): Promise<ThreadGateOutcome> {
  const result = await DBOS.runStep(() => dispatchRunAndWaitStep(ctx), {
    name: "dispatchRunAndWait",
  });
  const taskId = ctx.request.taskId ?? ctx.threadId;
  if (result.error) return { taskId, error: result.error };
  return { taskId };
}

export const threadGateWorkflow = DBOS.registerWorkflow(threadGateWorkflowFn, {
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
