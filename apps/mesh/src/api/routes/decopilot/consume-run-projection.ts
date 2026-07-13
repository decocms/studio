import {
  getProjectorWorkflowRuntime,
  projectFromJetStreamStep,
  runProjectorWorkflowBody,
  shouldSkipProjection,
} from "./projector-workflow";
import { RUN_IDLE_TIMEOUT_MS } from "./run-registry";

export interface ConsumeRunProjectionOptions {
  runId: string;
  fenceToken?: string;
  /** Idle window enforced on the live subject tail — a silent subject (no
   *  events of any kind) for this long ends the consume with a synthesized
   *  liveness terminal instead of hanging. Defaults to `RUN_IDLE_TIMEOUT_MS`
   *  (the SAME constant the progress-based reaper reads — see run-registry.ts)
   *  so both enforcement points agree on one window; override only for tests
   *  that need a shortened, deterministic timeout. unified-control-plane T4. */
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
 *
 * unified-control-plane T3: for the hosted topology, the thread gate now
 * calls this step immediately after STARTING (not awaiting) the hosted child
 * — so this consumer is routinely opened BEFORE the child has published its
 * first chunk. This is safe and not new: it is exactly the timing the
 * desktop topology has always used (the gate returns as soon as the work item
 * is durably published to the tunnel, well before the remote daemon streams
 * anything back). `projectFromJetStreamStep` → `createProjectorChunkStream`
 * opens the JetStream consumer with `deliver_policy: DeliverPolicy.All`
 * (`projector-chunk-stream.ts`) — "deliver everything retained on the
 * subject, then keep delivering as new messages arrive" — and
 * `natsChunkSource`'s pull loop (`nats-chunk-source.ts`) simply `await`s the
 * next message when nothing is available yet, live-tailing rather than
 * assuming a complete/retained stream. There is no hosted-only branch
 * anywhere in this path that assumed the producer had already finished; both
 * topologies always went through the same `createProjectorChunkStream` call.
 *
 * unified-control-plane T4: with no child await anywhere (T3), subject
 * silence is the only signal an executor died before/without publishing.
 * `idleTimeoutMs` (defaulted here to `RUN_IDLE_TIMEOUT_MS`) is threaded all
 * the way to `natsChunkSource`, which errors the stream with
 * `StreamIdleTimeoutError` after that much silence. `runProjectorWorkflowBody`'s
 * catch tells that apart from a genuine projection error and records a
 * `markRunFailed(kind: "liveness")` terminal instead of `"projection"`. The
 * progress-based reaper (`run-registry.ts`) stays as an out-of-process
 * backstop for the same window — both read `RUN_IDLE_TIMEOUT_MS`.
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
    {
      runId,
      fenceToken,
      messageId: opts.messageId,
      idleTimeoutMs: opts.idleTimeoutMs ?? RUN_IDLE_TIMEOUT_MS,
    },
    rt,
    projectFromJetStreamStep,
  );
}
