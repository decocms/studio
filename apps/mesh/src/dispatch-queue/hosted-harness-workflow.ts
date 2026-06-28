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
 * Runtime dependencies (the dispatch fn, the studio-context factory, the
 * dispatch deps) are looked up via a module-level registry, mirroring
 * `thread-gate-workflow.ts`. App boot wires them via `setHostedHarnessRuntime`
 * BEFORE `DBOS.launch()`. The workflow is registered at import time so the
 * recovery executor can replay it after a crash.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type {
  DispatchRunDeps,
  DispatchRunInput,
} from "@/api/routes/decopilot/dispatch-run";
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
export type SerializableDispatchRunInput = Omit<
  DispatchRunInput,
  "abortSignal"
>;

export type DispatchRunAndWaitFn = (
  input: DispatchRunInput,
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
  /**
   * Optional per-run timeout (ms). When set, the run aborts after this
   * duration. Automations pass an explicit value; user messages leave it unset
   * (tool-using agent loops routinely outlast any fixed cap). Falls back to the
   * runtime's `runTimeoutMs` when omitted.
   */
  timeoutMs?: number;
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
  /**
   * Default per-run timeout (ms). Overridable per-call via
   * `HostedHarnessInput.timeoutMs`. When neither is set, no abort timer is
   * installed.
   */
  runTimeoutMs?: number;
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

  // Abort timer is opt-in. Automations supply a cap so a runaway cron can't
  // pin a thread slot forever; user messages leave it unset because tool-using
  // agent loops (Claude Code, deep research, multi-step assistants) routinely
  // outlast any fixed cap, and were not bounded by the legacy fire-and-forget
  // HTTP path.
  const timeoutMs = input.timeoutMs ?? rt.runTimeoutMs;
  const abortController = new AbortController();
  const timeoutHandle =
    timeoutMs != null
      ? setTimeout(() => abortController.abort(), timeoutMs)
      : null;

  try {
    await rt.dispatchRunFn(
      { ...request, abortSignal: abortController.signal },
      meshCtx,
      rt.deps,
    );
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }
}

async function hostedHarnessWorkflowFn(
  input: HostedHarnessInput,
): Promise<void> {
  // ONE step: run the agent loop to completion, streaming to NATS + publishing
  // {done}. Retriable — hosted/in-process runs have no external daemon to race,
  // so DBOS can recover them (the queue's concurrency=1 per threadId still
  // guarantees a single in-flight hosted run per thread).
  await DBOS.runStep(() => runHostedHarness(input), {
    name: "runHostedHarness",
    retriesAllowed: true,
  });
}

// ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
// step, or change a step's recorded I/O) requires bumping DBOS_WORKFLOW_VERSION
// — see apps/mesh/src/dbos/workflow-version.ts.
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
 * Fire-and-forget: returns the workflowID without awaiting completion.
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
