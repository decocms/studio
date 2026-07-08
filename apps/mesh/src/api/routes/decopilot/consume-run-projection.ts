import {
  getProjectorWorkflowRuntime,
  projectFromJetStreamStep,
  runProjectorWorkflowBody,
  shouldSkipProjection,
} from "./projector-workflow";

export interface ConsumeRunProjectionOptions {
  runId: string;
  fenceToken?: string;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  /** The turn's request message id — forwarded to the projector so the
   *  assistant base anchors right after this message (queue ordering). */
  messageId?: string;
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
  // Skip ONLY when a newer fence has superseded this attempt — the same
  // per-fence check the projector body uses. A terminal status is NOT a skip
  // signal: `runId === threadId`, so the thread's status is shared across turns,
  // and a hosted onFinish (or a prior turn) can leave it terminal while THIS
  // fence's `{done}` is still unprojected. Gating on thread status here stranded
  // such turns ("No response was generated") and leaked the done sentinel; the
  // live-fence check projects the run while it still needs it and skips only
  // genuinely-stale attempts. (Recovery is handled by DBOS step memoization —
  // a completed consume step is not re-run.)
  if (
    shouldSkipProjection({
      status: row.status,
      runFenceToken: row.runFenceToken,
      fenceToken,
    })
  ) {
    return;
  }

  const js = rt.getJetStream();
  if (!js) throw new Error("JetStream unavailable for consume step");

  await runProjectorWorkflowBody(
    { runId, fenceToken, messageId: opts.messageId },
    rt,
    projectFromJetStreamStep,
  );
}
