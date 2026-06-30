import {
  getProjectorWorkflowRuntime,
  projectFromJetStreamStep,
  runProjectorWorkflowBody,
} from "./projector-workflow";

/** Statuses on which the consume step's entry guard returns — consume is the
 *  sole writer of these, so a terminal status means projection already finished. */
export function isTerminalStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "requires_action"
  );
}

export interface ConsumeRunProjectionOptions {
  runId: string;
  fenceToken?: string;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Per-run consume step (DBOS step body). This is the durable projector step:
 * it resolves the active fence, opens the run's JetStream subject from seq 1
 * inside `projectFromJetStreamStep`, streams those chunks through the AI SDK
 * fold, persists step/final parts, and writes the terminal status.
 */
export async function consumeRunProjection(
  opts: ConsumeRunProjectionOptions,
): Promise<void> {
  const { runId } = opts;
  const rt = getProjectorWorkflowRuntime();

  const row = await rt.resolveRun(runId);
  const fenceToken = opts.fenceToken ?? row?.runFenceToken;
  if (!row || row.version !== 2 || fenceToken == null) return;
  if (isTerminalStatus(row.status)) return; // recovery: we already finished this run

  const js = rt.getJetStream();
  if (!js) throw new Error("JetStream unavailable for consume step");

  await runProjectorWorkflowBody(
    { runId, fenceToken },
    rt,
    projectFromJetStreamStep,
  );
}
